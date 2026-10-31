# Nix and NixOS

Muxus ships a flake. It wraps the released AppImage, so nothing is compiled.

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

## Develop

```sh
nix develop              # Node 24, pnpm, native addon toolchain, uv
nix develop .#electron   # plus the Electron runtime libraries and .deb tools
```

With direnv, `direnv allow` loads the default shell on `cd` (`.envrc` uses the flake).

## Packaging for nixpkgs

`nix/nixpkgs/muxus/package.nix` is written the way nixpkgs wants it and is laid out like `pkgs/by-name`. The flake builds this same file, so a release bumps one place:

```sh
nix-update --file nix/nixpkgs muxus --version X.Y.Z
nix-build nix/nixpkgs -A muxus
```

The **nixpkgs** workflow runs this after each release and uploads the bumped file as an artifact.
