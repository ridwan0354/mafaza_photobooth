# MASTER PROMPT — PHOTO BOOTH SAAS FULL SYSTEM

**Bahasa proyek:** Indonesia (UI juga mendukung English dan siap i18n).  
**Sasaran:** produk komersial multi-tenant yang benar-benar berjalan, bukan prototype atau kumpulan halaman statis.  
**Prioritas rilis awal:** aplikasi kiosk **Windows** + dashboard dan galeri berbasis **Web**.  
**Visi jangka panjang:** dukungan lintas platform melalui arsitektur adapter (macOS, Android, iPadOS, dan perangkat kompatibel lain), tanpa mengklaim dukungan hardware sebelum benar-benar diuji.

---

## 0. PERAN DAN INSTRUKSI UTAMA UNTUK AI CODING

Bertindaklah sebagai satu tim senior yang mencakup Product Architect, CTO, UI/UX Designer, Frontend Engineer, Backend Engineer, Desktop/Hardware Integration Engineer, Computer Vision Engineer, AI/ML Engineer, Database Architect, QA Automation Engineer, DevOps/SRE, dan Security/Privacy Engineer.

**Tugas:** BANGUN aplikasi lengkap bernama **PhotoBooth SaaS** (nama/brand dapat diubah dari konfigurasi) berdasarkan spesifikasi di bawah. Kode harus dapat dijalankan, komponen utama tersambung ke backend dan database yang nyata, dan setiap tombol mempunyai perilaku yang jelas. Jangan berhenti pada mockup, file desain, contoh data semu, atau rekomendasi arsitektur tanpa implementasi.

**Aturan eksekusi wajib:**
1. Anggap semua kebutuhan di dokumen ini sebagai scope **rilis lengkap pertama**. Jangan sepihak mengganti menjadi MVP kecil atau menghapus modul. Boleh mengimplementasikan internal dalam urutan dependency agar integrasi stabil, tetapi targetnya adalah satu produk dengan seluruh modul yang disebutkan.
2. Jangan pernah mengaku integrasi kamera DSLR, printer, pembayaran, AI, 360 booth, WhatsApp, AirDrop, atau mode offline sudah berfungsi bila masih memakai mock/placeholder. Tandai status masing-masing secara jujur: `implemented + tested`, `implemented + needs physical hardware test`, `adapter available but needs SDK/config`, atau `unsupported on this device`.
3. Pisahkan kemampuan berbasis browser dari kemampuan native OS. Gunakan native desktop agent/worker untuk operasi kamera khusus, printer, penyimpanan offline, dan kiosk mode yang tidak dapat dijamin oleh browser biasa.
4. Setiap fitur dapat diaktifkan/dinonaktifkan **per tenant, per event, dan bila relevan per perangkat**, disertai pembatasan entitlement menurut paket langganan.
5. Gunakan data nyata, validasi input, error handling, retry, idempotency, monitoring, audit log, dan testing. Jangan gunakan data sensitif yang hard-coded, credentials dalam source code, endpoint palsu, atau penyimpanan galeri publik tanpa kontrol akses.
6. Desain bawaan kiosk harus **fun & colorful**, sangat mudah digunakan dengan **touchscreen fullscreen**, tombol besar, animasi halus, dan aksesibilitas dasar. Dashboard bisnis dan super admin tampil **modern profesional**, namun seluruh tampilan mendukung tema/branding yang dapat dikustomisasi.
7. Buat dokumentasi instalasi, konfigurasi, cara menjalankan lokal, cara deploy cloud/self-hosted, cara menghubungkan kamera dan printer Epson, migrasi database, pengujian, troubleshooting, serta user manual super admin, business admin, dan operator.
8. Bila proyek tidak mungkin selesai dalam satu respons AI, lanjutkan implementasi secara terstruktur lintas respons. Jangan mengatakan “selesai” sampai acceptance criteria dan pemeriksaan akhir terpenuhi; berikan rincian blocker yang nyata.
9. Pilih dependensi, versi, dan SDK yang kompatibel serta diverifikasi saat implementasi. Hindari mengarang nama method vendor SDK atau menjanjikan kompatibilitas universal.

## 1. KONTEKS BISNIS DAN BATASAN YANG SUDAH DIPUTUSKAN

- Produk utama: software untuk **bisnis penyewaan Photo Booth pada event**.
- Model bisnis platform: **SaaS multi-tenant** yang dijual kepada bisnis Photo Booth lain.
- Tiga peran dashboard: **Super Admin** (pemilik platform), **Business Owner/Admin**, dan **Operator**. Tidak perlu dashboard terpisah untuk penyelenggara event pada scope awal.
- Bisnis dapat memiliki beberapa akun staf, event, perangkat, dan foto. RBAC granular.
- Monetisasi platform: **langganan bulanan**, **langganan tahunan**, dan **bayar per event**. BUKAN model transaksi utama per device atau kredit AI. Meski begitu paket dapat membatasi jumlah device/event/penyimpanan/akses AI dan penggunaan AI dicatat untuk kontrol biaya.
- Metode pembayaran langganan: **transfer bank manual** dengan unggah bukti, verifikasi super admin, status invoice, dan aktivasi/renewal otomatis sesudah **persetujuan admin**. Jangan memaksakan integrasi payment gateway/QRIS sebagai fitur wajib.
- Kiosk: utama **Windows desktop touchscreen fullscreen**. Web untuk dashboard, galeri, dan fungsi kamera web yang realistis. Mac, Android, iPad, dan platform lain menjadi target adapter lintas platform, tetapi dukungan hardware harus dinyatakan per platform.
- Kamera: dukung semua kamera **yang kompatibel secara teknis**, dimulai dari UVC webcam; sediakan adapter/extension point untuk Canon, Sony, Nikon, Fujifilm, dan kamera perangkat melalui driver/SDK yang sesuai.
- Printer utama: **Epson** melalui driver native Windows dan printer API/print spooler yang sesuai.
- Koneksi: **hybrid offline-first**; foto, kamera, template yang sudah dipasang, QR yang sudah diprovisi, dan cetak berjalan tanpa koneksi internet; sinkronisasi ke cloud saat terhubung.
- Mode: Single Photo, Photo Strip, Collage, GIF, Boomerang, Video Booth, dan 360 Booth (dengan rig/perangkat yang kompatibel). Seluruh mode bisa diaktifkan/dimatikan per event.
- Semua kemampuan pengambilan foto, filter/edit, AI, ukuran cetak dan sharing yang diminta harus tersedia secara modular, tergantung capability/hardware.
- Template: **upload PNG dengan area berwarna hijau sebagai slot foto otomatis**, editor drag-and-drop untuk koreksi manual, template per event, logo sponsor, dan pemilihan template oleh tamu. Ini **berbeda** dari green screen pengunjung.
- Smart QR: satu QR universal yang dapat di-scan oleh **kamera Photo Booth** untuk mengaitkan tamu/kelompok ke sesi; QR yang sama, bila dipindai HP, membuka **galeri pribadi tanpa login**. QR dapat dibuat massal oleh panitia, dari registrasi, maupun langsung pada booth; satu QR dapat dikaitkan ke banyak sesi.
- Alur sesudah capture: **preview dan pilihan cetak/download → tombol Selesai atau timer configurable → kembali ke Welcome Screen**.
- Tampilan guest gallery: download per foto dan share WhatsApp/media sosial. Multi-session gallery wajib karena QR dapat dipakai berulang. ZIP tidak menjadi kebutuhan utama.
- Semua fitur operasional operator, monitoring perangkat, analytics, storage, security, license, AI local/cloud, self-hosted/cloud, theme editor, dan recovery menjadi scope.
- Tidak perlu membangun modul booking pelanggan/kalender reservasi, dashboard event organizer khusus, ataupun payment gateway otomatis sebagai syarat rilis; ini tidak dipilih pengguna.

