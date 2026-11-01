# Nix and NixOS

Muxus ships a flake that builds the latest release from source and runs it on the Electron from nixpkgs, which can be older than the version the release is tested with.

## Install

Try it without installing:

```sh
nix run github:FloSch62/muxus
```

On NixOS, add it as an input and use the package or the overlay:

```nix
# flake.nix
inputs.muxus.url = "github:FloSch62/muxus";
inputs.muxus.inputs.nixpkgs.follows = "nixpkgs";

# configuration.nix
environment.systemPackages = [ inputs.muxus.packages.${pkgs.stdenv.hostPlatform.system}.default ];
```

`nix flake update muxus` picks up the newest release.

The first build downloads about 750 MB of JavaScript dependencies, which takes minutes rather than seconds. The compile itself takes about a minute, and the dependencies are only downloaded again when a release changes them.

## Develop

```sh
nix develop              # Node 24, pnpm, native addon toolchain, uv
nix develop .#electron   # plus the Electron runtime libraries and .deb tools
```

With direnv, `direnv allow` loads the default shell on `cd` (`.envrc` uses the flake).

## Packaging for nixpkgs

`nix/nixpkgs/muxus/package.nix` is written the way nixpkgs wants it and is laid out like `pkgs/by-name`. The flake builds this same file, so a release bumps one place:

```sh
nix-update --flake muxus --version X.Y.Z
nix build .#muxus
```

The **nixpkgs** workflow runs this after each release and opens a PR with the bump. Once Muxus is in nixpkgs, its bot opens version bumps there too, and users get prebuilt downloads from the NixOS binary cache.
