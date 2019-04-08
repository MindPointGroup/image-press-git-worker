#!/usr/bin/env node
const { exit, env } = require('process')
const { lookup } = require('dns')
const { promisify } = require('util')
const { parse } = require('url')
const { join } = require('path')
const { existsSync, mkdirSync } = require('fs')
const { execSync, spawnSync } = require('child_process')
const { writeFileSync, readFileSync, readdirSync, statSync } = require('fs')
const fetch = require('node-fetch')
const lookupAsync = promisify(lookup)
const argv = require('minimist')(process.argv.slice(2))

const notHiddenFile = filePath => !(/(^|\/)\.[^/.]/).test(filePath)

const listFiles = repoDir => {
  try {
    const filesToReturn = []
    const walkDir = (currentPath) => {
      let files
      try {
        files = readdirSync(currentPath)
      } catch (err) {
        return { err }
      }
      for (const i in files) {
        const curFile = join(currentPath, files[i])
        if (notHiddenFile(curFile)) {
          let isFile
          let isDir
          try {
            isFile = statSync(curFile).isFile()
            isDir = statSync(curFile).isDirectory()
          } catch (err) {
            return { err }
          }
          if (isFile) {
            filesToReturn.push(curFile.replace(repoDir, ''))
          } else if (isDir) {
            walkDir(curFile)
          }
        }
      }
    }
    walkDir(repoDir)
    return { data: filesToReturn }
  } catch (err) {
    return { err }
  }
}

const shellCmd = async ({ cmd, cwd }) => {
  try {
    const opts = {
      shell: true
    }
    if (cwd) opts.cwd = cwd

    const res = spawnSync(cmd, opts)

    if (res.status !== 0) {
      return { err: new Error(res.stderr.toString()) }
    }

    const data = {
      output: res.stdout.toString()
    }

    return { data }
  } catch (err) {
    return { err }
  }
}

const validateNetwork = async ({ endpoint }) => {
  try {
    console.log(`Checking network access and resolution to ==> '${endpoint}'`)
    const url = parse(endpoint)
    const data = await lookupAsync(url.hostname)
    console.log(`Network connectivity successful!`)
    return { data }
  } catch (err) {
    console.log(`Unable to access ==> '${endpoint}'`)
    return { err }
  }
}

const createArchive = async ({ format, repoBranch }) => {
  try {
    if (!format) {
      return { err: new Error('format is required') }
    }

    const opts = {
      cmd: `git archive --format ${format} ${repoBranch.trim()}> /tmp/imgpress/archive.${format}`,
      cwd: '/tmp/imgpress/repo'
    }

    const { err } = await shellCmd(opts)
    if (err) {
      return { err }
    }

    return { data: 'success' }
  } catch (err) {
    return { err }
  }
}

const pushToS3 = async ({ region, id, repoUrl, repoBranch, imgPressAuthToken }) => {
  try {
    console.log('Attempting to send repo archives to imgpress.io')
    let pushEndpoint = 'https://api.dev.imgpress.io/v0/repo/upload'
    if (env.IMGPRESS_ENV === 'production') pushEndpoint = 'https://api.imgpress.io/v0/repo/upload'
    const tarArchive = Buffer.from(readFileSync(`/tmp/imgpress/archive.tar.gz`)).toString('base64')
    const zipArchive = Buffer.from(readFileSync(`/tmp/imgpress/archive.zip`)).toString('base64')

    const postBody = {
      zipArchive,
      tarArchive,
      repoUrl,
      repoBranch,
      region,
      id
    }

    console.log('POSTING ', postBody)

    const res = await fetch(pushEndpoint, {
      method: 'POST',
      body: JSON.stringify(postBody),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': imgPressAuthToken
      }
    })

    if (!res.ok) {
      console.error(res)
      return { err: new Error('Upload Failure') }
    }
    return { data: 'Upload successful' }
  } catch (err) {
    return { err }
  }
}