## 2. BLUEPRINT SISTEM DAN PILIHAN TEKNOLOGI

Bangun monorepo yang rapi dan mendukung shared types, shared business logic, typed APIs, tes lintas modul, serta rilis desktop/web. Rekomendasi awal yang bisa diganti **hanya bila ada alasan teknis yang terdokumentasi**:

- **Web dashboard + guest gallery:** Next.js + React + TypeScript, responsive, Tailwind CSS + component system berkualitas; PWA hanya untuk fungsi yang bisa didukung browser.
- **Windows kiosk app:** Electron + React + TypeScript (atau alternatif native yang setara **bila driver/SDK kamera-printer lebih cocok**). Aktifkan context isolation, minimal IPC, sandbox jika memungkinkan, signed release, auto-updater dengan rollback.
- **Local Agent/Device Service:** proses native/Node.js/opsional Rust/.NET untuk kamera, printer spooler Epson, FFmpeg/media processing, event cache, SQLite offline store, local file storage, job queue, sync engine, diagnosa hardware. Pisahkan UI renderer dari operasi privilese OS.
- **Backend API:** TypeScript dengan NestJS/Fastify atau framework typed sekelas; OpenAPI; WebSocket/SSE untuk notifikasi/progress realtime.
- **Database pusat:** PostgreSQL dengan Prisma atau migration tool sepadan; gunakan transaksi untuk operasi penting; pertimbangkan Row-Level Security bersama tenant scoping berlapis.
- **Storage objek:** S3-compatible untuk cloud dan MinIO untuk self-hosted; signed URL jangka pendek, private buckets, lifecycle retention. Media lokal disimpan aman sebelum sinkronisasi.
- **Redis + queue:** job AI, media render, email/notification, analytics aggregation, outbound uploads jika berlaku; gunakan worker, DLQ, retry backoff. Queue lokal harus tetap bekerja tanpa internet.
- **Pemrosesan media:** Sharp/libvips, OpenCV atau metode CV yang tervalidasi, FFmpeg, renderer berbasis canvas/ImageMagick/Skia yang menjaga konsistensi preview vs output print.
- **AI Provider abstraction:** dukungan provider cloud yang dikonfigurasi dan model lokal melalui runtime kompatibel. Pilih model sesuai tugas/perangkat; tidak mewajibkan satu vendor.
- **Auth:** sesi aman, MFA bagi admin opsional/diutamakan, RBAC; undangan operator; token perangkat terbatas; session rotation, reset password.
- **Observability:** structured logging dengan request/tenant/device IDs, tracing/metrics, health checks, crash report tersanitasi, status sync/print/camera realtime.
- **Infra:** Docker Compose untuk local/self-hosted, deployment cloud berbasis container, CI/CD, migration, backup/restore, TLS, dokumentasi secret management. Cloud dan self-hosted memiliki core code sama.

Contoh struktur monorepo:

```text
/apps
  /web               dashboard admin + gallery + API web-facing
  /kiosk-windows     Electron kiosk touchscreen
  /api               core API + auth + tenant/event/device management
  /workers           render, AI, uploads, notifications, cleanup
/packages
  /ui                shared components + theme tokens
  /domain            type/schema, permissions, rules, state machine
  /api-client        typed client generated from OpenAPI
  /media-engine      capture pipeline, render templates, GIF/video
  /camera-adapters   UVC/DSLR/plugin/simulator
  /printer-adapters  Epson/native print + simulator
  /qr-engine         token, scan, validation, guest association
  /sync-engine       local-first jobs, retry, reconciliation
  /config            config schemas and feature flags
/infra
  /docker
  /db/migrations
  /deploy
/docs
/tests
```

Tinjau dulu tradeoff monorepo/SDK, tetapkan final stack dalam `ARCHITECTURE.md`, lalu implementasikan. Jangan menyamakan “web di mobile” dengan dukungan app native untuk hardware khusus.

## 3. PERAN, MULTI-TENANCY, DAN HAK AKSES

### 3.1 Super Admin
- Ringkasan platform: tenant aktif, paket, MRR/pendapatan yang telah dikonfirmasi, invoice tertunda, perangkat aktif, pemakaian storage/AI, error kritis.
- CRUD tenant/business; status aktif, suspend, trial, reset akses, kontak owner, pembatasan resource.
- Paket: bulanan/tahunan/per-event, harga, fitur/entitlements, jumlah device, jumlah event, storage, concurrency dan limit AI, masa trial, grace period.
- Manajemen invoice, bukti transfer, review, approve/reject dengan alasan, catatan pembayaran, aktivasi/renewal idempotent, receipt.
- Monitoring seluruh device, dukungan remote diagnostic yang diotorisasi, health dan crash logs; tidak otomatis membuka foto tamu tanpa alasan/hak yang sah.
- Kelola brand default, feature flags global, konfigurasi layanan eksternal, audit keamanan, status jobs, backup/restore.
- Audit trail: actor, waktu, tenant, before/after jika perlu, IP dan device untuk peristiwa sensitif.

### 3.2 Business Owner/Admin
- Workspace sendiri, profil bisnis dan logo, user/operator dan hak akses, event, template, campaign branding, gallery policy.
- Manajemen satu atau banyak event aktif/terjadwal; konfigurasi per event; assign perangkat/operator; kapasitas dan lisensi.
- Daftar foto/media milik bisnis sendiri sesuai peran, filter event/tanggal/QR/sesi, status upload, status print, permintaan hapus.
- Statistik: sesi, media dibuat, pencetakan, scan QR, download, share yang dapat benar-benar diukur, estimasi storage, biaya/kuota AI; ekspor laporan CSV.
- Kelola subscription/invoice, transfer proof, status pembayaran, peringatan berakhir, trial.
- Pengaturan security, masa retensi, privasi dan persetujuan tamu, tema dashboard dan tema event.

