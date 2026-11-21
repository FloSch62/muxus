# The OpenSSH server Muxus is tested against: `pnpm test:openssh`.
#
# Users, each with the password `<name>-pass`:
#   alice        password, public key, certificate; everything allowed
#   kbd          keyboard-interactive only
#   twostep      public key, then password
#   nofwd        no TCP forwarding
#   twosessions  two sessions per connection
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server openssh-client openssl python3 curl netcat-openbsd xauth \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd
COPY sshd.conf /etc/ssh/sshd_config.d/00-muxus.conf
COPY entrypoint.sh x11-client.py /opt/muxus/
RUN chmod +x /opt/muxus/entrypoint.sh \
 && for user in alice kbd twostep nofwd twosessions; do \
      useradd -m -s /bin/bash "$user" && echo "$user:$user-pass" | chpasswd; \
    done \
 && mkdir -p /srv/www && echo 'muxus-openssh-web-ok' > /srv/www/index.html
EXPOSE 22
ENTRYPOINT ["/opt/muxus/entrypoint.sh"]
