---
icon: lucide/network
---

# NETCONF & gNMI

gNMI and NETCONF hosts open a **workbench** in a tab: browse a device's live configuration
and state, run Get, Set and Subscribe over gNMI, send NETCONF RPCs, and stage, review and
commit changes. gNMI hosts also carry the device's **gNOI** operations (ping, traceroute,
files, health, reboot …) and its **gNSI** security services (authorization policies,
certificates, SSH keys, accounting). It sits in the same host list, folders, panes and
workspaces as your SSH sessions, so the device's CLI and its management API can share a
split.

Nothing extra needs to be installed. Muxus speaks the protocols itself: gNMI, gNOI and gNSI
over gRPC (HTTP/2, TLS by default) and NETCONF over SSH (RFC 6242).

## Adding a host

**Add host** offers **gNMI** and **NETCONF** next to SSH, Telnet, serial, RDP and VNC. Both
are stored as Muxus's own saved hosts.

| Section | Setting |
| --- | --- |
| **General** | Name, host, port (57400 for gNMI, 830 for NETCONF when left empty), folder and colour |
| **Login** | User name. Leave it empty to be asked when connecting |
| **Security** (gNMI) | TLS, TLS without verification, or plain text; a CA certificate, the name the certificate carries, and a client certificate for mutual TLS |
| **Connection route** | An optional [SSH gateway or jump host](#through-an-ssh-gateway) |
| **Options** (gNMI) | The encoding to request. *Automatic* picks JSON_IETF when the device offers it |

To manage a device you already reach over SSH, right-click it and choose **Add gNMI host
for it…** or **Add NETCONF host for it…**: the address, user and folder are filled in.

!!! tip "containerlab"
    containerlab issues each lab its own CA. Point **CA certificate** at
    `clab-<lab>/.tls/ca/ca.pem` to verify the node certificates, or choose **TLS, don't
    verify**, since they change with every deploy. containerlab also adds its nodes to
    `/etc/hosts`, so node names such as `clab-<lab>-leaf1` work as the host.

## Logging in

=== "gNMI"

    gNMI has no login step: the user name and password travel with every request, as the
    protocol requires. Muxus reaches the device and checks its certificate first, then asks
    for the password. Tick **Remember this password** to keep it in the encrypted
    [password vault](../reference/security.md#password-vault); it is saved once the device
    has accepted it. **Connect without a login** is offered for devices that do not
    authenticate gNMI.

=== "NETCONF"

    NETCONF runs inside SSH, so it logs in like an SSH tab: keys from `ssh_config` and the
    agent are tried first, host keys are checked, and a password can be kept in the vault.
    An `ssh_config` alias works as the host; its user, keys and `ProxyJump` apply. The
    session asks for the `netconf` subsystem and negotiates chunked framing (base:1.1) when
    the device offers it.

## The workbench

The header shows what the device advertised: the gNMI version, encodings and models with
the TLS state, or the NETCONF session, framing and module count. **Reconnect** keeps your
requests, results and history: they belong to the tab, not the connection.

### Explore

The navigator browses the device's data as a tree. gNMI fetches two levels at a time with
the depth extension, so even large devices open instantly; NETCONF loads the configuration
whole, or with **Config + state** fetches each branch with a subtree filter as you open it.
List entries are labelled by their keys, which Muxus learns from the paths the device
sends.

Hover a node to **Get** it or (gNMI) **Watch** it. Right-click for more: **Set value…**,
**Delete…**, **Edit configuration…** and **Use as filter** (NETCONF), and copying the path,
XPath, subtree filter, value or a `gnmic` command. Double-click a node to get it.

### Requests and results

- **Paths complete from the device's own data.** Type `/` and the path field offers what is
  there, list entries with their keys, and leaf values as a preview. Levels not yet loaded
  are fetched as you type. A malformed path is pointed out before it is sent.
- **Ctrl+Enter** (⌘Enter on macOS) runs the request; **Esc** cancels one that is still
  running.
- **Results** show as a tree, a table of leaves, or the raw JSON or XML, with a filter.
  **Compare** shows the difference from the last run of the same request, for example
  before and after a change. Results can be copied or saved.
- When a device rejects a path and lists the valid alternatives, as SR Linux does, they
  are offered as one-click fixes.

### Saved and History

**Saved** keeps requests for this host or for every host of the protocol. **History**
keeps every request of the tab with its result: click to show the result again,
double-click to run it again.

### Device

The gNMI models, or the NETCONF capabilities and YANG modules, with a search. With
`ietf-netconf-monitoring`, click a module to open its YANG source (`get-schema`). The SSH
login banner and NETCONF notifications appear here too.

## gNMI

**Get** reads paths with a data type (all, config, state, operational), an encoding and an
optional depth. Several paths and a common prefix are supported.

**Set** collects updates, replaces and deletes. **Review…** reads the current
configuration at each path and shows the change as a diff, so a mistyped path or value is
caught before anything is sent. **Roll back automatically unless confirmed** uses the gNMI
commit-confirmed extension: the change goes live, a bar counts down, and unless you click
**Confirm** the device undoes it, a safety net for changes that could cut you off.

**Subscribe** streams updates (sample, on change or target defined), or gets them once or
on demand (**Poll**). The live table keeps the latest value of every leaf:

- counters get a **rate**, in bit/s for octets and pkt/s for packets, and a sparkline;
- state that changes is highlighted;
- **Pause** freezes the view while updates keep arriving; the table can be filtered,
  sorted and exported as CSV.

## Operations (gNOI)

On a gNMI host, **Operations** in the session header opens the device's gNOI services,
over the same connection and login. Tools the device does not offer (it lists its
services through gRPC reflection) are greyed out.

| Tool | What it does |
| --- | --- |
| **Ping** | Pings from the device, in any network instance. Replies stream in with a round-trip chart, loss and min/avg/max. |
| **Traceroute** | The path from the device, hop by hop, with ICMP, UDP or TCP probes, AS paths and MPLS labels where reported. |
| **Files** | Browses the device's file system. Click a file to preview it, download it, drop files to upload them, or delete. Every transfer is checked against the hash gNOI carries. |
| **Health** | A component's health, past unhealthy events with their debug artifacts, and acknowledging them. |
| **Processes** | Restarts or signals a daemon by name or PID. |
| **BGP** | Resets a BGP neighbor, hard or soft. |
| **System** | The device clock against this computer's, and the running software version. |
| **Reboot** | Shows whether a reboot is pending, schedules one (cold, warm, power-down …) with an optional delay, and cancels it. Rebooting asks you to type the host's name. |

## Security (gNSI)

**Security** holds the gNSI services. Each one that replaces something follows gNSI's
safe rotation: the new policy, certificate or key **takes effect but stays provisional**.
A bar shows it; test it (a probe, a new TLS connection, an SSH login), then **Finalize**.
**Roll back**, closing the tab or losing the connection restores the previous one, so a
bad change cannot lock you out.

- **Authorization** (`gnsi.authz`): the gRPC authorization policy in force as rules (who,
  which RPCs, allow or deny) or JSON. **Probe** asks the device whether a user may call an
  RPC, against the provisional policy while one is pending. **Edit…** shows the change as a
  diff before it is uploaded.
- **Path authorization** (`gnsi.pathz`): who may read or write which gNMI paths. Probe a
  user, path and mode against the active or the sandbox policy; create and edit rules.
- **Certificates** (`gnsi.certz`): the device's TLS profiles. Upload a certificate, key and
  CA bundle (PEM); before you finalize, **What the device presents** opens a fresh TLS
  connection and compares its fingerprint with the uploaded one.
- **SSH credentials** (`gnsi.credentialz`): the device's host keys, and the public keys an
  account may log in with. Paste keys or add `.pub` files; they replace the account's
  keys once finalized. Accounts whose keys the configuration manages may be refused by the
  device.
- **Accounting** (`gnsi.acctz`): every CLI command and gRPC call on the device, with user,
  source, service and whether it was allowed, from the history you choose and then live.
  Filter it, or export it as CSV.

## NETCONF

The operation menu covers retrieval (`get`, `get-config`, `get-schema`), changes
(`edit-config`, `copy-config`, `delete-config`), the candidate (`validate`, `commit`,
`discard-changes`, `cancel-commit`, `lock`, `unlock`), sessions (`create-subscription`,
`kill-session`) and any custom RPC. Only options the device advertises are offered, such as
XPath filters, with-defaults or `rollback-on-error`. **RPC as sent** shows the exact
message.

With `:candidate`, a bar appears whenever the candidate holds uncommitted changes, from
this session or another:

- **Review** shows them as a diff against running;
- **Validate**, **Commit**, **Commit confirmed…** (with a rollback countdown and
  **Confirm** / **Roll back now**) and **Discard**;
- locks this session holds are shown with an **Unlock** button.

**Edit configuration…** on a node fetches its current configuration into an `edit-config`,
ready to change. Changes to running ask for confirmation first.

## Copy as automation

**Copy as** turns the request in the editor into a `gnmic` command line, an `ncclient`
Python script, the raw `<rpc>`, or an `ssh -s netconf` command. Passwords are never
included.

## Through an SSH gateway

**Connection route** reaches the device through an SSH host in the list. For gNMI it works
like `ssh -L`: the host and port are connected from the gateway's side, and TLS still runs
end to end between Muxus and the device. For NETCONF the SSH host becomes a jump host, like
`ssh -J`.

## Certificates

A gNMI certificate that chains to a trusted authority (or the CA you set) and names the
host is accepted silently. Anything else is shown once with its SHA-256 fingerprint and,
when trusted, pinned for that host, port and route, the way RDP certificates are. A changed
certificate gets a warning. **TLS, don't verify** skips all of this for lab devices whose
certificates are regenerated often.

## Not supported yet

YANG-aware completion for paths with no data yet, NETCONF over TLS (RFC 7589), and the
gNOI services for software installation, certificate management (the older `gnoi.cert`)
and packet capture are not available.
