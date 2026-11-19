# MAFAZA Android Kiosk 2.5.7

Satu APK mendukung **Kamera Bawaan Tablet** (depan/belakang), **kamera UVC/HDMI** yang dikenali Android, dan driver USB PTP untuk **Sony Alpha (ILCE-7M3, dll)**, **Canon EOS**, **Nikon**, serta kamera **PTP standar**.
Perbaikan live view, OpenSession fallback (`tid=0`/`tid=1`), reset USB PIMA, batas transfer streaming 64 MB & sinkronisasi shutter Sony (`0xC201`/`0xD215`), perbaikan unduhan JPEG Canon EOS 1300D (`0x911A PCHDDCapacity`, event `0xC186`/`0xC181`, transfer bertahap `0x9107 GetPartialObject` & skip RAW), sinkronisasi rotasi kamera + filter warna live di hasil foto (`usb-capture-guard.js`), dukungan ukuran kertas `4R`/`5R`/`A4` tanpa tepian pada bridge cetak Android (`MainActivity`), serta pengambilan foto disertakan dalam APK, termasuk saat halaman kiosk dari server belum diperbarui.

## Kabel dan kamera

| Kamera | Kabel ke Redmi Pad 2 | Pengaturan awal |
| --- | --- | --- |
| Sony A7 III | USB-C ke USB-C yang mendukung data | USB Connection: PC Remote; Ctrl w/ Smartphone: Off; **USB Power Supply: Off**; JPEG; Silent Shooting: Off untuk flash |
| Canon EOS 1300D | USB-C ke Mini-USB Mini-B data, atau adaptor USB-C OTG ke kabel USB-A/Mini-B | Wi-Fi/NFC: Disable; JPEG; mode foto |

Flash eksternal mengikuti shutter kamera melalui hot shoe. Kompatibilitas model
flash dan sinkronisasinya harus diperiksa pada perangkat nyata. Mulai uji flash
dengan shutter 1/125 detik dan tunggu flash siap sebelum foto berikutnya.

## Memasang dan mencoba

1. Pasang APK 2.5.7 sebagai pembaruan aplikasi lama. Tanda tangan tetap sama.
   Gunakan tombol **📸 Buka Mingle** di pojok kiri bawah APK untuk berpindah cepat ke `/mingle` (foto keliling 1× dengan tombol shutter fisik kamera Sony/Canon tanpa countdown).
2. Tanpa kabel USB, aplikasi langsung memakai kamera bawaan tablet tanpa terhalang status USB.
3. Cabut & colok ulang kabel data untuk menghubungkan kamera eksternal secara otomatis, dan izinkan akses USB jika Android memintanya.
4. Buka kamera di kiosk. Indikator USB menunggu gambar sebelum menampilkan status LIVE.
5. Coba beberapa pose berulang. Pastikan gambar tampil, shutter bekerja, hasil foto
   benar-benar baru, flash ikut terekam, dan live view kembali setelah memotret.
6. Ulangi dengan kamera lainnya, satu kamera terhubung pada satu waktu.

Mode kamera dengan flash menerima foto JPEG hasil shutter. Jika pengambilan foto
gagal, pose ditahan untuk dicoba lagi. Gambar preview tidak disimpan sebagai hasil
pengganti. Mode `webcam_only` tetap tersedia untuk pemakaian webcam secara eksplisit.

## Jika layar masih hitam

Ketuk indikator USB di kiri bawah untuk membuka dialog jumlah frame dan diagnostik.
Pilih **Salin Diagnostik** untuk menyalin laporan lengkap, termasuk operasi USB,
nomor transaksi, interface, endpoint, dan jumlah byte saat terjadi kegagalan.
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

Versi 2.5.7 menyinkronkan fitur web terbaru ke APK: `usb-capture-guard.js` menerapkan `cameraRotation` dan CSS filter live di `renderPhoto()` (dengan penanda rotasi agar tidak berputar ganda), menyinkronkan transformasi live view saat resolusi frame berubah, dan `MainActivity.printPageWithOptions()` mendukung kertas 4x6 (`NA_INDEX_4X6`), 5x7 (`MAFAZA_5R_5X7` / 5000x7000 mils), A4 (`ISO_A4`), lanskap, dan `Margins.NO_MARGINS`. Versi 2.5.6 memperbaiki Canon EOS 1300D yang memakan waktu lama lalu menampilkan error "Foto asli Canon belum diterima": menambahkan negosiasi kapasitas host `0x911A PCHDDCapacity`, menangkap event `0xC181 ObjectAddedEx` / multi-handle RAW+JPEG, serta mengunduh JPEG via `0x9107 GetPartialObject` (1 MB chunk) dengan fallback `0x1009`. Versi 2.5.5 menambahkan dukungan Mingle Booth (`/mingle`): tombol pindah Kiosk/Mingle di APK, deteksi shutter fisik langsung dari bodi kamera Sony A7 III & Canon EOS tanpa countdown, dan mode Viewfinder Optik Canon + Flash. Versi 2.5.4 memperbaiki Sony A7 III agar tidak restart saat memotret (batas streaming `0xFFFFFFFF` 64 MB, polling event Interrupt IN `0xC201` + properti `0xD215`, jeda baca sensor tanpa membanjiri `GetObjectInfo`, penanganan RAW+JPEG, serta `CloseSession` yang rapi). Versi 2.5.3 menyertakan kamera bawaan, OpenSession fallback `tid=0`/`tid=1`, Nikon/Fujifilm/PTP generik, UVC non-intrusif, dan buffer bulk 16 KB.

Referensi konektor dan pengaturan:
- [Sony A7 III: USB Connection](https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001629775.html)
- [Sony A7 III: Silent Shooting](https://helpguide.sony.net/ilc/1720/v1/en/contents/TP0001661969.html)
- [Canon EOS 1300D: kabel Mini-B](https://asia.canon/en/support/8202839900)