const cloneRepo = async ({ repoUrl, repoBranch, username, secret }) => {
  try {
    let detectedBranch = false
    username = encodeURIComponent(username)
    let gitCmd = 'GIT_SSH_COMMAND="ssh -v -o StrictHostKeyChecking=no" git clone'

    const clonePath = '/tmp/imgpress/repo'
    const url = parse(repoUrl)
    const protocol = url.protocol ? url.protocol : 'ssh:'
    console.log(`Attempting to clone ${repoUrl}`)
    switch (protocol) {
      case 'http:': // hopefully no one uses http for git but it's possible so we handle it
      case 'https:':
        console.log(`HTTP/S protocol detected for ${repoUrl}`)
        if (secret) {
          // probably a private repo, so setup the uri accordingly
          secret = encodeURIComponent(secret)
          repoUrl = repoUrl.replace(`${protocol}//`, `${protocol}//${username}:${secret}@`)
        }
        break
      case 'ssh:':
        console.log(`SSH protocol detected for ${repoUrl}`)
        if (!secret) {
          return { err: new Error('No ssh key provided for ssh protocol') }
        }
        const privateKey = Buffer.from(secret, 'base64').toString('ascii')
        writeFileSync('/root/.ssh/id_rsa', privateKey, {mode: 0o400})
        const sshVerifyCmd = 'openssl rsa -in /root/.ssh/id_rsa -check'
        const { err: sshVerifyErr } = await shellCmd({ cmd: sshVerifyCmd })
        if (sshVerifyErr) {
          return { err: sshVerifyErr }
        }
        break
      default:
        return { err: new Error(`Unsupported Protocol '${protocol}' Detected. Failing...`) }
    }

    if (repoBranch) {
      gitCmd = `${gitCmd} ${repoUrl} -b ${repoBranch}`
    } else {
      gitCmd = `${gitCmd} ${repoUrl}`
    }

    console.log(`Cloning ${repoUrl}`)
    const cloneCmd = `${gitCmd} --single-branch ${clonePath}`
    const { err: cloneErr } = await shellCmd({ cmd: cloneCmd })
    if (cloneErr) {
      return { err: cloneErr }
    }

    if (!repoBranch) {
      const getBranchCmd = 'git rev-parse --abbrev-ref HEAD'
      const getBranchCwd = '/tmp/imgpress/repo'
      const { err: getBranchErr, data: getBranchData } = await shellCmd({
        cwd: getBranchCwd,
        cmd: getBranchCmd
      })

      if (getBranchErr) {
        return { err: getBranchErr }
      }

      detectedBranch = getBranchData.output
    }

    return { data:
      { repoBranch: detectedBranch || repoBranch }
    }
  } catch (err) {
    return { err }
  }
}

const phoneHome = async args => {
  try {
    const {
      fileList,
      imgPressAuthToken,
      status,
      repoUrl,
      id,
      repoBranch
    } = args

    const body = JSON.stringify({
      fileList,
      status,
      id,
      url: repoUrl,
      branch: repoBranch,
      noWorker: true
    })

    console.log('Calling back to imgpress service...')
    console.log('POST BODY')
    let endpoint = 'https://api.dev.imgpress.io/v0/repo'
    if (env.IMGPRESS_ENV === 'production') { endpoint = 'https://api.imgpress.io/v0/repo' }

    const res = await fetch(endpoint, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': imgPressAuthToken
      }
    })

    const result = await res.json()
    if (!res.ok) {
      console.error('Error in reporting failure to imgpress')
      console.log(result)
      return { err: result.message }
    }

    execSync('shutdown -h now')
    return { data: 'success' }
  } catch (err) {
    return { err }
  }
}

const main = async () => {
  let repoBranch = argv.branch || false
  const repoUrl = argv.url
  const region = argv.region
  const id = argv.id
  const secret = argv.secret || false
  const username = argv.username || false
  const imgPressAuthToken = argv.token
  if (!repoUrl || !imgPressAuthToken) {
    console.error('Missing arguments')
    throw new Error('Missing required arguments')
  }
  try {
    if (!existsSync('/tmp/imgpress')) mkdirSync('/tmp/imgpress')

    const { err: errNetwork } = await validateNetwork({ endpoint: repoUrl })
    if (errNetwork) {
      throw errNetwork
    }

    const { err: errClone, data: repoData } = await cloneRepo({ repoUrl, repoBranch, username, secret })
    if (errClone) {
      throw errClone
    }

    repoBranch = repoData.repoBranch

    const { err: errFiles, data: fileList } = listFiles('/tmp/imgpress/repo')
    if (errFiles) {
      throw errFiles
    }

    const { err: errTar } = await createArchive({ format: 'tar.gz', repoBranch })
    if (errTar) {
      throw errTar
    }

    const { err: errZip } = await createArchive({ format: 'zip', repoBranch })
    if (errZip) {
      throw errZip
    }

    const { err: errPush } = await pushToS3({ region, id, imgPressAuthToken, repoUrl, repoBranch })
    if (errPush) {
      throw errPush
    }

    const { err: errPhone } = await phoneHome({ fileList, imgPressAuthToken, status: 'available', repoUrl, id, repoBranch })
    if (errPhone) {
      throw errPhone
    }
    exit(0)
  } catch (err) {
    console.error(err)
    console.error('IMGPRESS GIT WORKER FAILURE')
    const { err: errPhone } = await phoneHome({ status: 'failed', imgPressAuthToken, repoUrl, id, repoBranch })
    if (errPhone) {
      console.error(errPhone)
      execSync('shutdown -h now')
      exit(1)
    }
  }
}

main()
