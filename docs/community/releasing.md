---
icon: lucide/package-check
---

# Signing and releases

Muxus uses the same Developer ID signing and Microsoft Store submission approach as
Kubus. macOS releases remain universal (Intel and Apple Silicon); GitHub Windows
installers remain x64 and ARM64. The separate Store package is x64, as in Kubus.
Linux keeps its existing signed checksum manifest and protected signing environment.

## Apple setup

The release configuration uses Kubus's existing Apple identity:

- Apple ID: `schwarz.flori.88@googlemail.com`
- Team: `DJY795VD98`
- Certificate: `Developer ID Application: Florian Schwarz (DJY795VD98)`
- Muxus bundle ID: `io.github.flosch62.muxus`

Reuse the valid Kubus **Developer ID Application** certificate and its private key.
This is distribution through GitHub with Apple notarization, so no Mac App Store
listing is involved. See Apple's [Developer ID guide](https://developer.apple.com/developer-id/).

In **FloSch62/muxus → Settings → Secrets and variables → Actions**, add these
repository secrets from the original signing materials (or grant this repository
access to the equivalent organization secrets):

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | Base64 of the encrypted Developer ID Application `.p12`, including the private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that P12 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password for the Apple ID above |

GitHub cannot reveal Kubus's existing secret values. Use your original P12 and
password, or export the same identity from Keychain Access on the Mac that has its
private key. Create an app-specific password at [account.apple.com](https://account.apple.com/)
if needed. Ensure the Apple Developer membership and certificate remain valid and
any pending Apple account agreements have been accepted.

If you need a new certificate because the original private key is unavailable,
`node hack/apple-signing.mjs csr` creates encrypted local key material and a CSR in
gitignored `.local/apple-signing/`. Upload the CSR when creating a
[Developer ID Application certificate](https://developer.apple.com/help/account/certificates/create-developer-id-certificates),
then run `node hack/apple-signing.mjs export /path/to/developerID_application.cer`.
`node hack/apple-signing.mjs upload` uploads the two certificate secrets to
**FloSch62/muxus**; set the Apple app-specific password separately. Keep an encrypted
backup of the identity and passwords. Reusing the existing certificate does not
require running this helper.

Run **Package installers** on the prepared branch with **sign_macos** enabled to
test credentials before a release. It signs with hardened runtime, notarizes and
staples the app, then opens the final DMG to check the Developer ID team, Gatekeeper
acceptance, ticket and both CPU architectures. Test the resulting app on a Mac,
including a local shell, SSH, serial access and saved-password keyring access.
First-time notarization may exceed the workflow's 90-minute limit; inspect the
submission in Apple's notarization history before retrying.

Normal local and CI builds remain unsigned. A local signed Mac build uses
`MUXUS_RELEASE=1` plus `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID` and
`APPLE_APP_SPECIFIC_PASSWORD`, then `pnpm dist`. Release builds fail on missing
credentials, signature problems or notarization failure.

## Microsoft Store setup

Follow [Publishing to Microsoft Store](microsoft-store.md) to reserve the Muxus
product, set its identity variables, submit the first package, and enable updates.
The Store signs the AppX and manages updates. The separate GitHub NSIS installers
remain unsigned by default, matching Kubus's default configuration.

Optional NSIS signing uses repository variable `WINDOWS_SIGNING`:

| Mode | Required configuration |
| --- | --- |
| `unsigned` (default) | None |
| `certificate` | Secrets `WINDOWS_CERTIFICATE_P12_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`; or variable `WINDOWS_CERTIFICATE_SHA1` for an installed certificate on a prepared runner |
| `azure` | Variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`; secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| `custom` | Variable `WINDOWS_SIGN_SCRIPT` pointing to a checked-in electron-builder signing hook; configure the provider's authentication in the workflow |

Every signed mode requires `WINDOWS_PUBLISHER_NAME` matching the certificate's common
name. Signing runs inside electron-builder, and the release verifies both the app
and installer signatures. A custom hook must await signing of each file it receives.
Store submission credentials (`AZURE_AD_*`) are separate from Azure signing credentials.

## Publish a release

1. Merge this setup and configure the Apple secrets before making the next release.
2. Update the workspace package versions consistently and tag that commit `v<version>`.
   The tag must contain these scripts; rerunning a tag from before this change cannot
   apply the new signing setup to the old source.
3. Publish the GitHub release. The existing **Release** workflow runs on the
   `release: published` event. To rebuild, dispatch it with the existing release **tag**.
4. The workflow verifies the version and release, builds and verifies all installers,
   signs the Linux checksums, uploads public assets, and refreshes the update manifest.
5. If Store identity variables are configured, the Windows x64 job also uploads the
   separate **muxus-windows-store** Actions artifact. AppX is excluded from GitHub downloads.
6. With `MICROSOFT_STORE_PUBLISH=true`, stable releases submit a Store update after
   GitHub publishing succeeds. Certification and publication happen later in Partner Center.

The existing `linux-release-signing` environment, secrets and pinned public key must
remain configured. The Apple and Store setup does not replace them. For unsigned
test installers, run **Package installers** with its default inputs; for a Store
submission without publishing, run **Windows Store package**.
