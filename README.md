imgPress Git Worker
===================

imgPress allows end users to specify repositories and scripts fron said repositories to be executed on ec2 instances as part of the image baseline creation/updating/patching process. Since it aims to support enteprise AWS users it is necessary for imgPress to be able to somehow get information from privately networked git servers.

In order to achieve this access, imgPress spins up short-lived worker nodes in the specified subnet of a user's VPC which does the following:

  1. Git clones the specified repository of the user via SSH or HTTPS as configured by said user.
  1. Generates a list of all files by their path relative to the root of the repository root directory.
  1. Creates a zip and tar archive of the repositories
  1. Calls out the the imgPress API POSTing the list of files, and the base64 encoded strings of the zip and tarball binaries.

The imgpress backend then handles displaying the list of available files to the end user and storing the zip/tarball archives in an encrypted S3 bucket which is accessible only to the end userand not publicly accessible by any means.

This project consists of 2 parts.

  1. `arch-builder.sh` which is the script used to build the image from a base arch linux image. This really just installs git and zip for now.
  1. `userData.sh` is the script used in a user's AWS environment to do the git, archiving, and POST operations.
