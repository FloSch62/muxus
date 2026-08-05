#!/usr/bin/env bash

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
test_root=$(mktemp -d)
test_passphrase="muxus-linux-signing-test"

cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT

export GNUPGHOME="$test_root/source-gnupg"
install -d -m 0700 "$GNUPGHOME"

printf '%s\n' "$test_passphrase" |
  gpg \
    --batch \
    --pinentry-mode loopback \
    --passphrase-fd 0 \
    --quick-generate-key \
    "Muxus Linux Signing Test" \
    ed25519 \
    cert \
    0

primary_fingerprint=$(
  gpg --batch --with-colons --list-secret-keys "Muxus Linux Signing Test" |
    awk -F: '$1 == "fpr" { print $10; exit }'
)

printf '%s\n' "$test_passphrase" |
  gpg \
    --batch \
    --pinentry-mode loopback \
    --passphrase-fd 0 \
    --quick-add-key \
    "$primary_fingerprint" \
    ed25519 \
    sign \
    2y

gpg --batch --armor --export "$primary_fingerprint" > "$test_root/public.asc"
printf '%s\n' "$test_passphrase" |
  gpg \
    --batch \
    --pinentry-mode loopback \
    --passphrase-fd 0 \
    --armor \
    --export-secret-subkeys \
    "$primary_fingerprint" > "$test_root/signing-subkeys.asc"

export GNUPGHOME="$test_root/signer-gnupg"
install -d -m 0700 "$GNUPGHOME"
gpg --batch --import "$test_root/signing-subkeys.asc"

mkdir -p "$test_root/artifacts" "$test_root/signatures"
printf 'appimage fixture\n' > "$test_root/artifacts/muxus-test-linux-x86_64.AppImage"
printf 'deb fixture\n' > "$test_root/artifacts/muxus-test-linux-amd64.deb"

export LINUX_SIGNING_KEY_PASSPHRASE="$test_passphrase"
"$repo_root/hack/sign-linux-release.sh" \
  "$test_root/artifacts" \
  "$test_root/signatures" \
  "$test_root/public.asc"
unset LINUX_SIGNING_KEY_PASSPHRASE

export GNUPGHOME="$test_root/verifier-gnupg"
install -d -m 0700 "$GNUPGHOME"
gpg --batch --import "$test_root/signatures/muxus-linux-signing-key.asc"
gpg --batch --verify \
  "$test_root/signatures/SHA256SUMS-linux.txt.asc" \
  "$test_root/signatures/SHA256SUMS-linux.txt"
(
  cd "$test_root/artifacts"
  sha256sum --check "$test_root/signatures/SHA256SUMS-linux.txt"
)

printf 'tampered\n' >> "$test_root/artifacts/muxus-test-linux-amd64.deb"
if (
  cd "$test_root/artifacts"
  sha256sum --check "$test_root/signatures/SHA256SUMS-linux.txt" >/dev/null 2>&1
); then
  echo "Checksum verification unexpectedly accepted a modified artifact" >&2
  exit 1
fi

echo "Linux release signing test passed"
