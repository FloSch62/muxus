#!/usr/bin/env bash

set -euo pipefail
umask 077

for command_name in git gh gpg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

repo_root=$(git rev-parse --show-toplevel)
repo_slug=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
key_root="${XDG_DATA_HOME:-$HOME/.local/share}/muxus/release-signing"
key_home="$key_root/gnupg"
public_key="$repo_root/.github/release-keys/linux-signing-key.asc"
key_uid="Muxus Linux Release Signing"
environment_name="linux-release-signing"
secret_export=$(mktemp)
public_key_tmp=$(mktemp)
signing_passphrase=""

cleanup() {
  signing_passphrase=""
  if command -v shred >/dev/null 2>&1; then
    shred -u -- "$secret_export" "$public_key_tmp" 2>/dev/null || true
  else
    rm -f -- "$secret_export" "$public_key_tmp"
  fi
}
trap cleanup EXIT

printf 'This creates the Muxus Linux release key and uploads only its signing subkey\n'
printf 'to the %s GitHub environment. The offline primary key remains at:\n%s\n\n' \
  "$environment_name" \
  "$key_home"

read -r -s -p "Choose a strong passphrase for the offline key: " signing_passphrase
printf '\n'
read -r -s -p "Repeat the passphrase: " signing_passphrase_confirmation
printf '\n'

if [ "$signing_passphrase" != "$signing_passphrase_confirmation" ]; then
  echo "Passphrases do not match" >&2
  exit 1
fi
signing_passphrase_confirmation=""

if [ "${#signing_passphrase}" -lt 16 ]; then
  echo "Use a passphrase containing at least 16 characters" >&2
  exit 1
fi

install -d -m 0700 "$key_home"
export GNUPGHOME="$key_home"

mapfile -t existing_fingerprints < <(
  gpg --batch --with-colons --list-secret-keys "$key_uid" 2>/dev/null |
    awk -F: '
      $1 == "sec" { want_fingerprint = 1; next }
      want_fingerprint && $1 == "fpr" { print $10; want_fingerprint = 0 }
    '
)

if [ "${#existing_fingerprints[@]}" -eq 0 ]; then
  printf '%s\n' "$signing_passphrase" |
    gpg \
      --batch \
      --pinentry-mode loopback \
      --passphrase-fd 0 \
      --quick-generate-key \
      "$key_uid" \
      ed25519 \
      cert \
      0
elif [ "${#existing_fingerprints[@]}" -gt 1 ]; then
  echo "More than one key exists for '$key_uid' in $key_home" >&2
  echo "Resolve the duplicate keys before running setup again" >&2
  exit 1
fi

primary_fingerprint=$(
  gpg --batch --with-colons --list-secret-keys "$key_uid" |
    awk -F: '$1 == "fpr" { print $10; exit }'
)

current_epoch=$(date +%s)
signing_subkey=$(
  gpg --batch --with-colons --list-secret-keys "$primary_fingerprint" |
    awk -F: -v now="$current_epoch" '
      $1 == "ssb" && index($12, "s") > 0 && ($7 == "" || $7 > now) {
        want_fingerprint = 1
        next
      }
      want_fingerprint && $1 == "fpr" { print $10; exit }
    '
)

if [ -z "$signing_subkey" ]; then
  printf '%s\n' "$signing_passphrase" |
    gpg \
      --batch \
      --pinentry-mode loopback \
      --passphrase-fd 0 \
      --quick-add-key \
      "$primary_fingerprint" \
      ed25519 \
      sign \
      2y
fi

gpg --batch --armor --export "$primary_fingerprint" > "$public_key_tmp"
install -d -m 0755 "$(dirname "$public_key")"
install -m 0644 "$public_key_tmp" "$public_key"

printf '%s\n' "$signing_passphrase" |
  gpg \
    --batch \
    --pinentry-mode loopback \
    --passphrase-fd 0 \
    --armor \
    --export-secret-subkeys \
    "$primary_fingerprint" > "$secret_export"

gh api \
  --method PUT \
  "repos/$repo_slug/environments/$environment_name" \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true' \
  >/dev/null

policy_endpoint="repos/$repo_slug/environments/$environment_name/deployment-branch-policies"
for policy in "branch:main" "tag:v*"; do
  policy_type=${policy%%:*}
  policy_name=${policy#*:}
  existing_policy=$(
    gh api "$policy_endpoint" --paginate --jq \
      ".branch_policies[] | select(.name == \"$policy_name\" and .type == \"$policy_type\") | .id"
  )
  if [ -z "$existing_policy" ]; then
    gh api \
      --method POST \
      "$policy_endpoint" \
      -f name="$policy_name" \
      -f type="$policy_type" \
      >/dev/null
  fi
done

gh secret set \
  LINUX_SIGNING_PRIVATE_KEY \
  --repo "$repo_slug" \
  --env "$environment_name" \
  < "$secret_export"
printf '%s' "$signing_passphrase" |
  gh secret set \
    LINUX_SIGNING_KEY_PASSPHRASE \
    --repo "$repo_slug" \
    --env "$environment_name"

printf '\nLinux release signing is configured.\n'
printf 'Primary fingerprint: %s\n' "$primary_fingerprint"
printf 'Public key: %s\n' "$public_key"
printf 'Offline key home: %s\n\n' "$key_home"
printf 'Back up the offline key home and its openpgp-revocs.d directory securely.\n'
printf 'Commit only the public key. Never commit anything from the offline key home.\n'
