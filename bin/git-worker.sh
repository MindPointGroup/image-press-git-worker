#!/bin/bash

set -e

pacman -Sy --noconfirm zip sshpass nodejs npm git tar

touch ~/.ssh/config
cat << EOF > ~/.ssh/config 
Host *
    IdentityFile ~/.ssh/id_rsa
    IdentitiesOnly yes
EOF