### 3.3 Operator
- Hanya event/perangkat yang ditugaskan.
- Start/stop/pause kiosk, mengunci/membuka dengan PIN operator, inspeksi device/camera/printer/network.
- Retake ulang, reprint berbasis izin dan print limit, pencarian sesi via QR/waktu, kelola antrian print/retry/cancel.
- Resync, reupload gagal, clear error, restart komponen yang aman, diagnostics, notifikasi perangkat.
- Operator **tidak** dapat melihat data tenant lain, mengubah paket billing, membaca secret/API keys, atau menonaktifkan audit.

### 3.4 Tenant isolation
Tiap tabel domain memerlukan `tenant_id` bila relevan; lakukan tenant-scoped query di API dan DB; identitas session operator tidak boleh bisa mengganti `tenant_id` sembarang. Gunakan policy/automated tests untuk mencegah insecure direct object reference antar tenant, signed/private media, dan akses yang dibatasi event. Super admin cross-tenant mempunyai guard dan audit tersendiri.

## 4. MODUL EVENT DAN KONFIGURASI FITUR

Buat event dengan nama, waktu mulai/akhir, zona waktu, lokasi opsional, business, assigned kiosk/device, operator, branding, template, policy QR/galeri, print, kamera, media, AI, izin retake, durasi timeout dan data retention.

Fitur event admin:
- Mode-mode yang aktif: single, strip, collage, GIF, boomerang, video, 360; urutan/menu pilih mode.
- Countdown 3/5/10/custom, efek suara on/off + volume, flash screen, jumlah pose, interval antar pose, jumlah retake dan retry.
- Camera settings sesuai kemampuan device: live view, resolusi, autofocus/manual jika didukung, brightness/exposure/zoom/crop, orientasi, mirror preview versus output, aspect ratio.
- Pilihan template dan frame yang diizinkan, default template, sponsor watermark/logo, elemen warna/font/animasi.
- Printing enabled/disabled, auto/manual, jumlah copy default, copy maksimum per sesi/per QR, kertas, orientasi, borderless bila driver mendukung, batas antrian dan timeout.
- QR guest requirement: `required`, `optional`, atau `disabled`; hubungan QR dengan event dan jumlah sesi boleh berulang; masa berlaku.
- Gallery sharing: download dan share, watermark opsional, masa akses, privacy/consent; booth memilih preview → print/download → Done.
- Offline behavior dan auto-sync, max storage local, retry policy dan status availability.
- Setiap setting schema-validated, versioned, disinkronkan ke kiosk sebagai snapshot yang dapat dipakai offline; perubahan kritis tidak merusak sesi yang sedang berjalan.
- Sistem **feature toggles bertingkat**: global platform → subscription plan → tenant → event → device capability. Tampilkan alasan kenapa fitur disabled.

## 5. GUEST FLOW KIOSK TOUCHSCREEN

### 5.1 Default full flow
1. Welcome Screen fullscreen dengan tema **fun/colorful**, identitas event, logo sponsor, CTA **Mulai Foto**, dan indikator status ringkas untuk operator (tidak bocorkan detail teknis ke tamu).
2. Sesuai policy event, tampilkan layar **Scan QR**, **Lewati Scan** bila optional, atau langsung lanjut bila disabled. Pemindaian dilakukan menggunakan **kamera Photo Booth yang dipilih** (bukan wajib scanner USB). Sediakan decoding QR dari frame kamera; pause/resume live view selama scan; cegah pemrosesan QR ganda.
3. Validasi kode QR pada cache event offline atau server ketika online. Jika QR tidak dikenal/expired/salah event/tidak valid, tampilkan pesan yang sopan, tidak membocorkan data pribadi.
4. Pengunjung pilih mode yang event aktifkan serta frame/template yang diizinkan. Bila hanya satu mode/template, boleh auto-select.
5. Consent/privacy notice yang proporsional untuk kamera/foto/AI/unggah; persetujuan eksplisit untuk pemrosesan AI sensitif dan face swap bila digunakan.
6. Live preview, countdown, flash, capture sesuai pose dan interval; tombol retake jika diaktifkan, error recovery saat kamera putus.
7. Processing: filtering, background, template composition, AI bila dipilih dan tersedia; tampilkan progress dan fallback yang jelas jika AI cloud tidak bisa karena offline.
8. **Preview final**; aksi print, jumlah copy di dalam batas, download/QR/share sesuai fasilitas, pilih ulang/retake jika diizinkan.
9. Tombol **Selesai** dan **idle timeout yang dapat diatur admin**; setelah selesai atau timeout kembali ke **Welcome Screen** serta bersihkan media preview sementara/sesi UI agar pengunjung berikutnya tidak melihat sesi sebelumnya.
10. Foto/output dan metadata tersimpan aman secara lokal lalu sinkronisasi cloud, terasosiasi dengan QR guest bila ada.

### 5.2 State machine wajib
`IDLE → QR_CHECK (optional) → MODE_SELECT → TEMPLATE_SELECT → CONSENT → CAMERA_READY → COUNTDOWN → CAPTURE → REVIEW_POSES / RETAKE → PROCESSING → PREVIEW_FINAL → PRINT_OR_SHARE → COMPLETED → RESET → IDLE`.

Sertakan state `DEVICE_ERROR`, `CAMERA_RECONNECT`, `PRINTER_UNAVAILABLE`, `STORAGE_FULL`, `AI_UNAVAILABLE`, `OFFLINE`, dan `RECOVERY_PENDING`; buat transisi/guard yang diuji. Reset UI tidak boleh menghapus tugas upload/print persisten.

### 5.3 UX
- Fullscreen touch dengan kontras layak, target tombol besar, animasi tidak menghalangi penggunaan, loading/progress jelas, bahasa Indonesia default dan opsi English.
- Pergerakan antar layar cepat; data tamu sebelumnya tidak terlihat; opsi suara dapat dimatikan; pengaturan accessibility dasar.
- Admin/operator lock screen terpisah dengan PIN dan keyboard overlay jika diperlukan, tidak mengekspos layar manajemen ke tamu.

## 6. KAMERA, MODE MEDIA, DAN PENGOLAHAN

### 6.1 Camera abstraction
Definisikan antarmuka semisal `listDevices`, `getCapabilities`, `openPreview`, `capturePhoto`, `startVideo`, `stopVideo`, `setControls`, `healthCheck`, `close` dan event reconnect. Implementasikan adapter webcam UVC nyata untuk Windows; sediakan adapter Canon/Sony/Nikon/Fujifilm sebagai plugin berbasis SDK yang valid dan dibatasi capability, dengan status dukungan jelas. Bila SDK vendor tidak tersedia saat build, buat integrasi interface + error/capability disclosure dan pekerjaan validasi hardware; **jangan menulis fake implementation yang dilabeli selesai**.

Preview bisa tampil live dari kamera; capture pakai resolusi still terbaik yang didukung, jangan sekadar screenshot preview bila native capture tersedia. Kelola orientasi/mirror, color profile, metadata foto, timeout dan reinitialize kamera; dukung simulasi kamera virtual untuk CI.

