; ssh:// and telnet:// links. The installer only offers Muxus for them: Windows
; lists it under Default apps, and Settings > Behavior in Muxus makes it the
; handler when the user asks. Nothing here changes the current default.

!macro muxusOfferLinkScheme SCHEME DESCRIPTION
  WriteRegStr SHELL_CONTEXT "Software\Classes\Muxus.${SCHEME}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Muxus.${SCHEME}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Muxus.${SCHEME}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Muxus.${SCHEME}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Muxus\Capabilities\URLAssociations" "${SCHEME}" "Muxus.${SCHEME}"
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Muxus\Capabilities" "ApplicationName" "Muxus"
  WriteRegStr SHELL_CONTEXT "Software\Muxus\Capabilities" "ApplicationDescription" "SSH, Telnet and serial client"
  !insertmacro muxusOfferLinkScheme "ssh" "URL:SSH link"
  !insertmacro muxusOfferLinkScheme "telnet" "URL:Telnet link"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Muxus" "Software\Muxus\Capabilities"
!macroend

; Settings > Behavior registers HKCU\Software\Classes\<scheme> for the user who
; asked. Uninstalling removes it as well, as long as it still starts this copy.
!macro muxusForgetLinkScheme SCHEME
  Push $0
  Push $1
  ReadRegStr $0 HKCU "Software\Classes\${SCHEME}\shell\open\command" ""
  StrLen $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  StrCpy $0 $0 $1
  ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    DeleteRegKey HKCU "Software\Classes\${SCHEME}"
  ${endIf}
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the user's choice must survive it.
  ${ifNot} ${isUpdated}
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Muxus"
    DeleteRegKey SHELL_CONTEXT "Software\Muxus\Capabilities"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Muxus"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\Muxus.ssh"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\Muxus.telnet"
    !insertmacro muxusForgetLinkScheme "ssh"
    !insertmacro muxusForgetLinkScheme "telnet"
  ${endIf}
!macroend
