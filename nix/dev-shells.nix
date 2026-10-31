# Development shells, shared by the flake for every supported system.
#   nix develop              day-to-day web + server work
#   nix develop .#electron   adds the Electron runtime and .deb packaging tools
pkgs:
let
  electronLibs = with pkgs; [
    alsa-lib
    at-spi2-atk
    cups
    dbus
    expat
    glib
    gtk3
    libdrm
    mesa
    nspr
    nss
    pango
    libx11
    libxcb
    libxcomposite
    libxcursor
    libxdamage
    libxext
    libxfixes
    libxi
    libxrandr
    libxrender
    libxscrnsaver
    libxtst
    libxshmfence
    libxkbfile
  ];
in
rec {
  # pnpm dev, pnpm test, pnpm lint, pnpm serve-docs (zensical via uvx)
  default = pkgs.mkShell {
    name = "muxus-dev";

    packages = with pkgs; [
      # Matches "node": ">=24.20.0" in package.json
      nodejs_24
      pnpm

      # Native addons: node-pty, serialport, @napi-rs/keyring (links libsecret)
      python3
      gnumake
      gcc
      libsecret
      pkg-config

      # pnpm serve-docs / build-docs run `uvx zensical`
      uv

      git
      jq
    ];

    shellHook = ''
      export npm_config_python="${pkgs.python3}/bin/python3"

      echo "muxus dev shell ready  (Node $(node --version), pnpm $(pnpm --version))"
      echo "  pnpm install            install dependencies"
      echo "  pnpm dev                start Vite + tsx watchers"
      echo "  pnpm test               run the vitest suite"
      echo "  nix develop .#electron  adds the Electron system libs"
    '';
  };

  # Work on electron/ or run `pnpm dist` / `make deb`.
  electron = pkgs.mkShell {
    name = "muxus-electron";
    inputsFrom = [ default ];

    packages =
      electronLibs
      ++ (with pkgs; [
        # electron-builder deb packaging
        dpkg
        fakeroot
      ]);

    shellHook = ''
      ${default.shellHook}
      export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath electronLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      echo "  pnpm electron           build + launch the Electron app"
      echo "  make deb                build the .deb package"
    '';
  };
}