### 6.2 Mode output
- **Single:** satu foto ke frame/template.
- **Strip:** pose sebanyak yang diatur per template/event, layout 2×6/4×6, slot bernomor dan label opsional.
- **Collage:** layout grid/custom dengan auto-crop yang aman.
- **GIF:** rangkaian foto/video jadi animated GIF dengan durasi/frame rate dan ukuran terkontrol.
- **Boomerang:** clip forward + reverse tanpa loop jump yang kasar.
- **Video Booth:** rekam video pendek dengan durasi/format/branding; pertimbangkan audio consent.
- **360:** integrasi dengan rig, turntable/camera motion atau input sequence yang kompatibel; hardware-dependent. Jangan mengganti 360 sesungguhnya dengan GIF biasa tanpa memberi penjelasan. Jika hardware tidak kompatibel, tampilkan tidak tersedia dan kemampuan yang diperlukan.

Semua mode mempunyai pipeline preview, rendering output, gallery, statistik, retensi, monitoring, dan sharing yang sesuai format. Gunakan worker background agar kiosk UI tidak freeze.

### 6.3 Editing yang diminta
Filter B&W/vintage/cinematic/color preset; beauty/skin smoothing non-destruktif; brightness/contrast/saturation; stiker/emoji/teks; background removal; green screen pengunjung; configurable before/after. Simpan original jika policy mengizinkan dan final output dengan metadata versi efek.

## 7. SMART TEMPLATE GREEN-AREA AUTO DETECTION + EDITOR

Ini adalah fitur prioritas tinggi. **Area hijau pada file template adalah penanda slot foto**, BUKAN perintah untuk menghapus latar belakang orang.

### 7.1 Upload dan deteksi otomatis
1. Admin mengunggah PNG template (dengan atau tanpa alpha), validasi ukuran/file, dimensi/resolusi, warna RGB/alpha.
2. Sistem menampilkan preview dan mendeteksi **region hijau solid / chroma placeholder** dengan threshold/toleransi warna yang dapat diubah. Pertimbangkan variasi antialiasing, green shades, connected components, holes, adjacency, noise, bentuk rect/non-rect, dan area minimum.
3. Setiap region terdeteksi menjadi `photo_slot` dengan `id`, `mask`, `bounding_box`, `rotation`, `z_index`, `crop_mode`, `pose_index`, `shape`, `aspect_ratio`, `transform`, `confidence`.
4. Overlay region terdeteksi; admin bisa **terima, hapus, tambah slot manual, resize, drag, rotate, urutkan pose, edit crop, atur tolerance/warna referensi, undo/redo, snap-to-grid**.
5. Saat render, **photo slot menggantikan area hijau secara tepat menurut mask**, tidak menyisakan green fringe. Template foreground/elemen logo tidak tertimpa oleh foto. Support clipping dan rotation.
6. Template yang gagal dideteksi tidak boleh merusak data; fallback ke editor manual dengan info penyebab.
7. Preview menggunakan test photo dan output hi-res final harus konsisten. Buat regression fixtures untuk template 1, 2, 3, 4, 6 slot; tepi hijau antialias; area hijau kecil/dekoratif; slot bersentuhan; area non-persegi; PNG transparan.

### 7.2 Editor profesional
- Workspace canvas drag-and-drop dengan zoom/pan, snap/alignment, guides, layer list dan lock/unlock, ordering depan/belakang.
- Add/move/resize/rotate photo slot, teks, stiker, QR opsional, background, frame, sponsor logo; pilihan font dan tema.
- Preset layout, ukuran standar 2×6, 4×6, 5×7, square, digital, custom pixel/mm/inchi; DPI misalnya 300 untuk print jika hardware mendukung.
- Versioning/template draft → preview → publish; hanya template published yang diberikan ke event; version snapshot agar event lama tidak mendadak berubah.
- Tetapkan template per event dan guest template selection; admin bisa preview dari kiosk/resolusi media dan proof print.

## 8. SMART QR UNIVERSAL DAN GALERI PRIBADI

### 8.1 QR design
Gunakan **satu QR universal berbentuk HTTPS URL** seperti `https://domain-galeri.example/g/<opaque_random_token>`; URL/domain hanyalah contoh konfigurasi, bukan hard-coded production. Token menggunakan CSPRNG dengan entropi memadai, bukan ID urut/email/nomor telepon. Simpan hash token dan mapping aman bila memungkinkan.

- **Kamera Photo Booth** memindai QR, memvalidasi domain dan format, membaca token, mencari `guest_pass`, lalu mengasosiasikan sesi yang baru dibuat dengan `guest_pass_id` dan event/tenant yang benar.
- **Kamera HP** memindai QR yang sama; browser membuka halaman galeri pribadi tanpa login. URL bertindak seperti bearer capability: akses hanya jika memegang QR/link, sehingga lindungi dari index mesin pencari, referer leak, caching publik, enumeration, logs dan analytics pihak ketiga.
- QR bisa dibuat: (a) batch oleh panitia untuk dicetak/dibagikan, (b) via registrasi, (c) langsung saat sesi di kiosk. Untuk opsi (c), kode yang dibuat kiosk langsung di-attach ke sesi sehingga **tidak perlu memindai layar kiosk dengan kamera kiosk sendiri**; tampilkan kode ke tamu untuk disimpan/scan HP.
- QR yang sama dapat menyimpan **banyak sesi** sesuai policy event, memberi daftar foto/output dari semua sesi terkait.
- Pisahkan QR event-level dan QR guest-level dengan benar; QR dari event lain tidak boleh mengakses/menyuntikkan sesi tenant lain. Sediakan reissue/revoke/expiry per event yang dapat diatur walau akses guest default tanpa login/PIN.
- Barcode/QR dibaca dengan **kamera Booth** sebagai metode wajib. Jangan menjadikan scanner USB requirement.

### 8.2 Galeri pengunjung
- Mobile-first, ringan, fun/colorful mengikuti branding event; terbuka tanpa akun dengan scan QR.
- Tampilkan foto/video/GIF tiap sesi dan tanggal, thumbnail + preview, progress upload bila sinkronisasi belum selesai, status “foto sedang diproses/menunggu koneksi” bila relevan.
- **Download satu foto/media** dan **Share via WhatsApp atau media sosial** menggunakan native Web Share API jika didukung atau share URL sesuai platform. Jangan menjanjikan upload langsung ke akun media sosial tanpa izin/API resmi.
- Tampilkan informasi retensi dan cara meminta penghapusan data sesuai kebijakan privasi.
- Tidak perlu fitur ZIP sebagai persyaratan utama.
- Gunakan signed delivery URL atau mediated access; server memvalidasi guest capability sebelum mengakses object, bukan bucket publik. Batasi rate, cegah brute force, URL tidak diindeks, no sensitive tokens in referral/third-party logs.

