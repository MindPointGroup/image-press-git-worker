#!/bin/bash

set -e

pacman -Sy --noconfirm zip sshpass nodejs npm git tar
npm install -g git+https://github.com/MindPointGroup/image-press-git-worker.git


