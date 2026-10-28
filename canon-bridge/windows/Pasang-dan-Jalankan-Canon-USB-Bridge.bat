@echo off
title Mafaza Photobooth - Pasang Canon USB Bridge (Windows)
color 0b
cd /d "%~dp0"

echo ======================================================================
echo    MAFAZA PHOTOBOOTH - PEMASANG CANON USB BRIDGE (WINDOWS 10 / 11)   
echo ======================================================================
echo.

echo [1/3] Mengonfigurasi Izin Chrome dan Edge (Local Network Access)...
reg add "HKCU\Software\Policies\Google\Chrome" /v InsecurePrivateNetworkRequestsAllowed /t REG_DWORD /d 1 /f >nul 2>&1
reg add "HKCU\Software\Policies\Google\Chrome\LocalNetworkAccessAllowedForUrls" /v 1 /t REG_SZ /d "https://mafaza.galipatsistem.com" /f >nul 2>&1
reg add "HKCU\Software\Policies\Google\Chrome\LocalNetworkAccessAllowedForUrls" /v 2 /t REG_SZ /d "http://localhost:3000" /f >nul 2>&1
reg add "HKCU\Software\Policies\Google\Chrome\LocalNetworkAccessAllowedForUrls" /v 3 /t REG_SZ /d "http://127.0.0.1:3000" /f >nul 2>&1
reg add "HKCU\Software\Policies\Microsoft\Edge\LocalNetworkAccessAllowedForUrls" /v 1 /t REG_SZ /d "https://mafaza.galipatsistem.com" /f >nul 2>&1
reg add "HKCU\Software\Policies\Microsoft\Edge\LocalNetworkAccessAllowedForUrls" /v 2 /t REG_SZ /d "http://localhost:3000" /f >nul 2>&1
reg add "HKCU\Software\Policies\Microsoft\Edge\LocalNetworkAccessAllowedForUrls" /v 3 /t REG_SZ /d "http://127.0.0.1:3000" /f >nul 2>&1
echo [OK] Kebijakan browser berhasil diperbarui.

echo.
echo [2/3] Memeriksa dan Menyiapkan Bridge Executable (.NET Framework)...
set CSC=
if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
    set CSC="%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
) else if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
    set CSC="%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if exist "MafazaCanonBridge.exe" del /f /q "MafazaCanonBridge.exe" >nul 2>&1

if not defined CSC (
    echo [PERINGATAN] csc.exe tidak ditemukan di direktori Windows .NET.
) else (
    echo Mengompilasi MafazaCanonBridge.cs...
    %CSC% /nologo /target:exe /out:MafazaCanonBridge.exe /platform:anycpu MafazaCanonBridge.cs
    if exist "MafazaCanonBridge.exe" (
        echo [OK] Berhasil mengompilasi MafazaCanonBridge.exe!
    )
)

echo.
echo [3/3] Menjalankan Mafaza Canon USB Bridge di Port 19898...
echo.
echo ======================================================================
echo  PETUNJUK PENTING:
echo  1. Pastikan aplikasi 'EOS Webcam Utility' atau 'EOS Utility' DITUTUP
echo     agar kabel USB kamera Canon tidak terkunci / sibuk.
echo  2. Sambungkan kabel USB dari Kamera Canon EOS ke port USB Laptop/PC.
echo  3. Putar dial kamera ke mode M / Av / Tv lalu nyalakan kamera.
echo  4. Jendela ini harus tetap terbuka selama Kiosk Photobooth berjalan.
echo     (Atau jalankan 'Pasang-AutoStart-Windows.bat' agar jalan di background)
echo ======================================================================
echo.

if exist "MafazaCanonBridge.exe" (
    MafazaCanonBridge.exe
) else (
    echo [ERROR] Gagal menjalankan MafazaCanonBridge.exe.
    pause
)
