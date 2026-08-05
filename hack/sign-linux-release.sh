#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <artifact-directory> <output-directory> <public-key-file>" >&2
  exit 2
fi

: "${LINUX_SIGNING_KEY_PASSPHRASE:?LINUX_SIGNING_KEY_PASSPHRASE must be set}"

artifact_dir=$(realpath "$1")
mkdir -p "$2"
output_dir=$(realpath "$2")
public_key_file=$(realpath "$3")

if [ ! -f "$public_key_file" ]; then
  echo "Linux release public key not found: $public_key_file" >&2
  exit 1
fi

shopt -s nullglob
appimages=("$artifact_dir"/*.AppImage)
debs=("$artifact_dir"/*.deb)
shopt -u nullglob

if [ "${#appimages[@]}" -eq 0 ] || [ "${#debs[@]}" -eq 0 ]; then
  echo "Expected at least one AppImage and one .deb in $artifact_dir" >&2
  exit 1
fi

artifact_names=()
for artifact in "${appimages[@]}" "${debs[@]}"; do
  name=$(basename "$artifact")
  if [[ "$name" == *$'\n'* ]]; then
    echo "Release artifact names must not contain newlines" >&2
    exit 1
  fi
  artifact_names+=("$name")
done

mapfile -t artifact_names < <(printf '%s\n' "${artifact_names[@]}" | LC_ALL=C sort)

expected_fingerprint=$(
  gpg --batch --show-keys --with-colons "$public_key_file" |
    awk -F: '$1 == "fpr" { print toupper($10); exit }'
)
if [ -z "$expected_fingerprint" ]; then
  echo "Could not read a fingerprint from $public_key_file" >&2
  exit 1
fi

secret_key_listing=$(gpg --batch --with-colons --list-secret-keys "$expected_fingerprint")
actual_fingerprint=$(
  awk -F: '$1 == "fpr" { print toupper($10); exit }' <<<"$secret_key_listing"
)
if [ "$actual_fingerprint" != "$expected_fingerprint" ]; then
  echo "Imported signing key does not match the committed Linux release key" >&2
  echo "Expected: $expected_fingerprint" >&2
  echo "Actual:   ${actual_fingerprint:-missing}" >&2
  exit 1
fi

primary_secret_status=$(
  awk -F: '$1 == "sec" { print $15; exit }' <<<"$secret_key_listing"
)
if [ "$primary_secret_status" != "#" ]; then
  echo "Refusing to sign: CI contains the offline primary private key" >&2
  echo "Export only secret subkeys with gpg --export-secret-subkeys" >&2
  exit 1
fi

if ! awk -F: '$1 == "ssb" && index($12, "s") > 0 && $15 == "+" { found = 1 } END { exit !found }' \
  <<<"$secret_key_listing"; then
  echo "No usable private signing subkey is available" >&2
  exit 1
fi

manifest="$output_dir/SHA256SUMS-linux.txt"
signature="$manifest.asc"
published_key="$output_dir/muxus-linux-signing-key.asc"
published_fingerprint="$output_dir/muxus-linux-signing-key-fingerprint.txt"
manifest_tmp="$output_dir/.SHA256SUMS-linux.txt.$$"
signature_tmp="$output_dir/.SHA256SUMS-linux.txt.asc.$$"
key_tmp="$output_dir/.muxus-linux-signing-key.asc.$$"
fingerprint_tmp="$output_dir/.muxus-linux-signing-key-fingerprint.txt.$$"

cleanup() {
  rm -f -- "$manifest_tmp" "$signature_tmp" "$key_tmp" "$fingerprint_tmp"
}
trap cleanup EXIT

(
  cd "$artifact_dir"
  for artifact_name in "${artifact_names[@]}"; do
    sha256sum -- "$artifact_name"
  done
) > "$manifest_tmp"

gpg \
  --batch \
  --yes \
  --pinentry-mode loopback \
  --passphrase-fd 3 \
  --local-user "$expected_fingerprint" \
  --armor \
  --detach-sign \
  --output "$signature_tmp" \
  "$manifest_tmp" \
  3<<<"$LINUX_SIGNING_KEY_PASSPHRASE"

install -m 0644 "$public_key_file" "$key_tmp"
printf '%s\n' "$expected_fingerprint" > "$fingerprint_tmp"

mv "$manifest_tmp" "$manifest"
mv "$signature_tmp" "$signature"
mv "$key_tmp" "$published_key"
mv "$fingerprint_tmp" "$published_fingerprint"

gpg --batch --verify "$signature" "$manifest"
(
  cd "$artifact_dir"
  sha256sum --check "$manifest"
)

echo "Signed Linux release assets with $expected_fingerprint"
