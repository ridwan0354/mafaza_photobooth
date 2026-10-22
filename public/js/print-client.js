// ============================================================================
// MAFAZA — PRINT CLIENT (dipakai Admin & Kiosk di Windows, MacBook, Android, iPad)
//
// Urutan cetak:
//  1) Print Agent aktif di komputer studio  -> cetak OTOMATIS sesuai pengaturan, tanpa popup
//  2) Server berjalan di komputer yang sama dengan printer -> langsung ke printer
//  3) Cadangan: dialog cetak browser dengan ukuran kertas sesuai pengaturan
//     (Chrome/Edge yang dibuka dengan --kiosk-printing akan mencetak tanpa dialog)
// ============================================================================
(function initMafazaPrintClient() {
  if (window.pbSmartPrint) return;

  const PAPERS = {
    '2x6': { w: 4, h: 6 },
    '4x6': { w: 4, h: 6 },
    '5x7': { w: 5, h: 7 },
    '6x8': { w: 6, h: 8 },
    'A4': { w: 8.27, h: 11.69 }
  };

  function ensureStyles() {
    if (document.getElementById('pb-print-client-styles')) return;
    const style = document.createElement('style');
    style.id = 'pb-print-client-styles';
    style.textContent = `
      .pb-print-toast {
        position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 20px);
        z-index: 1000000; max-width: min(92vw, 520px);
        background: #381E11; color: #FFFBF5; border: 2px solid #D4A754;
        padding: 12px 20px; border-radius: 999px; font-weight: 700; font-size: 14px; line-height: 1.4;
        box-shadow: 0 12px 32px rgba(56, 30, 17, 0.35); opacity: 0;
        transition: opacity .25s ease, transform .25s ease; text-align: center;
        font-family: inherit; pointer-events: none;
      }
      .pb-print-toast.pb-show { opacity: 1; transform: translate(-50%, 0); }
      .pb-print-toast.pb-warn { background: #7B482E; }
      .pb-print-toast.pb-error { background: #B3402F; border-color: #fff; }
    `;
    document.head.appendChild(style);
  }

  let toastTimer = null;
  function toast(message, kind = 'ok', ms = 4200) {
    ensureStyles();
    let el = document.getElementById('pbPrintToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pbPrintToast';
      document.body.appendChild(el);
    }
    el.className = 'pb-print-toast' + (kind === 'warn' ? ' pb-warn' : kind === 'error' ? ' pb-error' : '');
    el.textContent = message;
    requestAnimationFrame(() => el.classList.add('pb-show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('pb-show'), ms);
  }

  let cachedProfile = null;
  async function getProfile() {
    if (cachedProfile) return cachedProfile;
    try {
      const res = await fetch('/api/printers/profile');
      if (res.ok) cachedProfile = await res.json();
    } catch (e) {}
    return cachedProfile;
  }

  async function resolvePaper(job) {
    if (job && job.paperWidthIn && job.paperHeightIn) {
      return { w: job.paperWidthIn, h: job.paperHeightIn, borderless: job.borderless !== false };
    }
    const profile = await getProfile();
    const s = (profile && profile.settings) || {};
    const p = PAPERS[s.paperSize] || PAPERS['2x6'];
    return { w: p.w, h: p.h, borderless: s.borderless !== false };
  }

  // Dialog cetak browser (cadangan). Ukuran kertas dipaksa sesuai pengaturan lewat @page.
  async function printViaBrowser({ imageUrl, copies = 1, job = null }) {
    const paper = await resolvePaper(job);
    const src = (job && job.sheetUrl) ? `${job.sheetUrl}?t=${Date.now()}` : imageUrl;
    if (!src) {
      toast('File gambar tidak ditemukan untuk dicetak.', 'error');
      return;
    }

    let portal = document.getElementById('pbPrintPortal');
    if (!portal) {
      portal = document.createElement('div');
      portal.id = 'pbPrintPortal';
      document.body.appendChild(portal);
    }

    let pageStyle = document.getElementById('pbPageStyle');
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      pageStyle.id = 'pbPageStyle';
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = `@media print { @page { size: ${paper.w}in ${paper.h}in; margin: 0; } html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; } }`;

    const total = Math.max(1, parseInt(copies, 10) || 1);
    const fit = paper.borderless ? 'cover' : 'contain';
    portal.innerHTML = Array.from({ length: total }).map(() => `
      <div style="width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; page-break-after: always; break-after: page; overflow: hidden; background: #fff;">
        <img src="${src}" style="width: 100%; height: 100%; object-fit: ${fit}; display: block;" />
      </div>
    `).join('');
    document.body.classList.add('pb-printing');

    const img = portal.querySelector('img');
    const cleanup = () => {
      document.body.classList.remove('pb-printing');
      portal.innerHTML = '';
    };
    const doPrint = () => {
      setTimeout(() => {
        window.focus();
        window.print();
        if (job && job.printJobId) {
          fetch(`/api/print-jobs/${job.printJobId}/browser-printed`, { method: 'POST' }).catch(() => {});
        }
        setTimeout(cleanup, 1200);
      }, 200);
    };

    if (img.complete && img.naturalWidth > 0) {
      doPrint();
    } else {
      img.onload = doPrint;
      img.onerror = () => {
        cleanup();
        toast('Gagal memuat gambar untuk dicetak.', 'error');
      };
    }
  }

  // Titik masuk utama setelah job cetak dibuat di server.
  async function smartPrint(job, fallbackImageUrl = null, copies = null) {
    if (!job) {
      toast('Gagal membuat perintah cetak.', 'error');
      return { mode: 'error' };
    }
    const sheets = copies || job.copies || 1;
    const paperLabel = job.paperSize === '2x6' ? '2 strip / kertas 4×6' : (job.paperSize || '');

    if (job.dispatchedToOs) {
      toast(`🖨️ ${sheets} lembar langsung dikirim ke ${job.printerName || 'printer'} (${paperLabel})`);
      return { mode: 'direct' };
    }
    if (job.awaitingAgent) {
      toast(`🖨️ ${sheets} lembar dikirim ke printer studio • ${paperLabel} • tanpa popup`);
      return { mode: 'agent' };
    }

    toast('ℹ️ Print Agent belum aktif — memakai dialog cetak browser', 'warn', 3200);
    await printViaBrowser({ imageUrl: fallbackImageUrl, copies: sheets, job });
    return { mode: 'browser' };
  }

  window.pbToast = toast;
  window.pbSmartPrint = smartPrint;
  window.pbPrintViaBrowser = printViaBrowser;
})();
