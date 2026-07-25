!macro AUTOCODE_KILL_PROCESS processName
  DetailPrint "Stopping ${processName} if it is running..."
  nsExec::ExecToLog 'taskkill /F /T /IM "${processName}"'
!macroend

!macro AUTOCODE_STOP_RUNTIME_PROCESSES
  !insertmacro AUTOCODE_KILL_PROCESS "autocode_local_connector.exe"
  !insertmacro AUTOCODE_KILL_PROCESS "sherpa-onnx-offline-websocket-server.exe"
  !insertmacro AUTOCODE_KILL_PROCESS "sherpa-onnx-offline-parallel.exe"
  !insertmacro AUTOCODE_KILL_PROCESS "sherpa-onnx-offline.exe"
  !insertmacro AUTOCODE_KILL_PROCESS "sherpa-onnx.exe"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AUTOCODE_STOP_RUNTIME_PROCESSES
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AUTOCODE_STOP_RUNTIME_PROCESSES
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$DESKTOP\AutoCode Local Connector.lnk"
  Delete "$DESKTOP\AutoCode IDE.lnk"
  CreateShortCut "$DESKTOP\AutoCode IDE.lnk" "$INSTDIR\autocode_local_connector.exe" "" "$INSTDIR\autocode_local_connector.exe" 0
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
