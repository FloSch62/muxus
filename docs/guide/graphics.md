---
icon: lucide/image
---

# Images in the terminal

Muxus renders images **inside the terminal**, over SSH, using the same protocols kitty and
WezTerm made popular. `kitten icat` works. yazi and ranger previews work. matplotlib's
terminal backends work. `timg` works.

<figure markdown="span">
  ![A chart rendered inline in an SSH session](../assets/screenshots/kitty-graphics.png#only-light){ .shadow }
  ![A chart rendered inline in an SSH session](../assets/screenshots/kitty-graphics-dark.png#only-dark){ .shadow }
  <figcaption>A plot written straight to the terminal by a remote command — no local file, no viewer.</figcaption>
</figure>

## What is supported

**Kitty graphics protocol** — direct transmission (`a=T`), chunked payloads, optionally
zlib-compressed, in PNG or raw RGB/RGBA; placements with **z-index** (including negative
z, drawn below the text layer), explicit **cell sizing** (`c=`/`r=`), and the delete
commands that let an application clean up after itself.

**Sixel** and **iTerm2 inline images** are handled by the same addon, so tools that speak
those instead just work.

**Cell metrics.** Tools discover the pixel size of a cell through `CSI 14 t` / `CSI 16 t`
when the PTY reports no pixel size, which is how `icat` decides how many columns your
image should occupy.

## How it works

xterm.js 6.1 streams the APC payload straight into the Image Addon: chunks are parsed
incrementally, base64 decoding runs through WebAssembly, and the result is drawn as a
terminal-buffer-aware canvas layer. There is no second parser in Muxus and no per-chunk
scheduling queue — the image arrives at the speed of the connection.

Images scroll with the buffer, survive resizes, and are dropped when their lines leave the
scrollback.

## Limits

A single kitty transmission is capped at **64 MiB**, and each terminal keeps a bounded
image store — larger for the tab you are looking at than for the ones you are not. When
the store fills, the oldest images are evicted; the text buffer is never affected.

## Try it

On a host with kitty's `icat` kitten:

```bash
kitten icat chart.png
```

With Python and matplotlib, the kitty backend draws straight into the session:

```bash
python -c "import matplotlib; matplotlib.use('module://matplotlib-backend-kitty'); \
import matplotlib.pyplot as plt; plt.plot([1,4,9,16]); plt.show()"
```

Or, with nothing installed at all, any tool that emits a kitty escape sequence — the
screenshot above is a shell script writing one to stdout.

!!! tip "File managers"

    yazi and ranger detect the protocol automatically, so image previews in a remote file
    manager render inline instead of falling back to ASCII art.
