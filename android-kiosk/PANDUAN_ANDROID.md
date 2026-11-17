# MAFAZA Android Kiosk 2.5.1

Satu APK menyediakan driver USB untuk Sony A7 III (ILCE-7M3) dan Canon EOS 1300D.
Perbaikan live view dan pengambilan foto disertakan dalam APK, termasuk saat halaman
kiosk dari server belum diperbarui. Pengoperasian halaman kiosk tetap memerlukan
server atau cache halaman yang sudah tersedia.

## Kabel dan kamera

| Kamera | Kabel ke Redmi Pad 2 | Pengaturan awal |
| --- | --- | --- |
| Sony A7 III | USB-C ke USB-C yang mendukung data | USB Connection: PC Remote; Ctrl w/ Smartphone: Off; JPEG; Silent Shooting: Off untuk flash |
| Canon EOS 1300D | USB-C ke Mini-USB Mini-B data, atau adaptor USB-C OTG ke kabel USB-A/Mini-B | Wi-Fi/NFC: Disable; JPEG; mode foto |

Flash eksternal mengikuti shutter kamera melalui hot shoe. Kompatibilitas model
flash dan sinkronisasinya harus diperiksa pada perangkat nyata. Mulai uji flash
dengan shutter 1/125 detik dan tunggu flash siap sebelum foto berikutnya.

## Memasang dan mencoba

1. Pasang APK 2.5.1 sebagai pembaruan aplikasi lama. Tanda tangan tetap sama.
2. Cabut kabel kamera, matikan lalu nyalakan kamera, dan buka aplikasi kembali.
3. Sambungkan kabel data dan izinkan akses USB jika Android memintanya.
4. Buka kamera di kiosk. Indikator USB menunggu gambar sebelum menampilkan status LIVE.
5. Coba beberapa pose berulang. Pastikan gambar tampil, shutter bekerja, hasil foto
   benar-benar baru, flash ikut terekam, dan live view kembali setelah memotret.
6. Ulangi dengan kamera lainnya, satu kamera terhubung pada satu waktu.

Mode kamera dengan flash menerima foto JPEG hasil shutter. Jika pengambilan foto
gagal, pose ditahan untuk dicoba lagi. Gambar preview tidak disimpan sebagai hasil
pengganti. Mode `webcam_only` tetap tersedia untuk pemakaian webcam secara eksplisit.

## Jika layar masih hitam

Ketuk indikator USB di kiri bawah untuk melihat jumlah frame dan diagnostik.
Jika sesi USB siap tetapi frame masih 0, cek mode USB dan sambungkan ulang kamera.
Tombol scan ulang membuka ulang sesi yang belum menerima gambar. Jika frame terus
bertambah tetapi gambar tidak tampil, catat pesan pada layar dan diagnostiknya.
Tekan lama indikator USB untuk membuka pengaturan URL server.

## Verifikasi pengembangan

```sh
python3 android-kiosk/tests/run-tests.py
node --test tests/android-kiosk.test.js
bash android-kiosk/build-apk.sh
```

Pengujian otomatis memakai simulasi paket USB dan tampilan kiosk. Pengujian ini
tidak menggantikan uji Redmi Pad 2, kabel, kamera, dan flash fisik.

Referensi konektor dan pengaturan:
- [Sony A7 III: USB Connection](https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001629775.html)
- [Sony A7 III: Silent Shooting](https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001661969.html)
- [Canon EOS 1300D: kabel Mini-B](https://asia.canon/en/support/8202839900)
