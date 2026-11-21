#!/bin/sh
# Makes the keys the tests log in with and leaves them in /fixtures for the
# test run to copy out: nothing on the developer's computer is used or changed.
set -e
mkdir -p /fixtures
cd /fixtures
ssh-keygen -q -t ed25519 -N '' -C ca -f ca
ssh-keygen -q -t ed25519 -N '' -C ed25519 -f id_ed25519
ssh-keygen -q -t rsa -b 3072 -N '' -C rsa -f id_rsa
ssh-keygen -q -t ecdsa -N 'key-passphrase' -C ecdsa-protected -f id_ecdsa_protected
ssh-keygen -q -t rsa -b 2048 -m PEM -N 'key-passphrase' -C pem-protected -f id_rsa_pem_protected
# As older openssl and many appliances write a protected key: PEM with 3DES.
openssl genrsa -traditional -des3 -passout pass:key-passphrase -out id_rsa_des3 2048 2>/dev/null
ssh-keygen -y -P key-passphrase -f id_rsa_des3 >id_rsa_des3.pub
# Certified, but not in authorized_keys: only the certificate lets these in.
ssh-keygen -q -t ed25519 -N '' -C certified -f id_certified
ssh-keygen -q -t rsa -b 3072 -N '' -C certified-rsa -f id_certified_rsa
ssh-keygen -q -s ca -I muxus-test -n alice -V +1d id_certified.pub
ssh-keygen -q -s ca -I muxus-test-rsa -n alice -V +1d id_certified_rsa.pub
cp ca.pub /etc/ssh/muxus-ca.pub
chmod 644 /fixtures/*

for user in alice twostep nofwd twosessions; do
  install -d -m 700 -o "$user" -g "$user" "/home/$user/.ssh"
  cat id_ed25519.pub id_rsa.pub id_ecdsa_protected.pub id_rsa_pem_protected.pub id_rsa_des3.pub \
    >"/home/$user/.ssh/authorized_keys"
  chown "$user:$user" "/home/$user/.ssh/authorized_keys"
  chmod 600 "/home/$user/.ssh/authorized_keys"
done

ssh-keygen -A >/dev/null
# A web page only the container itself can reach, for the forwarding tests.
(cd /srv/www && exec python3 -m http.server 8080 --bind 127.0.0.1 >/var/log/http.log 2>&1) &
touch /fixtures/ready
exec /usr/sbin/sshd -D -e
