# HARDWARE COMPATIBILITY GUIDE — PHOTOBOOTH SAAS

## 1. Kamera (Camera Integration)
Aplikasi mendukung capture langsung melalui API WebCam UVC dan Native OS Adapter:
- **Webcam UVC / USB:**
  - Kompatibel dengan semua USB WebCam standard (Logitech Brio, C920, C922, Razer Kiyo, Anker PowerConf).
  - Resolusi direkomendasikan: 1080p (1920x1080) atau 4K.
  - Driver: Plug-and-play UVC standard Windows / macOS.
- **DSLR & Mirrorless Adapter:**
  - **Canon:** EOS Webcam Utility / EDSDK (Canon 200D II, M50, R50, 1500D).
  - **Sony:** Imaging Edge Webcam (Sony A6400, A6700, ZV-E10).
  - **Nikon:** Nikon Webcam Utility (Z30, Z50, D5600).
- **Kamera Virtual Simulator:**
  - Built-in simulator otomatis aktif jika tidak ada perangkat fisik yang terpasang untuk kemudahan pengujian CI/CD dan demo.

---

## 2. Printer (Epson Photo Printer Spooler)
Sistem dioptimalkan untuk lini printer foto **Epson**:
- **Model yang Teruji & Didukung:**
  - **Epson L8050** (6-warna EcoTank Photo Printer — standar industri photobooth).
  - **Epson L18050** (A3+ 6-warna EcoTank).
  - **Epson SureLab D500** (Dye Sublimation / Commercial Minilab).
  - **Epson L805 / L850** (Legacy series).
- **Format Kertas yang Didukung:**
  - **Photo Strip 2×6 inch** (Cetak 2 strip per lembar 4×6).
  - **Photo 4×6 inch (10×15 cm)**.
  - **Photo 5×7 inch**.
- **Spooler & Cut Mode:**
  - Kompatibel dengan Windows Print Spooler native.
  - Mendukung cetak borderless (tanpa tepi) sesuai setelan driver Epson.
  - Untuk printer tanpa auto-cutter, operator memotong manual menggunakan pemotong kertas (paper trimmer) 2x6.

---

## 3. Layar Sentuh & Kiosk Enclosure
- Rekomendasi: Layar Touchscreen capacitive 15.6 inch hingga 24 inch (Full HD 1920x1080).
- Mini PC / NUC: Intel Core i5 / i7 minimal 8GB RAM, SSD 256GB, Windows 10/11 Pro 64-bit.
