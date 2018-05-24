#!/usr/bin/env node
const { exit, env } = require('process')
const { lookup } = require('dns')
const { promisify } = require('util')
const { parse } = require('url')
const { join } = require('path')
const { existsSync, mkdirSync } = require('fs')
const { execSync } = require('child_process')
const { writeFileSync, readFileSync, readdirSync, statSync } = require('fs')
const fetch = require('node-fetch')
const lookupAsync = promisify(lookup)
const argv = require('minimist')(process.argv.slice(2))

const notHiddenFile = (filePath) => !(/(^|\/)\.[^/.]/).test(filePath)

const getDefaultDirName = (endpoint) => {
  const slash = endpoint.lastIndexOf('/')
  const afterSlash = endpoint.substring(slash + 1)
  const period = afterSlash.lastIndexOf('.')
  return afterSlash.substring(0, period)
}

const listFiles = (repoDir) => {
  try {
    let filesToReturn = []
    const walkDir = (currentPath) => {
      let files
      try {
        files = readdirSync(currentPath)
      } catch (err) {
        return { err }
      }
      for (let i in files) {
        let curFile = join(currentPath, files[i])
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

const validateNetwork = async ({ endpoint }) => {
  try {
    console.log(`Checking network access and resolution to ==> '${endpoint}'`)
    const url = parse(endpoint)
    const data = await lookupAsync(url.hostname)
    console.log(`Network connectivity successful for ==> '${endpoint}'`)
    return { data }
  } catch (err) {
    console.log(`Unable to access ==> '${endpoint}'`)
    return { err }
  }
}

const createArchive = async ({ format, repoUrl, repoBranch }) => {
  try {
    if (!format) {
      return { err: new Error('format is required') }
    }
    const repoName = getDefaultDirName(repoUrl)
    execSync(`(cd /tmp/imgpress/repo;git archive --format ${format} ${repoBranch}> /tmp/imgpress/${repoName}.${format})`)
    return { data: 'success' }
  } catch (err) {
    return { err }
  }
}

const pushToS3 = async ({ repoUrl, imgPressAuthToken }) => {
  try {
    let pushEndpoint = 'https://tow7iwnbqb.execute-api.us-east-1.amazonaws.com/dev/repo/upload'
    if (env.IMGPRESS_ENV === 'production') pushEndpoint = 'https://api.imgpress.io/repo/upload'
    const repoName = getDefaultDirName(repoUrl)
    const tarArchive = Buffer.from(readFileSync(`/tmp/imgpress/${repoName}.tar.gz`)).toString('base64')
    const zipArchive = Buffer.from(readFileSync(`/tmp/imgpress/${repoName}.zip`)).toString('base64')
    const res = await fetch(pushEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        zipArchive: zipArchive,
        tarArchive: tarArchive
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': imgPressAuthToken
      }
    })
    await res.json()
    return { data: 'S3 upload successful' }

  } catch (err) {
    return { err }
  }
}

const cloneRepo = async ({ repoUrl, username, secret }) => {
  try {
    username = encodeURIComponent(username)
    let gitCmd = 'git clone'
    const sshAdd = 'ssh-add /tmp/imgpress/.ssh/id_rsa'
    const sshRm = 'ssh-add -D'
    const clonePath = '/tmp/imgpress/repo'
    const url = parse(repoUrl)
    const protocol = url.protocol ? url.protocol : 'ssh:'
    console.log(`Attempting to clone ${repoUrl}`)
    switch (protocol) {
      case 'http:':
      case 'https:':
        console.log(`HTTP/S protocol detected for ${repoUrl}`)
        if (secret) {
          // probably a private repo, so setup the uri accordingly
          secret = encodeURIComponent(secret)
          repoUrl = repoUrl.replace('https://', `https://${username}:${secret}@`)
        }
        break
      case 'ssh:':
        console.log(`SSH protocol detected for ${repoUrl}`)
        const privateKey = Buffer.from(secret, 'base64').toString('ascii')
        execSync(`rm /tmp/imgpress/.ssh/id_rsa || true`)
        writeFileSync('/tmp/imgpress/.ssh/id_rsa', privateKey, {mode: 0o400})
        execSync(`openssl rsa -in /tmp/imgpress/.ssh/id_rsa -check`) // validate private key
        execSync(sshRm)
        execSync(sshAdd)
        break
      default:
        return { err: new Error(`Unsupported Protocol '${protocol}' Detected. Failing...`) }
    }
    console.log(`Cloning ${repoUrl}`)
    execSync(`${gitCmd} ${repoUrl} ${clonePath}`, { encoding: 'utf8' })
    return { data: 'success' }
  } catch (err) {
    return { err }
  }
}

const phoneHome = async ({fileList, imgPressAuthToken, failMsg, repoUrl}) => {
  try {
    console.log('Calling back to imgpress service...')
    const repoName = getDefaultDirName(repoUrl)
    let endpoint = 'https://tow7iwnbqb.execute-api.us-east-1.amazonaws.com/dev/repo/status'
    if (env.IMGPRESS_ENV === 'production') endpoint = 'https://api.imgpress.io/repo/status'
    if (!failMsg) {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          fileList: fileList,
          success: true,
          repoName: repoName
        }),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': imgPressAuthToken
        }
      })
      console.log(res)
      console.log(res.ok)
      const result = await res.json()

      if (!res.ok) {
        console.log(result)
        await phoneHome({ failMsg: result.message, imgPressAuthToken, repoUrl })
      }
      return { data: result }

    } else {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          errorMsg: failMsg,
          success: false,
          repoName: repoName
        }),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': imgPressAuthToken
        }
      })
      console.log(res)
      console.log(res.ok)
      const result = await res.json()
      if (!res.ok) {
        console.error('Error in reporting failure to imgpress')
        console.log(result)
        return { error: result.message }
      }
      return { data: result }
    }
    return { data: 'success' }
  } catch (err) {
    return { err }
  }

}

