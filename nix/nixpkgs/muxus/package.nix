{
  lib,
  stdenv,
  fetchFromGitHub,
  nodejs,
  node-gyp,
  pnpm_12,
  fetchPnpmDeps,
  pnpmConfigHook,
  electron,
  makeWrapper,
  copyDesktopItems,
  makeDesktopItem,
  python3,
  nix-update-script,
}:

let
  pnpm = pnpm_12;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "muxus";
  version = "0.13.0";

  src = fetchFromGitHub {
    owner = "FloSch62";
    repo = "muxus";
    tag = "v${finalAttrs.version}";
    hash = "sha256-4oBbassVtlCvOyvEh30NFWcO6dAlqPZQwEK+Ts30tyA=";
  };

  # Everything the desktop app needs; leaves out the test workspace.
  pnpmWorkspaces = [
    "@muxus/shared"
    "@muxus/server"
    "@muxus/client"
    "@muxus/electron"
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 5;
    hash = "sha256-tmlsW5cYLgJ6bJBNSZg1DCasPdmm1OZPBS1O464zFYs=";
  };

  nativeBuildInputs = [
    nodejs
    node-gyp
    pnpm
    pnpmConfigHook
    makeWrapper
    copyDesktopItems
    python3
  ];

  strictDeps = true;

  env = {
    ELECTRON_SKIP_BINARY_DOWNLOAD = 1;
    # node-gyp builds against the local Node headers instead of downloading them.
    npm_config_nodedir = nodejs;
  };

  # The app runs on the shared nixpkgs Electron, whose resources directory and
  # executable are not ours: point both at this package.
  postPatch = ''
    substituteInPlace electron/src/main.ts \
      --replace-fail "process.resourcesPath" "'$out/share/muxus/resources'" \
      --replace-fail ": [process.execPath]," ": ['$out/bin/muxus'],"
  '';

  buildPhase = ''
    runHook preBuild

    # pnpmConfigHook installs with --ignore-scripts. node-pty has no Linux
    # prebuild, and the serialport prebuild cannot find libstdc++ on Nix. Both
    # are N-API, so building them against Node also suits Electron.
    pnpm --filter=@muxus/electron rebuild node-pty
    # A transitive dependency, which pnpm rebuild skips.
    (cd node_modules/.pnpm/@serialport+bindings-cpp@*/node_modules/@serialport/bindings-cpp && node-gyp rebuild)

    pnpm --recursive ${lib.concatMapStringsSep " " (p: "--filter=${p}") finalAttrs.pnpmWorkspaces} build

    cp -r ${electron.dist} electron-dist
    chmod -R u+w electron-dist
    pnpm --filter=@muxus/electron exec electron-builder --dir \
      -c.electronDist=$PWD/electron-dist \
      -c.electronVersion=${electron.version} \
      -c.npmRebuild=false

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/muxus
    cp -r electron/release/linux-unpacked/resources $out/share/muxus/resources

    # Left by electron-builder, not used by this package: Electron's own default
    # app, the updater feed, and the prebuilt binaries replaced by the rebuild
    # above or meant for other platforms.
    rm $out/share/muxus/resources/{default_app.asar,app-update.yml}
    unpacked=$out/share/muxus/resources/app.asar.unpacked/node_modules
    rm -r $unpacked/@napi-rs/keyring-linux-arm64-gnu $unpacked/node-pty/prebuilds \
      $unpacked/@serialport/bindings-cpp/prebuilds

    for size in 16 24 32 48 64 128 256 512 1024; do
      install -Dm644 electron/build/icons/''${size}x''${size}.png \
        $out/share/icons/hicolor/''${size}x''${size}/apps/muxus.png
    done

    makeWrapper ${lib.getExe electron} $out/bin/muxus \
      --add-flags $out/share/muxus/resources/app.asar \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}" \
      --set-default ELECTRON_FORCE_IS_PACKAGED 1 \
      --inherit-argv0

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "muxus";
      desktopName = "Muxus";
      genericName = "SSH client";
      comment = finalAttrs.meta.description;
      exec = "muxus %U";
      icon = "muxus";
      categories = [ "Network" ];
      mimeTypes = [
        "x-scheme-handler/ssh"
        "x-scheme-handler/telnet"
      ];
      startupWMClass = "muxus";
      actions.new-window = {
        name = "New Window";
        exec = "muxus --new-window";
      };
    })
  ];

  passthru.updateScript = nix-update-script { };

  meta = {
    description = "SSH, Telnet, serial, RDP and VNC client with network device workbench";
    homepage = "https://github.com/FloSch62/muxus";
    changelog = "https://github.com/FloSch62/muxus/releases/tag/v${finalAttrs.version}";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "muxus";
    maintainers = [ ];
  };
})
