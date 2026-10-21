# OPERATOR'S MANUAL — PHOTOBOOTH SAAS LAPANGAN

Buku panduan operasional untuk staf / operator photobooth di lokasi acara.

---

## 1. Persiapan Sebelum Acara (Preflight Checklist)
Sebelum booth dibuka untuk tamu undangan, operator **wajib** membuka portal operator (`http://localhost:3000/operator`) dan memastikan hal-hal berikut:

1. **Uji Kamera Live:**
   - Klik tombol **"Uji Live"**.
   - Pastikan sudut pandang (angle) lurus, pencahayaan (lighting) cukup, dan live view tidak patah-patah.
2. **Uji Cetak Epson (Test Print):**
   - Klik tombol **"Test Print"**.
   - Pastikan printer Epson L8050 menyala, tinta penuh di tabung, dan kertas foto glossy terisi rapi.
   - Periksa apakah hasil cetakan tajam dan tidak bergaris (nozzle check normal).
3. **Penyimpanan Disk & Konektivitas:**
   - Periksa indikator status: pastikan sisa memori di atas 10 GB.
   - Bila internet di venue lemah/mati, jangan khawatir: booth dapat berjalan penuh secara **offline** dan akan otomatis sinkron saat internet kembali.

---

## 2. Mengoperasikan Kiosk Layar Sentuh
1. Buka layar booth di browser atau kiosk desktop: `http://localhost:3000/kiosk`.
2. Tekan tombol **F11** pada keyboard untuk masuk ke mode **Fullscreen**.
3. **Kunci Operator:**
   - Di pojok kanan atas layar booth terdapat tombol **"Operator Lock"**.
   - Untuk masuk ke panel operator atau mengubah pengaturan di tengah acara, klik tombol tersebut dan masukkan **PIN: 1234**.

---

## 3. Penanganan Masalah Lapangan (Troubleshooting)
- **Kamera Mati / Hitam:**
  Cabut kabel USB kamera, tancapkan kembali, lalu klik **"Reconnect Camera Feed"** di panel operator.
- **Kertas Epson Macet (Paper Jam):**
  Buka penutup atas printer Epson, keluarkan kertas yang macet secara perlahan searah alur keluar, tutup kembali, lalu klik **"Restart Printer Spooler"**.
- **Tamu Meminta Cetak Ulang (Reprint):**
  Buka `/operator`, cari ID sesi/waktu foto pada tabel antrean cetak, lalu klik tombol **"Reprint"**.
