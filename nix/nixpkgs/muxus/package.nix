{
  lib,
  appimageTools,
  fetchurl,
  nix-update-script,
}:

let
  pname = "muxus";
  version = "0.13.0";

  src = fetchurl {
    url = "https://github.com/FloSch62/muxus/releases/download/v${version}/muxus-${version}-linux-x86_64.AppImage";
    hash = "sha256-3FPZss8XspEOXMEAG/R17Uq+FwCgXi8eC0h/8O3kqL4=";
  };

  appimageContents = appimageTools.extract { inherit pname version src; };
in
appimageTools.wrapType2 {
  inherit pname version src;

  extraInstallCommands = ''
    install -Dm644 ${appimageContents}/muxus.desktop $out/share/applications/muxus.desktop
    substituteInPlace $out/share/applications/muxus.desktop \
      --replace-fail "Exec=AppRun" "Exec=muxus"
    cp -r ${appimageContents}/usr/share/icons $out/share/icons
  '';

  passthru.updateScript = nix-update-script { };

  meta = {
    description = "SSH, Telnet, serial, RDP and VNC client with network device workbench";
    homepage = "https://github.com/FloSch62/muxus";
    changelog = "https://github.com/FloSch62/muxus/releases/tag/v${version}";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    mainProgram = "muxus";
    maintainers = [ ];
  };
}
