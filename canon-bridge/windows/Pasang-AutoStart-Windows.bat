@echo off
title Mafaza Photobooth - Pasang AutoStart Windows
color 0a
cd /d "%~dp0"

REM Matikan proses bridge lama jika sedang berjalan agar port 19898 bebas
taskkill /f /im MafazaCanonBridge.exe >nul 2>&1

echo ======================================================================
echo    MEMASANG CANON USB BRIDGE KE AUTOSTART WINDOWS (LATAR BELAKANG)
echo ======================================================================
echo.

REM 1. Kompilasi jika belum ada file executable
if not exist "MafazaCanonBridge.exe" (
    echo Menyiapkan MafazaCanonBridge.exe...
    set CSC=
    if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
        set CSC="%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    ) else if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
        set CSC="%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )
    if defined CSC (
        %CSC% /nologo /target:exe /out:MafazaCanonBridge.exe /platform:anycpu MafazaCanonBridge.cs
    )
)

if not exist "MafazaCanonBridge.exe" (
    echo [ERROR] MafazaCanonBridge.exe belum siap. Jalankan 'Pasang-dan-Jalankan-Canon-USB-Bridge.bat' terlebih dahulu.
    pause
    exit /b 1
)

REM 2. Buat Shortcut Startup Windows langsung ke executable (tanpa script VBS)
set TARGET_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set EXE_PATH=%~dp0MafazaCanonBridge.exe
set SHORTCUT=%TARGET_DIR%\MafazaCanonBridge.lnk

echo Mendaftarkan ke folder Startup Windows:
echo %TARGET_DIR%

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%EXE_PATH%'; $s.Arguments = '-silent'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Save()"

if exist "%SHORTCUT%" (
    echo.
    echo [OK] BERHASIL! Canon USB Bridge akan otomatis berjalan di latar belakang
    echo      setiap kali komputer Windows dinyalakan.
    echo.
    echo Menjalankan Canon USB Bridge sekarang (mode latar belakang)...
    start "" /min "%EXE_PATH%" -silent
    echo [OK] Bridge sudah aktif di port 19898.
) else (
    echo [GAGAL] Tidak dapat membuat shortcut autostart.
)

echo.
pause
