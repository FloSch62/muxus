{
  description = "Muxus — SSH, Telnet, serial, RDP and VNC client with a network device workbench";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # The package is x86_64 only for now.
      # Dev shells also work on aarch64 for server and web development.
      packageSystems = [ "x86_64-linux" ];
      devSystems = packageSystems ++ [ "aarch64-linux" ];
      forPackageSystems = nixpkgs.lib.genAttrs packageSystems;
      forDevSystems = nixpkgs.lib.genAttrs devSystems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      # ── installable package ──────────────────────────────────────────────
      # The latest release, built from source. Same file nixpkgs would take
      # (nix/nixpkgs), so version and hash are bumped in exactly one place.
      #   inputs.muxus.packages.${system}.default
      packages = forPackageSystems (
        system:
        let
          muxus = (import ./nix/nixpkgs { pkgs = pkgsFor system; }).muxus;
        in
        {
          inherit muxus;
          default = muxus;
        }
      );

      apps = forPackageSystems (system: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.default;
          meta.description = "Run Muxus";
        };
      });

      # ── development shells ───────────────────────────────────────────────
      devShells = forDevSystems (system: import ./nix/dev-shells.nix (pkgsFor system));

      # ── integration for NixOS and Home Manager users ─────────────────────
      # Built with the caller's package set, so it shares their dependencies.
      overlays.default = final: _prev: (import ./nix/nixpkgs { pkgs = final; });

      # ── formatter (nixfmt via nix fmt) ───────────────────────────────────
      formatter = forDevSystems (system: (pkgsFor system).nixfmt);
    };
}