### 8.3 Offline-first QR yang realistis
- Pre-provision/batch guest passes yang sudah dikaitkan ke event serta disinkronkan ke kiosk; scan valid secara lokal selama offline.
- QR baru dapat dibuat offline dengan secure IDs dan disinkronkan kemudian, bila izin konfigurasi sesuai. Atur collision/conflict dengan aturan deterministik.
- Foto tersimpan lokal dan upload queued; galeri di HP **tidak dapat menampilkan foto baru yang belum tersinkron ke server** saat booth offline. Jelaskan status tersebut, jangan menjanjikan keajaiban offline dari internet.
- Sinkronisasi ulang aman, idempotent, tidak menghasilkan duplicate photo/sessions; manual operator action untuk stuck jobs.

## 9. PRINTER EPSON DAN PRINT PIPELINE

- Native discovery printer Epson dari printer terpasang di Windows; baca capabilities yang benar-benar tersedia lewat OS/driver (paper sizes, printable area, orientation, duplex/borderless jika ada), status spooler/koneksi sejauh didukung driver.
- Konfigurasi printer default per kiosk/event, cetak otomatis/manual, ukuran, orientasi, copy, print limit, quality/DPI, borderless/border sesuai driver, crop/fit, bleed/safe area.
- Dukungan format 2×6, 4×6, 5×7, square/custom melalui pemilihan ukuran media fisik yang sesuai; bila perlu 2×6 dalam media 4×6, buat layout potong sesuai kemampuan printer/operator. Jangan mengklaim auto-cut bila printer Epson tidak punya cutter.
- WYSIWYG: preview output digital, proof layout printable area dan final render tidak terpotong salah.
- Print spooler persisten dengan `print_job_id`, session, photo, printer, copies, status `queued/processing/spooled/completed/failed/cancelled`, attempts, spooler_job_id bila OS menyediakan, retries dan error reason.
- Perlu dibedakan `sent_to_spooler` dari `physically_printed`: status final akurat sebatas yang diungkap driver. Tidak boleh otomatis menganggap kertas sudah keluar saat OS baru menerima job.
- Operator dapat reprint, cancel, retry, pilih printer lain jika memenuhi policy; jumlah cetak dihitung dan dilog dengan anti-duplikasi.
- Implementasi nyata minimal pada Epson via driver Windows dan print API yang kompatibel; printer simulator untuk CI serta panduan hardware acceptance test di printer fisik.

## 10. AI STUDIO: CLOUD + LOCAL

Arsitektur modul AI harus dapat dinyalakan/dimatikan per event, plan dan perangkat, dengan model fallback. Fitur:
1. AI background replacement.
2. AI face enhancement / portrait retouch sesuai persetujuan.
3. AI cartoon / anime style.
4. AI studio portrait.
5. AI face swap (wajib consent orang yang gambarnya diproses, cegah penyalahgunaan, kebijakan konten/moderasi dan kontrol operator; jangan diam-diam mengirim face image ke layanan cloud).
6. AI generative photo dengan tema custom, input aman, moderasi konten.
7. Pengukuran penggunaan AI per provider, model, tenant, event, session, status, estimasi biaya, error, latency.

Implementasikan adapter `AiProvider`, pemilihan cloud/local sesuai koneksi, GPU/CPU capability dan policy; job asynchronous + progress status. Jika offline dan model lokal tidak terpasang/kompatibel, tampilkan fitur unavailable atau fallback ke foto non-AI; jangan membuat UI macet. Cegah pengiriman ke cloud bila user/event belum memberikan consent sesuai kebijakan. Simpan request/result metadata yang tidak memuat foto sensitif di log. Dokumentasikan vendor terms dan data handling.

## 11. LISENSI, SUBSCRIPTION, DAN TRANSFER BANK MANUAL

- Paket `monthly`, `yearly`, `per_event`; set period/expiry, trial, grace period, entitlements (max devices/events/storage/AI/access modes).
- Buat invoice dengan unique reference, nominal IDR, rekening bank tujuan yang dikonfigurasi admin, tanggal jatuh tempo, bukti transfer upload, status `draft/pending_payment/submitted/under_review/approved/rejected/expired/cancelled`.
- Admin memeriksa bukti; `approve` mengaktifkan/memperpanjang license dengan transaksi database dan audit, mencegah double activation. `reject` mempunyai alasan dan opsi submit ulang.
- Tampilkan warning 30/14/7/1 hari atau jadwal configurable; mekanisme masa tenggang offline yang terukur, cache entitlement yang ditandatangani, proteksi manipulasi jam lokal yang masuk akal.
- Device activation dan pairing tenant/event; batas device berdasarkan plan, bukan penjualan lisensi per device sebagai tarif utama.
- SaaS dipisahkan total antara billing platform dan transaksi cetak tamu. Pengunjung event tidak wajib membayar.

## 12. OFFLINE SYNC, STABILITAS, DAN RECOVERY

Local Agent memegang local SQLite/event snapshot, encrypted sensitive metadata, local media spool, offline QR mapping, config/license cache, upload queue dan print queue. Tiap job punya UUID, payload checksum, idempotency key, attempt count, next retry, last error, state.

- Ketika internet hilang: preview/capture/filter offline/template render/print Epson/QR yang telah tersedia tetap bekerja, jika hardware dan disk cukup. Fitur AI cloud dan galeri online terbaru ditunda atau diganti lokal.
- Ketika internet kembali: urutan sinkronisasi guest pass → session metadata → media original/final upload → gallery indexing → analytics event; gunakan resumable upload untuk file besar, checksum, unique job key, backoff/jitter, dedup, dan konflik versi.
- Restart/crash recovery: UI dapat memulai sesi baru bila aman; jangan menghapus hasil lama, antrean print, atau upload. Pulihkan atau tandai sesi setengah jalan sesuai state machine.
- Disk quota/low storage guardrails, corruption detection, camera reconnect, printer offline notification, watchdog restart terkontrol, rate limiting job dan queue observability.
- Remote settings hanya berlaku saat menerima versi event terbaru; change activation atomik, audit dan rollback jika rusak.
- Implementasikan telemetry yang menjaga privasi dan dashboard status per device: last seen, app version, camera/printer, network, disk, print queue, sync lag, crash count, current event.

## 13. DASHBOARD, TEMA, DAN ANALITIK

### Dashboard Super Admin
Overview SaaS, tenant management, plans/subscriptions, invoices/verifikasi transfer, device global, AI usage/cost, storage, audit, alerts, global configuration, backup/health.

### Dashboard Business Admin
Overview bisnis, event manager, settings event wizard dan advance panel, brand/theme builder, template editor, staff/operator & roles, devices/pairing, media library, QR batch generator/registration, QR mapping, print history, AI configuration, usage/plan/invoice, analytics, privacy/storage settings.

### Dashboard Operator
Assigned event overview, kiosk launch/lock/PIN, hardware preflight checklist, camera preview test, printer test print, queue/failed jobs, reprint, retry sync, session search by QR/time, network/storage warnings, diagnostics.

