@echo off
title Mafaza Photobooth - Pasang AutoStart Windows
color 0a
cd /d "%~dp0"

echo ======================================================================
echo    MEMASANG CANON USB BRIDGE KE AUTOSTART WINDOWS (LATAR BELAKANG)
echo ======================================================================
echo.

set TARGET_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS_SCRIPT=%~dp0Jalankan-Silent.vbs
set SHORTCUT=%TARGET_DIR%\MafazaCanonBridge.lnk

echo Membuat Shortcut di folder Startup Windows:
echo %TARGET_DIR%

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%VBS_SCRIPT%\"'; $s.WorkingDirectory = '%~dp0'; $s.Save()"

if exist "%SHORTCUT%" (
    echo.
    echo [OK] BERHASIL! Canon USB Bridge akan otomatis berjalan di latar belakang
    echo      setiap kali komputer Windows dinyalakan.
    echo.
    echo Menjalankan bridge sekarang...
    wscript.exe "%VBS_SCRIPT%"
    echo [OK] Bridge sudah aktif di port 19898.
) else (
    echo [GAGAL] Tidak dapat membuat shortcut autostart.
)

echo.
pause
