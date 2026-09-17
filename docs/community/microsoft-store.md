---
icon: lucide/store
---

# Publishing to Microsoft Store

Muxus builds an unsigned x64 AppX for Partner Center's **MSIX or PWA app** route,
matching Kubus. Microsoft signs the package after certification and distributes
updates. You do not need to purchase a signing certificate for this route; see
[Microsoft's package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements).
GitHub's x64 and ARM64 NSIS downloads remain available separately.

## Reserve Muxus and configure its identity

Use your existing Microsoft Store developer account in **Partner Center** and
reserve **Muxus** as a new MSIX product. Do not reuse Kubus's package name or Store ID.
Open **Product management → Product identity** and copy the exact values into
**FloSch62/muxus → Settings → Secrets and variables → Actions → Variables**:

| Repository variable | Partner Center value |
| --- | --- |
| `MICROSOFT_STORE_IDENTITY_NAME` | Package/Identity/Name |
| `MICROSOFT_STORE_PUBLISHER` | Package/Identity/Publisher, including `CN=` |
| `MICROSOFT_STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName |
| `MICROSOFT_STORE_PRODUCT_ID` | 12-character Store ID |

Publisher fields may match Kubus when using the same account, but copy them from
Muxus's Product identity page. Identity fields are case-sensitive. Keep them stable
across updates. The application ID is `Muxus`, and minimum Windows is 10.0.19041.0.
The workflow requires the actual identity; it does not invent a production identity.

## Build and submit the first version

1. Merge the prepared branch, then run **Actions → Windows Store package** on the
   desired ref. GitHub exposes a new manually dispatched workflow after it exists
   on the default branch.
2. Download the **muxus-windows-store** artifact and extract
   `muxus-<version>-win-x64.appx` from the Actions ZIP.
3. In Partner Center, start a submission for Muxus. Choose **Free** and complete pricing/availability,
   properties, age ratings, the listing, screenshots, support URL and privacy policy.
4. Upload the extracted `.appx` under **Packages**. The Actions ZIP and NSIS `.exe`
   are not the package for this route.
5. Explain the `runFullTrust` capability and give certification testers instructions.
   A suitable starting point is: “Muxus is a desktop SSH, Telnet and serial client.
   It starts local shells, accesses user-selected SSH configuration and keys, stores
   saved credentials with the OS credential store, and opens network and serial
   connections requested by the user.” Provide a reachable test SSH environment
   where needed and avoid including personal credentials in public listing text.
6. Choose the publishing schedule and submit for certification manually. Wait until
   the first version is published before enabling automatic release submissions.

Use a privacy policy that accurately covers local host settings, encrypted saved
passwords, optional session history, and user-initiated network connections. The
repository's [security model](../reference/security.md) can inform it, but is not a
substitute for completing the listing. See Microsoft's
[submission checklist](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission).

The Store package version is `<major + 1>.<minor>.<patch>.0`: Muxus `0.7.0` becomes
`1.7.0.0`, and Muxus `1.0.0` will become `2.0.0.0`. This keeps the major nonzero and
the fourth component zero, as required by the Store. Keep the mapping and bump the
application version for updates. The app's displayed version remains unchanged.

Local packaging requires Windows and the repository's Node.js/pnpm versions:

```powershell
# Set the four MICROSOFT_STORE_* identity environment variables above first.
pnpm install --frozen-lockfile
pnpm dist:store
```

The output is `electron/release-store/`. Store tile assets are generated from the
Muxus SVG, including transparent light/dark taskbar variants. CI tests AppX packaging
with a placeholder identity; it does not publish those test packages as artifacts.

## Test the installed package

Run the Windows App Certification Kit and test an installation on Windows. For
local sideloading, sign a **copy** with a development certificate matching the
package publisher and trust that certificate on the test machine. Preserve the
unsigned original for Store submission. See Microsoft's
[package signing guide](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview).

- Launch from Start; check the icon in light and dark themes.
- Open a local shell, SSH session, SFTP browser and port forward.
- Test serial/COM access and Telnet where available.
- Read an existing SSH config and key file, and save/retrieve a test password.
- Test optional session history and a user-selected storage directory.
- In **Settings → About**, **Check for updates** must open the Muxus Store page.
  Background checks must stay quiet and never offer a GitHub installer.
- Install a newer Store version and verify settings and the password vault survive.

Store installations can redirect application data into the package's per-user
storage. Do not promise automatic migration from an existing NSIS installation;
test data and credential access before recommending a switch.

## Enable subsequent release submissions

Reuse the Microsoft Entra application used for Kubus if it is authorized to manage
Muxus under the same Partner Center account. Otherwise, link an Entra tenant and
add an application under **Account settings → User management → Microsoft Entra
applications**, with the **Manager** role for the Windows developer program.

Add these repository **secrets** in FloSch62/muxus:

| Secret | Value |
| --- | --- |
| `AZURE_AD_TENANT_ID` | Linked directory/tenant ID |
| `AZURE_AD_APPLICATION_CLIENT_ID` | Application/client ID |
| `AZURE_AD_APPLICATION_SECRET` | Client secret **Value**, not the Secret ID |
| `SELLER_ID` | Partner Center publisher account's Seller ID, not the Muxus Store ID |

Find Seller ID under **Account settings → Legal info / Legal profile → Developer →
Publisher IDs**. Keep the secret's expiry date recorded and rotate it before expiry.
See Microsoft's [GitHub Actions publishing guide](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/github-actions).

After the first version is live, set repository **variable**
`MICROSOFT_STORE_PUBLISH` to `true`. The next stable GitHub release downloads the
already-built AppX and submits it with Microsoft Store Developer CLI v0.4.2, as in Kubus.
Leaving this unset still builds Store artifacts once the identity is configured.

The publisher validates the product ID and package identity, leaves the first
manual submission intact, refuses to overwrite a pending submission, and skips
versions already published or superseded. Jobs are serialized. It reuses the last
published listing and schedule, and finishes after committing for certification;
a successful job does not mean the new version is live yet.

Avoid editing the Partner Center submission during a workflow upload. If an upload
or commit fails, inspect the draft in Partner Center before retrying; the script
will not delete a pending submission. Pull requests, CI, packaging workflows and
prerelease tags never submit to the Store.