### Theme builder
- Theme default: guest kiosk **fun & colorful**, business/super dashboard **professional**.
- Admin bisa mengedit colors, gradients, typography, button shape, background, image, logos, sponsor, welcome screen, animations, iconography, sounds, screen messages, watermark, gallery theme.
- Real-time preview desktop/mobile/kiosk, save draft/publish, theme versioning, reset presets, WCAG-informed contrast, isolate tenant/event CSS supaya tidak memengaruhi bisnis lain.

### Analytics
Count exact sessions, media outputs by type, photo attempts vs successes, print jobs/copies/status, QR issued/scanned, QR-linked sessions, gallery views/downloads dan share clicks **sejauh event instrumented dapat mengukur**, active devices, uptime, failures, storage, AI jobs/cost, langganan dan revenue yang sudah terverifikasi. Gunakan time-zone event, filters per date/event/device/operator, export CSV; definisikan events/taxonomy untuk menghindari double-count akibat retry/offline sync. Jangan mengklaim share ke WhatsApp berhasil terkirim hanya dari klik tombol.

## 14. SKEMA DATABASE MINIMAL (BOLEH DIPERLUAS)

Buat migrations, constraints, foreign keys, indexes, tenancy checks dan seed non-production. Entitas minimal:

**Identitas/tenancy**
- `users(id, email, password_hash/oauth_ref, status, created_at, updated_at)`
- `tenants(id, name, slug, brand_config_id, status, created_at)`
- `memberships(id, tenant_id, user_id, role, status, invited_by)`
- `roles`, `permissions`, `role_permissions` (atau policy ekuivalen)
- `auth_sessions`, `audit_logs`, `security_events`

**SaaS / billing**
- `plans(id, billing_type, price, currency, entitlements_json, active)`
- `subscriptions(id, tenant_id, plan_id, status, starts_at, ends_at, trial_until, grace_until)`
- `invoices(id, tenant_id, subscription_id, amount, unique_reference, status, due_at)`
- `payment_proofs(id, invoice_id, private_storage_key, uploaded_by, review_status, reviewer_id, reviewed_at, reason)`
- `device_activations(id, tenant_id, device_id, subscription_id, activated_at, revoked_at)`

**Operasi event**
- `events(id, tenant_id, name, starts_at, ends_at, status, timezone, config_version, config_json)`
- `event_staff`, `event_devices`, `devices(id, tenant_id, hardware_id_hash, platform, status, last_seen_at, app_version, capabilities_json)`
- `device_health`, `device_commands`, `device_config_snapshots`
- `templates(id, tenant_id, event_id?, name, status, width, height, dpi, current_version_id)`
- `template_versions(id, template_id, image_storage_key, slots_json, layers_json, version, published_at)`
- `themes`, `theme_versions`, `event_branding`

**QR / sesi / media**
- `guest_passes(id, tenant_id, event_id, opaque_token_hash, status, issued_via, expires_at, revoked_at, created_at)`
- `guest_pass_batches`, `guest_registrations` (minimal data, consent)
- `photo_sessions(id, tenant_id, event_id, device_id, guest_pass_id?, mode, status, started_at, ended_at, local_session_id, config_snapshot_id)`
- `captures(id, photo_session_id, pose_index, original_storage_key?, timestamp, status)`
- `media_assets(id, tenant_id, event_id, photo_session_id, type, variant, storage_key, checksum, size_bytes, width, height, status, created_at)`
- `media_ai_jobs`, `media_render_jobs`, `gallery_access_events`, `gallery_download_events`, `share_click_events`
- `privacy_consents`, `deletion_requests`, `retention_policies`, `data_deletion_jobs`

**Print, sync, monitoring**
- `printer_profiles`, `print_jobs(id, tenant_id, event_id, device_id, photo_session_id, media_asset_id, copies, state, spooler_job_id?, idempotency_key, created_at)`
- `sync_jobs`, `sync_attempts`, `offline_conflicts`, `notifications`, `device_errors`, `analytics_events`, `ai_usage_records`

Aturan: `tenant_id` konsisten dan tervalidasi, indeks sesuai pola query (tenant/event/time, guest pass, device, job status), token rahasia tidak tersimpan plaintext di log. Gunakan UTC di backend + timezone event di UI. Retention/cascade delete diselaraskan dengan kewajiban audit yang sah dan prinsip minimisasi data.

## 15. API DAN REALTIME CONTRACT

Definisikan API typed dan dokumentasi OpenAPI. Contoh endpoint (sesuaikan versi/route framework):

```text
POST   /auth/login
POST   /auth/logout
POST   /auth/invitations
GET    /me
GET    /super/overview
GET    /super/tenants
POST   /super/tenants
PATCH  /super/tenants/:id
GET    /super/plans
POST   /super/plans
GET    /super/invoices
POST   /super/invoices/:id/approve
POST   /super/invoices/:id/reject
GET    /tenants/:id/overview
GET    /events
POST   /events
GET    /events/:id
PATCH  /events/:id
POST   /events/:id/publish-config
GET    /events/:id/analytics
GET    /devices
POST   /devices/pair
GET    /devices/:id/health
POST   /devices/:id/commands
GET    /templates
POST   /templates/upload
POST   /templates/:id/detect-green-slots
PATCH  /templates/:id/versions/:versionId
POST   /templates/:id/publish
POST   /guest-passes/batch
POST   /guest-passes/register
POST   /guest-passes/issue
POST   /kiosk/qr/resolve
POST   /kiosk/sessions
PATCH  /kiosk/sessions/:id
POST   /kiosk/media/signed-upload
POST   /kiosk/sync/batch
GET    /gallery/g/:token
GET    /gallery/g/:token/media/:id/download
POST   /gallery/g/:token/share-click
GET    /print-jobs
POST   /print-jobs/:id/retry
POST   /print-jobs/:id/cancel
POST   /print-jobs/:id/reprint
POST   /ai/jobs
GET    /ai/jobs/:id
POST   /subscriptions/invoices/:id/proof
GET    /privacy/requests
POST   /privacy/requests
GET    /audit-logs
```

`GET /gallery/g/:token` di atas adalah ilustrasi route; jangan masukkan token ke server logs atau analytics URL mentah. Implementasi API media dapat berbasis authenticated bearer capability dan signed short-lived delivery. WebSocket/SSE channels untuk kiosk device status, upload progress, AI job, print queue, subscription notice. AuthZ diuji per route; device token scope ke tenant/device/event; endpoint idempotent yang relevan memakai idempotency keys.

## 16. HALAMAN DAN KOMPONEN UI YANG HARUS DIBANGUN

**Super Admin:** Login, dashboard, tenants list/detail/create/edit/suspend, plans/pricing, subscriptions, invoice proofs approval, device fleet, AI usage, system settings, audit/security, service health, backups.

