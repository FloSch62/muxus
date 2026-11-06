---
icon: lucide/globe
---

# Web pages

A **Web** host is a saved web page, such as a monitoring dashboard, a device's web console
or an internal wiki. It sits in the host list with your other hosts, with the same folders,
colours and search, and opens in its own Muxus browser window.

## Adding a page

**Add host → Web** asks for a name and an address. An address without `http://` or
`https://` gets `http://`. Web pages are stored as Muxus's own saved hosts, not in
`ssh_config`.

## Through an SSH gateway (SOCKS5)

**Connection route → SSH gateway** opens the page through any SSH host in the list, like
`ssh -D`. When you open the page, Muxus connects to the gateway, starts a SOCKS5 proxy on a
free local port, and points the page's window at it. Every request goes through the
gateway, name lookups included, so:

- internal names and addresses that only the gateway can reach work,
- HTTPS stays end to end between the window and the site, with the real host name,
- links to other internal hosts open as well, and
- `localhost` means the gateway itself, for a page served only on its loopback interface.

The gateway connects the way an SSH tab would: its jump chain, keys, host-key checks and
password prompts all apply.

The proxy stops when the page's window closes. Opening the page again while its window is
open brings that window to the front.

## The page's window

- Each page has its own cookie store, so its logins are kept between visits and never shared
  with another page.
- ++alt+left++ / ++alt+right++ go back and forward, ++f5++ or ++ctrl+r++ (++cmd+r++ on macOS)
  reloads, and the right-click menu has the same.
- A site whose certificate is not trusted, such as a device's self-signed one, asks before it
  continues. The answer holds until the window closes.
- Pages are never given the camera, microphone, location or notifications.

In the browser version of Muxus (`pnpm start`), a page without a gateway opens in a new
browser tab. A page with a gateway starts its SOCKS5 proxy and shows its address; set it as
your browser's SOCKS5 proxy (with remote DNS) to use it, and stop it in the forwarding panel.
