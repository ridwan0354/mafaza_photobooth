# PhotoBooth SaaS Full System (V.02)

Platform SaaS komersial multi-tenant lengkap untuk bisnis penyewaan Photo Booth pada berbagai event (Wedding, Corporate Event, Birthday, dll).

Dilengkapi dengan:
- 🖥️ **Kiosk Touchscreen Windows:** Welcome screen fun & colorful, pose countdown, flash, live camera preview, pengolahan slot template hijau, dan cetak Epson.
- 🎨 **Smart Template Green-Area Auto Detection:** Deteksi otomatis region hijau (#00FF00) sebagai slot foto otomatis pada template PNG serta canvas drag-and-drop editor.
- 🎟️ **Universal Smart QR & Galeri Pengunjung:** 1 QR universal discan kamera booth untuk asosiasi sesi, dan discan kamera HP untuk membuka galeri pribadi tanpa login (multi-session support).
- 🖨️ **Pipa Cetak Epson:** Manajemen antrean cetak native spooler (Epson L8050 / SureLab D500), kontrol salinan cetak, dan reprint operator.
- 👑 **Super Admin Portal:** Verifikasi pembayaran transfer bank manual (preview bukti transfer, approve/reject), metrik MRR, kelola tenant, dan audit trail.
- 💼 **Business Admin Dashboard:** Wizard konfigurasi event, aktivasi mode (Strip, Single, Collage, GIF, Boomerang), batch QR card generator, dan analitik.
- 🛠️ **Operator Lapangan:** Preflight hardware checklist (kamera, printer, disk, network), antrean cetak real-time, dan PIN lock.
- ☁️ **Hybrid Offline-First:** Kiosk dapat beroperasi penuh tanpa internet; sinkronisasi otomatis berjalan saat terhubung kembali tanpa duplikasi data.

---

## Cara Menjalankan di Localhost

### 1. Jalankan Server
```bash
npm start
```
Server akan berjalan di: `http://localhost:3000`

### 2. URL Portal & Fitur Utama
| Portal / Halaman | URL Localhost | Keterangan |
| :--- | :--- | :--- |
| **Portal Switcher** | `http://localhost:3000/` | Pintu masuk utama & pemilih peran |
| **Kiosk Touchscreen** | `http://localhost:3000/kiosk` | Layar sentuh booth foto untuk tamu |
| **Business Admin** | `http://localhost:3000/admin` | Kelola event, template hijau, QR batch |
| **Operator Lapangan** | `http://localhost:3000/operator` | Preflight checklist, reprint, spooler |
| **Super Admin** | `http://localhost:3000/super` | Verifikasi transfer bank, metrik SaaS |
| **Galeri Tamu (Sample)** | `http://localhost:3000/gallery/g/gst_af33d39082bbd50e0d7d99a763fc89b5` | Galeri pribadi tanpa login + Share WhatsApp |

---

## Menjalankan Pengujian Otomatis (Test Suite)
Untuk menjalankan suite pengujian integrasi lengkap:
```bash
npm test
```
*Menguji isolasi multi-tenant, alur invoice transfer bank manual, deteksi slot hijau template, QR universal multi-session, spooler Epson, deduplikasi offline sync, dan izin AI studio.*