**Business Admin:** Login/onboarding, business settings, staff/invitations/roles, dashboard, events list/new/detail/event setup wizard, assign devices/operators, kiosk config, modes toggles, camera/print/AI options, guest QR settings, QR batch and export print sheet, templates list/editor/preview/publish, themes/branding, gallery/media library, session search, print logs, devices/monitoring, reports, subscription/invoices/upload proof, retention/security/privacy settings.

**Operator:** Login, assigned events, kiosk start/stop, PIN lock, preflight wizard, camera test, Epson test print, print queue, reprint, live session monitor, retry upload, hardware health, diagnostics/error history.

**Kiosk touchscreen:** Welcome, QR scanner, QR creation/distribution option, mode chooser, template chooser, consent, live camera preview, countdown, capture progress, retake, processing, AI status, preview final, print/download/share, thank-you/timeout, error screens, offline status, operator unlock/PIN.

**Guest gallery mobile:** Loading/validating token, private gallery multi-session, media detail/lightbox, download, WhatsApp/share, gallery sync pending message, expired/revoked state, privacy information/request contact.

Setiap page wajib loading/empty/error/success states dan keyboard/screen-reader support yang masuk akal. Buat reusable design components (modal confirm, notifications, form validation, gallery grid, printable preview, camera preview, printer status, QR scanner, chart, table filters). Jangan tinggalkan tombol dekoratif.

## 17. KEAMANAN, PRIVASI, DAN RELIABILITY

- HTTPS/TLS, least privilege, session security, secure password hashing (argon2id atau setara), RBAC, tenant isolation, audit, CORS/CSRF sesuai arsitektur, anti-XSS, CSP pada Electron/web, safe IPC, file upload scanning/validation, S3 private, signed URLs, rate limits.
- Token QR seperti password akses galeri: kriptografis acak, tidak mudah ditebak, expire/revoke, tidak masuk logs/referrer, `noindex`, private caching, brute-force protection. Tidak meminta login tamu karena requirement akses langsung melalui QR.
- Persetujuan dan informasi privasi untuk foto, AI cloud, face swap, penggunaan untuk promosi bila ada; dukung kebijakan retensi per event/tenant, penghapusan foto otomatis, data export / request deletion yang sesuai ketentuan berlaku termasuk UU Perlindungan Data Pribadi Indonesia bila relevan.
- Operator/admin yang memperoleh akses foto dibatasi oleh izin, sesuai kebutuhan event; hapus data di local cache maupun cloud secara konsisten ketika retention/deletion berjalan; metadata billing/audit disimpan menurut kebijakan hukum berbeda dari media pribadi.
- Upload proof transfer harus private, validasi MIME/signature file serta malware checks sesuai infrastuktur.
- Offline SQLite/secret/device credentials terlindungi, secure OS keystore bila tersedia. Backup database + object store, restore drill, disaster recovery doc.
- Product telemetry minimisasi data; error report tidak menampilkan foto wajah atau token QR.

## 18. PERFORMANCE DAN OPERASIONAL EVENT

- Target UX responsif: navigasi kiosk tidak terhambat rendering AI/upload/print; job pipeline terpisah.
- Event dengan banyak tamu: concurrency control kamera hanya 1 capture session per device kecuali hardware multi-camera mendukung, multiple devices per event, queues aman.
- Media rendering menghasilkan kualitas dan dimensi yang dapat diprediksi; thumbnail terpisah, progressive gallery loading, lazy load.
- Batasi penggunaan RAM/disk lokal, spooler dan background render; alert disk low dan fallback error yang dapat dipulihkan.
- Device health pings dan status bergantung waktu; jangan menampilkan “online” berdasar cache stale.
- Preflight checklist: login/license/event sync, camera preview+capture test, printer test (model Epson/driver/paper status), storage available, QR test, internet/cloud link, template proof, media output and photo print test.

## 19. TEST STRATEGY DAN PENERIMAAN (TIDAK BOLEH DILEWATI)

Siapkan unit, integration, E2E, hardware compatibility, offline chaos testing, visual regression, security tests, load tests dan test reports. Gunakan camera/printer simulators untuk CI **serta** tandai test hardware fisik yang masih harus dilakukan.

### Minimal acceptance scenarios
1. Super admin membuat tenant, memberi trial/plan dan hak akses; tenant B tidak bisa melihat data tenant A melalui UI/API/URL objek.
2. Business admin membuat event, mengatur enabled modes + countdown/retake/template/theme/AI/QR/printer; app kiosk menerima config version.
3. Operator pairing kiosk Windows, melihat kamera live, capture nyata dengan webcam, pilih template, mem-print ke Epson via driver Windows dengan status queue yang akurat.
4. Admin upload PNG dengan tiga bidang hijau; sistem mendeteksi ketiganya, admin drag/resize, mapping pose 1–3, output final tepat dan tidak ada tepi hijau berlebihan.
5. Event wajib QR: tamu bawa QR panitia, kiosk camera decode, validasi guest pass, foto masuk sesi QR tersebut; QR HP membuka galeri tanpa login.
6. Tamu memakai QR sama dua kali: galeri berisi hasil kedua sesi setelah sinkronisasi.
7. Event QR optional: tamu boleh foto tanpa QR; foto tidak terasosiasi ke akun QR yang salah.
8. Offline: kiosk capture/cetak sukses pada config & QR cached, upload queue menunggu. Saat online lagi tidak ada sesi/media duplikat dan foto muncul di galeri HP.
9. Foto final preview → pengunjung klik cetak/download → Selesai atau habis timer → welcome screen bersih, tidak menampakkan foto tamu sebelumnya.
10. Epson unavailable: kiosk menampilkan status print gagal, tetap menyimpan foto, operator dapat retry/reprint setelah printer pulih.
11. Gambar warna, beauty, green screen pengunjung, AI local dan AI cloud masing-masing menunjukkan output asli/final dan fallback error yang nyata; catat cost/usage.
12. GIF, boomerang, video menghasilkan file valid dan dapat diunduh/dibagikan di galeri dengan preview sesuai dukungan browser.
13. Mode 360 tidak ditawarkan sebagai “ready” tanpa rig compatible; capability detection dan integrasi hardware yang ada diperiksa.
14. Admin setup plan bulanan/tahunan/per-event; tenant mengunggah bukti transfer, super admin approve, subscription berubah satu kali dan audit tercatat.
15. Perangkat tidak bisa menggunakan fitur di luar entitlement; trial/expired/grace state diuji online dan offline.
16. Crash/restart saat capture/print/upload tidak menghilangkan jobs persisten; reprocessing tidak menduplikasi cetak secara sembarangan.
17. Galeri token invalid/expired/revoked menunjukkan status tepat; enumeration atau akses tenant lain gagal; foto tersimpan private.
18. Retention policy menghapus foto yang melewati masa simpan dari cloud dan storage lokal sesuai lifecycle; legal audit tetap konsisten.
19. Event switching dan theme updates tidak merusak sesi yang sedang berlangsung.
20. Statistik print/download/share tidak double count akibat retry dan menjelaskan keterbatasan pengukuran share.

