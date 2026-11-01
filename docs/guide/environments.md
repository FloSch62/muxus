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
| Docker, Podman | Containers, grouped by Compose project, with their published ports | Shell (`exec -it`), logs, start, stop, restart, pause |
| Containerlab | Running labs with their nodes, kinds and management addresses | SSH to a network OS node, a shell in a Linux node, the lab's topology |
| `kubectl` | Contexts, then the pods of a namespace grouped by workload | Shell (`kubectl exec`), logs, the previous run's logs, Kubus |
| Proxmox VE (`pvesh`) | VMs and containers with their state, CPU and memory | `pct enter`, serial console (`qm terminal`), SSH, start, shut down, reboot, stop |
| libvirt (`virsh`) | Domains of `qemu:///system`, and of `qemu:///session` when it has any | Serial console (`virsh console`), VNC display, SSH, start, shut down, reboot, force off |

## Where they show up

**Beside the host.** Once Muxus has looked at a host, its sidebar row ends in small
counts: running containers, labs, Kubernetes contexts, running VMs. A host that runs none
of them shows nothing, so the tree stays as it was. Clicking a count opens the panel on
that host.

**In the panel.** The :material-cube-outline: control in the top bar opens the panel with
every host found so far. Each host lists the tools it has, and each tool lists what runs
there. Every line has its own actions at the end; double-click or ++enter++ runs the main
one, usually opening a shell. **Stopped** shows what is not running, and the filter
matches names, images and addresses.

**In the quick launcher.** Press ++ctrl+k++ and type a container, lab node, VM or
context name. A name that matches one is opened, not treated as an SSH target.

To look at a host that is not connected, right-click it in the sidebar and choose
**Containers & VMs**. Muxus connects without opening a terminal, asking for passwords
the way a session would, and lets go of that connection when the panel closes.

## When Muxus looks

With **Settings → Behavior → Find containers, clusters and VMs** on (the default), Muxus
looks at this computer when the window opens, and at an SSH host when a session to it
connects, at most every five minutes. Hosts whose server never runs a command, such as
routers and console servers, are never asked: some of them drop the whole connection
when a second channel asks to run one. The :material-refresh: button reads a host again
at any time.

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
shell in their container. :material-grid: opens every running node side by side and
types into all of them at once ([multi-exec](commands.md#multi-execution)). The
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

**Kubus.** With the [Kubus](https://kubus-app.dev/) desktop app installed, pods and
contexts of this computer's kubeconfig offer **Open in Kubus**, which shows the pod there.

## Permissions

Muxus runs the tools as the user the session logs in as and never uses sudo. That user
needs the access it would need in a terminal: the `docker` group, `clab_admins` for
Containerlab, a kubeconfig, root or the right Proxmox role for `pvesh` and `qm`, and
the `libvirt` group for `qemu:///system`.