const main = async () => {
  const repoBranch = argv.branch || 'HEAD'
  const repoUrl = argv.url
  const secret = argv.secret
  const username = argv.username
  const imgPressAuthToken = argv.token
  if (!repoUrl || !imgPressAuthToken) {
    console.error('Missing arguments')
    exit(1)
  }
  try {
    if (!existsSync('/tmp/imgpress')) mkdirSync('/tmp/imgpress')
    if (!existsSync('/tmp/imgpress/.ssh')) mkdirSync('/tmp/imgpress/.ssh')

    const { err: errNetwork } = await validateNetwork({ endpoint: repoUrl })
    if (errNetwork) {
      console.error(errNetwork.message)
      exit(1)
    }

    const { err: errClone } = await cloneRepo({ repoUrl, username, secret })
    if (errClone) {
      console.error(errClone.message)
      exit(1)
    }

    const { err: errFiles, data: fileList } = listFiles('/tmp/imgpress/repo')
    if (errFiles) {
      console.error(errFiles.message)
      exit(1)
    }

    const { err: errTar } = await createArchive({ format: 'tar.gz', repoUrl, repoBranch })
    if (errTar) {
      console.error(errTar.message)
      exit(1)
    }

    const { err: errZip } = await createArchive({ format: 'zip', repoUrl, repoBranch })
    if (errZip) {
      console.error(errZip.message)
      exit(1)
    }

    const { err: errPush } = await pushToS3({repoUrl, imgPressAuthToken})
    if (errPush) {
      console.error(errPush.message)
      exit(1)
    }

    const { err: errPhone } = await phoneHome({ fileList, imgPressAuthToken, repoUrl })
    if (errPhone) {
      console.error(errPhone)
    }
    exit(0)
  } catch (err) {
    console.log('main err')
    console.error(err)
    const { err: errPhone } = await phoneHome({ failMsg: err.message, imgPressAuthToken, repoUrl })
    if (errPhone) {
      console.error(errPhone)
    }
    exit(1)
  }
}

main()
