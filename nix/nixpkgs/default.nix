# The nixpkgs-style package, laid out like pkgs/by-name in nixpkgs. It builds
# a tagged release from GitHub instead of the working tree.
#
#   nix-build nix/nixpkgs -A muxus
#   nix-update --file nix/nixpkgs muxus --version 0.14.0   # bump version and hash
#
# The root flake builds this same file, so there is a single place to bump.
{
  pkgs ? import <nixpkgs> { },
}:
{
  muxus = pkgs.callPackage ./muxus/package.nix { };
}
