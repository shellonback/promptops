; promptops-termd hosts the terminals and outlives the app. On Windows a running
; .exe cannot be overwritten: close it before the installer extracts the files.
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing the terminal host (promptops-termd)..."
  nsExec::Exec 'taskkill /F /IM "promptops-termd.exe" /T'
  Pop $0
  Sleep 500
!macroend
