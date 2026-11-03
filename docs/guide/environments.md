---
icon: lucide/box
---

# Containers & VMs

Muxus finds the containers, Kubernetes clusters, Containerlab labs and virtual machines
your hosts run, and opens a terminal into any of them: a shell in a container or pod, a
lab node over SSH, a VM's serial console or VNC display. It asks the host's own tools
(`docker`, `podman`, `kubectl`, `pvesh`, `virsh`) over the SSH connection that is already
open. Nothing is installed on the host and no port is exposed.

| Tool on the host | What Muxus shows | What opens |
| --- | --- | --- |
| Docker, Podman | Containers, grouped by Compose project, with their published ports | Shell (`exec -it`), logs, start, stop, restart, pause, remove |
| Containerlab | Running labs with their nodes, kinds and management addresses | SSH to a network OS node, a shell in a Linux node, the lab's topology |
| `kubectl` | Contexts, then the pods of a namespace grouped by workload | Shell (`kubectl exec`), logs, the previous run's logs, Kubus |
| Proxmox VE (`pvesh`) | VMs and containers with their state, CPU and memory | `pct enter`, serial console (`qm terminal`), SSH, start, shut down, reboot, stop |
| libvirt (`virsh`) | Domains of `qemu:///system`, followed by those of the user's `qemu:///session` | Serial console (`virsh console`), VNC display, SSH, start, shut down, reboot, force off |

## Where they show up

**Beside the host.** While a session to a host is connected, its sidebar row ends in
small counts with each tool's logo: running containers, labs, Kubernetes contexts,
running VMs. A host that runs none of them shows nothing, so the tree stays as it was,
and so does a host nobody is connected to. Clicking a count opens the panel on that
host.

**In the panel.** The :material-cube-outline: control in the top bar opens the panel with
this computer and every connected host. Each host lists the tools it has, and each tool
lists what runs there. Every line has its own actions at the end; double-click or
++enter++ runs the main one, usually opening a shell. Resting the pointer on a line shows
its full name and details, such as a container's image, ports and ID or a pod's node and
owner. **Stopped** shows what is not running, and the filter matches names, images and
addresses.

**In the quick launcher.** Press ++ctrl+k++ and type a container, lab node, VM or
context name. A name that matches one is opened, not treated as an SSH target.

To look at a host that is not connected, right-click it in the sidebar and choose
**Containers & VMs**. Muxus connects without opening a terminal, asking for passwords
the way a session would, and lets go of that connection when the panel closes.

## When Muxus looks

With **Settings → Behavior → Find containers, clusters and VMs** on (the default), Muxus
looks at this computer when the window opens, and at an SSH host when a session to it
connects. While the session stays connected it looks again every 30 seconds, or as often
as **Refresh containers, clusters and VMs** says, so a lab you destroy in a terminal
disappears on its own. When the last session to a host closes, its containers and VMs
are no longer shown. Hosts whose server never runs a command, such as routers and
console servers, are never asked: some of them drop the whole connection when a second
channel asks to run one. The :material-refresh: button reads a host again at any time.

A host's editor decides for that host alone, under **Advanced → Find containers,
clusters and VMs**: **Like Settings**, **On** or **Off**.

A tool that is installed but does not answer is listed under its host with its own
error, for example Docker without access to its socket, or libvirt asking for polkit
authentication.

## Sessions

A container shell starts bash when the image has it, then ash, then sh. Its tab is an
ordinary session: it splits, logs, mirrors input and comes back with the workspace. Over
SSH it rides the host's existing connection, like a split pane would.

Logs open as a tab that follows the output, with the terminal's search and keyword
highlighting.

**Containerlab.** Nodes of a network operating system open with SSH to their management
address as `admin`, through the lab host when it is remote; Linux nodes open with a
shell in their container. The
:material-hub-outline: button draws the lab's topology from its `.clab.yml` and saved
annotations with the [containerlab topology viewer](https://github.com/srl-labs/containerlab-app/tree/main/packages/clab-viewer);
selecting a node offers to open it.

**Ports.** A published container port shows as a chip under its container. Clicking it
opens the port in the browser: directly on this computer, and through an SSH forward from
a remote host. The forward appears in the [forwarding panel](tunnels.md) and stops with
the connection. A Proxmox host offers its web interface the same way.

**VMs.** SSH to a VM asks for the user and connects through the hypervisor, so a VM on a
private bridge is reachable too. Its address comes from libvirt's DHCP lease, the guest
agent or the ARP table, and for Proxmox from the QEMU guest agent. VNC opens the VM's
display in a [remote desktop](remote-desktop.md) tab, through the hypervisor.

**Removing a container.** **Remove…** in a container's :material-dots-horizontal: menu
deletes it after asking, stopping it first if it runs (`docker rm --force`). Its image and
named volumes stay. Lab nodes are left to `containerlab destroy`.

**Console sessions.** A VM's serial console takes over a console another client still
holds, such as an earlier tab or virt-manager (`virsh console --force`).

## Adding to the sidebar

**Add to hosts** in the :material-dots-horizontal: menu of a container, a lab node or a
VM keeps it as a sidebar entry, so it opens again like any host:

- A container, or a Linux lab node, on an SSH host opens the host editor with a copy of
  that host whose remote command enters the container. File browsing and container
  discovery are off for it, since they would see the host. On this computer it becomes a
  local terminal profile instead.
- A network OS lab node becomes an SSH host for its management address as `admin`,
  filed under a folder named after the lab.
- A VM becomes an SSH host for the address it reports, or its console when it reports
  none.

Hosts reached through the host they run on jump through it. A jump through a Muxus
saved host only exists in Muxus storage, so those are saved there. Pods are not offered:
their names change whenever they are replaced.

**Kubus.** With the [Kubus](https://kubus-app.dev/) desktop app installed, pods and
contexts of this computer's kubeconfig offer **Open in Kubus**, which shows the pod there.

## Permissions

Muxus runs the tools as the user the session logs in as and never uses sudo. That user
needs the access it would need in a terminal: the `docker` group, `clab_admins` for
Containerlab, a kubeconfig, root or the right Proxmox role for `pvesh` and `qm`, and
the `libvirt` group for `qemu:///system`.