### Deliverables QA
- Matriks requirement → modul → endpoint/UI → test case → bukti.
- Test suite command (`lint`, `typecheck`, `test`, `e2e`, `build`) berjalan dengan output terdokumentasi.
- `HARDWARE_COMPATIBILITY.md`: tested camera models, Epson printer models/drivers, OS build, SDK requirements, limitation.
- `RELEASE_READINESS.md`: selesai, butuh pengujian fisik, known issues, security review, upgrade path.

## 20. FILE OUTPUT DAN DOKUMENTASI

Buat repository yang memuat:
- Kode aplikasi web, kiosk Windows, backend, workers, device services dan shared packages.
- `.env.example` lengkap tanpa credentials asli; database migrations/seed; konfigurasi Redis/S3/MinIO; Docker Compose, scripts init, contoh deployment.
- `README.md` yang memberi perintah instalasi dan menjalankan end-to-end untuk developer baru.
- `ARCHITECTURE.md` dengan diagram komponen, data flow, network/offline flow, threat model dan adapter boundaries.
- `PRODUCT_REQUIREMENTS.md`, `DATA_MODEL.md`, `API_SPEC.yaml`, `DESIGN_SYSTEM.md`, `EVENT_CONFIGURATION_SCHEMA.md`.
- `OFFLINE_SYNC.md`, `QR_SECURITY.md`, `EPSON_PRINTING.md`, `CAMERA_INTEGRATION.md`, `AI_PROVIDER_GUIDE.md`, `PRIVACY_POLICY_TEMPLATE.md` (ditinjau legal sebelum digunakan), `OPERATORS_MANUAL.md`, `DEPLOYMENT.md`, `RUNBOOK.md`.
- Tes otomatis, fixtures template hijau, virtual camera/printer harness, screenshot/UI test artifacts bila tersedia.
- Installer Windows yang sesuai lingkungan build, installer/service setup dan updater yang aman; jika environment belum memungkinkan signing/packaging, nyatakan requirement spesifik tanpa mengarang binary final.

## 21. URUTAN KERJA AI CODING

**Jangan hanya membuat roadmap dan berhenti.** Langsung lakukan pekerjaan dalam urutan berikut sambil menjaga bahwa cakupan akhirnya tetap **FULL SYSTEM**:

**Langkah 1 — Audit dan keputusan teknis:** Bila repo sudah ada, periksa seluruh folder/konfigurasi dahulu agar tidak merusak pekerjaan. Tampilkan stack terpilih, diagram sistem, daftar potensi SDK/hardware blockers, dan requirement coverage matrix.

**Langkah 2 — Fondasi nyata:** Monorepo, auth, RBAC, tenant isolation, database migrations, billing transfer manual, event models, theme system, storage, queues, observability, shared API contracts.

**Langkah 3 — Aplikasi fungsional:** Web dashboards lengkap tiga peran, event configuration, template canvas & green detection, Smart QR issuance/scan/galeri, kiosk capture pipeline, printer Epson native adapter, media/video engine, offline sync, AI local/cloud adapters, monitoring.

**Langkah 4 — Integrasi end-to-end:** Dari buat tenant → bayar manual → buat event → pairing Windows kiosk → foto → render template → print Epson → galeri QR → laporan → retensi, dengan mode offline diuji.

**Langkah 5 — Quality gate:** Unit/e2e/hardware checks, security audit, performance, crash recovery, concurrency, deployment cloud/self-hosted, manuals, acceptance matrix.

**Format laporan progres saat menulis kode:** sebut file yang dibuat/diubah, fitur nyata yang berfungsi, cara menjalankan, hasil tests, dependency/hardware test yang belum bisa diverifikasi, dan langkah selanjutnya. Jangan menyamakan scaffold, pseudocode, mock, dan integrasi nyata. Jika output model terbatas, lanjutkan pembangunan dalam respons lanjutan tanpa menghapus requirement.

## 22. KONSISTENSI ANTAR KEBUTUHAN — JANGAN DILANGGAR

1. **Windows + Web sejak rilis pertama**; platform lain disiapkan lewat adapter bukan janji kompatibilitas palsu.
2. **Printer Epson**, print auto/manual, jumlah copy, print queue/reprint, native OS driver.
3. **Semua mode dapat di-toggle per event**, termasuk AI; 360 bergantung rig.
4. **PNG placeholder hijau = deteksi slot foto + koreksi drag-and-drop**, bukan hanya removal background orang.
5. **QR universal: Booth scan via kamera, HP scan untuk gallery tanpa login**, QR bisa batch/registrasi/on-the-spot dan reuse multi-session.
6. **Kiosk fullscreen touchscreen, fun/colorful**, dashboard modern, tema dapat diedit semuanya.
7. **Selesai sesi: preview → cetak/download → auto return dengan timer configurable atau tombol Selesai**.
8. **Hybrid offline-first** dengan local-first capture/print, sync saat online, jujur tentang keterlambatan galeri cloud.
9. **Super Admin + Business Owner/Admin + Operator**, dengan izin pengguna granular; tanpa event organizer dashboard khusus.
10. **Billing bulanan/tahunan/per-event + transfer manual**; jangan ganti jadi payment gateway otomatis.
11. **Full-scope first release**, bukan demo atau MVP, namun semua dependensi dan hardware diuji bertahap secara bertanggung jawab.
12. **Self-hosted maupun cloud**, multi-tenant aman, lisensi dan subscription terkelola.

## 23. OUTPUT PERTAMA YANG HARUS KAMU BERIKAN KEPADA SAYA

Mulailah dengan:
1. Ringkasan pemahaman proyek dan daftar modul final (tanpa mengubah keputusan).
2. Arsitektur konkret dan stack final beserta alasan integrasi kamera/print Windows.
3. ERD/data model inti, desain API/IPC, offline sync diagram, state machine kiosk, keamanan QR.
4. Daftar layar dan alur user berdasarkan tiga peran.
5. Struktur repository serta perintah setup/run/test/deploy.
6. Requirement coverage matrix semua fitur dan identifikasi SDK/hardware yang perlu diverifikasi.
7. **Kemudian LANGSUNG buat kode nyata** dan jalankan test/check yang dapat dilakukan dalam lingkungan coding yang tersedia. Lanjutkan sampai semua modul terintegrasi dan tidak ada tombol fiktif.

Jika ada detail implementasi yang belum ditentukan (misalnya model kamera/Epson, provider AI, domain, server cloud), gunakan konfigurasi environment, adapter dan simulator **untuk pengembangan**, serta dokumentasikan syarat production. Jangan menghalangi pembangunan hanya karena merek/model belum disebutkan, dan jangan menyatakan perangkat fisik sudah teruji tanpa tes nyata.

**MULAI BANGUN PHOTO BOOTH SAAS FULL SYSTEM SEKARANG.**
