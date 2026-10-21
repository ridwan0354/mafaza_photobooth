# ARCHITECTURE & SYSTEM BLUEPRINT — PHOTOBOOTH SAAS FULL SYSTEM

## 1. Ringkasan Arsitektur
PhotoBooth SaaS Full System dirancang dengan pendekatan modular, hybrid offline-first, dan multi-tenant. Sistem memisahkan komponen antarmuka touchscreen (Kiosk), backend API & database pusat, manajemen perangkat keras lokal (kamera & printer Epson), serta galeri pengunjung berbasis token (Universal Smart QR).

```text
+-----------------------------------------------------------------------------------+
|                              PHOTOBOOTH SAAS PLATFORM                             |
+-----------------------------------------------------------------------------------+
                                          |
        +---------------------------------+---------------------------------+
        |                                 |                                 |
        v                                 v                                 v
+-----------------------+     +-----------------------+     +-----------------------+
|  SUPER ADMIN PORTAL   |     | BUSINESS ADMIN PORTAL |     |  GUEST MOBILE GALLERY |
|  - MRR & Revenue      |     | - Event Config Wizard |     | - No-Login QR Access  |
|  - Manual Bank Verify |     | - Green Slot Canvas   |     | - Multi-Session List  |
|  - Tenant & Plans     |     | - Batch QR Generation |     | - 1-Click WhatsApp    |
|  - Audit Security     |     | - Epson Print Monitor |     | - HD Photo Download   |
+-----------------------+     +-----------------------+     +-----------------------+
        |                                 |                                 |
        +---------------------------------+---------------------------------+
                                          | REST API / WebSocket
                                          v
+-----------------------------------------------------------------------------------+
|                               CORE BACKEND ENGINE                                 |
|  - Multi-Tenant Isolation (RBAC)                                                  |
|  - Manual Bank Transfer Workflow & Invoicing                                      |
|  - Universal Smart QR Engine (CSPRNG Tokens & Hashes)                             |
|  - Smart Template Chroma Detection & Composition Pipeline                         |
|  - Epson Print Spooler State Machine (queued -> processing -> spooled -> printed) |
|  - Offline Sync Reconciliation Engine (Idempotency Key Deduplication)            |
|  - AI Studio Consent & Filter Engine                                              |
+-----------------------------------------------------------------------------------+
                                          |
        +---------------------------------+---------------------------------+
        |                                                                   |
        v                                                                   v
+-----------------------+                                         +-----------------------+
|   DATABASE (SQLite)   |                                         |   KIOSK BOOTH (Win)   |
|  - 23 Tables          |                                         |  - Touchscreen UI     |
|  - Foreign Key Rel    | <==== Offline Local Cache & Sync =====> |  - Camera (UVC/DSLR)  |
|  - Tenant Scoped Idx  |                                         |  - Epson L8050 Driver |
|  - Audit Trail        |                                         |  - Operator PIN Lock  |
+-----------------------+                                         +-----------------------+
```

---

## 2. Aliran Data Offline-First (Offline Sync Engine)
1. **Penyimpanan Lokal:** Ketika koneksi internet terputus di venue acara, Kiosk tetap dapat melakukan live preview, countdown, foto, komposisi template, dan cetak ke printer Epson.
2. **Antrean Pekerjaan (Job Queue):** Setiap sesi foto dan aset media lokal diberi `idempotency_key` unik deterministik (UUID + timestamp).
3. **Rekonsiliasi Otomatis:** Saat sinyal internet kembali stabil, Worker Sync mengirim batch data ke endpoint `/api/kiosk/sync/batch`. Backend memastikan tidak ada duplikasi sesi atau cetak ganda.

---

## 3. Pipa Cetak Epson (Epson Print Spooler Pipeline)
Sistem berinteraksi dengan printer photo Epson (misal Epson L8050, L18050, atau SureLab D500) melalui Windows Print Spooler API:
- Status State Machine: `queued` ➔ `processing` ➔ `spooled` ➔ `completed` (atau `failed` jika kehabisan kertas/tinta).
- Operator dapat melakukan **Reprint** secara terkontrol dengan pencatatan audit log otomatis untuk mencegah pemborosan kertas foto.

---

## 4. Keamanan Smart QR Universal
- Token URL galeri dibuat menggunakan CSPRNG dengan entropi 128-bit (`gst_` + 16 byte hex), disimpan dalam bentuk hash SHA-256 di basis data.
- **Kamera Kiosk:** Memindai QR untuk mengaitkan tamu ke sesi foto yang sedang berlangsung.
- **Kamera HP Tamu:** Memindai QR yang sama langsung membuka `/gallery/g/:token` tanpa login.
- **Multi-Session:** 1 QR dapat digunakan berulang kali selama acara. Semua foto dari berbagai sesi akan terkumpul dalam galeri yang sama.
