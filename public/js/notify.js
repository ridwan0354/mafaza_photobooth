// ============================================================================
// WARM PLAYFUL RETRO — CUSTOM NOTIFICATION & CONFIRMATION MODAL SYSTEM
// Replaces all ugly native browser alert() / confirm() / prompt() dialogs
// ============================================================================

(function initWarmRetroNotificationSystem() {
  if (window.__pbNotifyInitialized) return;
  window.__pbNotifyInitialized = true;

  function ensureNotifyStyles() {
    if (document.getElementById('pb-retro-notify-styles')) return;
    const style = document.createElement('style');
    style.id = 'pb-retro-notify-styles';
    style.textContent = `
      .pb-notify-backdrop {
        position: fixed;
        inset: 0;
        z-index: 999999;
        background: rgba(38, 21, 14, 0.52);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        opacity: 0;
        transition: opacity 0.22s ease;
      }
      .pb-notify-backdrop.pb-visible {
        opacity: 1;
      }
      .pb-notify-card {
        position: relative;
        width: 100%;
        max-width: 460px;
        background: #FFFBF5;
        border: 3px solid #EAD8C7;
        border-radius: 28px;
        padding: 28px 26px 24px;
        box-shadow: 0 24px 60px rgba(38, 21, 14, 0.32), 0 0 0 6px rgba(255, 251, 245, 0.25);
        text-align: center;
        font-family: 'Poppins', -apple-system, BlinkMacSystemFont, sans-serif;
        color: #381E11;
        transform: scale(0.9) translateY(14px);
        transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
        overflow: hidden;
      }
      .pb-notify-backdrop.pb-visible .pb-notify-card {
        transform: scale(1) translateY(0);
      }
      .pb-notify-top-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 14px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        margin-bottom: 14px;
      }
      .pb-notify-type-success .pb-notify-top-pill {
        background: rgba(39, 174, 96, 0.14);
        color: #1e8449;
        border: 1.5px solid rgba(39, 174, 96, 0.35);
      }
      .pb-notify-type-warning .pb-notify-top-pill {
        background: rgba(230, 120, 107, 0.16);
        color: #c0392b;
        border: 1.5px solid rgba(230, 120, 107, 0.4);
      }
      .pb-notify-type-info .pb-notify-top-pill {
        background: rgba(212, 167, 84, 0.2);
        color: #7B482E;
        border: 1.5px solid rgba(212, 167, 84, 0.45);
      }
      .pb-notify-icon-ring {
        width: 68px;
        height: 68px;
        border-radius: 50%;
        margin: 0 auto 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 34px;
        position: relative;
        box-shadow: 0 10px 24px rgba(123, 72, 46, 0.12);
        animation: pbIconPop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      @keyframes pbIconPop {
        0% { transform: scale(0.4) rotate(-12deg); opacity: 0; }
        100% { transform: scale(1) rotate(0deg); opacity: 1; }
      }
      .pb-notify-type-success .pb-notify-icon-ring {
        background: linear-gradient(135deg, #E8F8F0 0%, #D1F2EB 100%);
        border: 3px solid #5F8F8A;
      }
      .pb-notify-type-warning .pb-notify-icon-ring {
        background: linear-gradient(135deg, #FDEDEC 0%, #FADBD8 100%);
        border: 3px solid #E6786B;
      }
      .pb-notify-type-info .pb-notify-icon-ring {
        background: linear-gradient(135deg, #FEF9E7 0%, #FCF3CF 100%);
        border: 3px solid #D4A754;
      }
      .pb-notify-title {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 21px;
        font-weight: 800;
        color: #7B482E;
        line-height: 1.3;
        margin: 0 0 10px;
      }
      .pb-notify-message {
        font-size: 14.5px;
        font-weight: 600;
        color: #5A3A28;
        line-height: 1.55;
        margin: 0 0 18px;
      }
      .pb-notify-details-box {
        background: #FDF7F0;
        border: 2px solid #EAD8C7;
        border-radius: 16px;
        padding: 12px 16px;
        margin: 0 0 18px;
        text-align: left;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .pb-notify-detail-row {
        font-size: 13px;
        font-weight: 600;
        color: #4A2C1B;
        line-height: 1.45;
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .pb-notify-detail-dot {
        color: #E6786B;
        font-weight: 900;
        flex-shrink: 0;
      }
      .pb-notify-actions {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin-top: 4px;
      }
      .pb-notify-btn {
        padding: 11px 28px;
        border-radius: 999px;
        font-family: 'Poppins', sans-serif;
        font-size: 14px;
        font-weight: 800;
        cursor: pointer;
        border: 2px solid transparent;
        transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .pb-notify-btn-primary {
        background: #E6786B;
        color: #FFFFFF;
        box-shadow: 0 6px 18px rgba(230, 120, 107, 0.38);
        min-width: 160px;
      }
      .pb-notify-btn-primary:hover {
        background: #D96557;
        transform: translateY(-2px) scale(1.02);
        box-shadow: 0 10px 24px rgba(230, 120, 107, 0.5);
      }
      .pb-notify-btn-secondary {
        background: #FDF7F0;
        color: #7B482E;
        border-color: #EAD8C7;
      }
      .pb-notify-btn-secondary:hover {
        background: #FFFFFF;
        border-color: #7B482E;
      }
      .pb-notify-close-x {
        position: absolute;
        top: 14px;
        right: 14px;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 1.5px solid #EAD8C7;
        background: #FDF7F0;
        color: #7B482E;
        font-size: 14px;
        font-weight: 800;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .pb-notify-close-x:hover {
        background: #E6786B;
        color: #FFFFFF;
        border-color: #E6786B;
      }
      .pb-notify-progress-wrap {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 5px;
        background: rgba(234, 216, 199, 0.45);
        overflow: hidden;
      }
      .pb-notify-progress-bar {
        height: 100%;
        width: 100%;
        background: linear-gradient(90deg, #E6786B, #D4A754, #5F8F8A);
        transform-origin: left center;
        transition: transform linear;
      }
    `;
    document.head.appendChild(style);
  }

  function parseMessageMeta(rawText) {
    const str = String(rawText ?? '').trim();
    const lines = str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    // Detect leading emoji if present
    const emojiMatch = str.match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}✅🎉🖨️🍎📲⚠️❌ℹ️📷🗑️🔄✨🔒🎟️]+)/u);
    let icon = emojiMatch ? emojiMatch[1] : '✨';

    const lower = str.toLowerCase();
    let type = 'info';
    let badgeText = 'Notifikasi Sistem';

    if (
      str.startsWith('✅') ||
      str.startsWith('🎉') ||
      str.startsWith('🖨️') ||
      str.startsWith('🍎') ||
      str.startsWith('📲') ||
      lower.includes('berhasil') ||
      lower.includes('sukses') ||
      lower.includes('siap') ||
      lower.includes('aktif')
    ) {
      type = 'success';
      badgeText = str.startsWith('🖨️') ? 'Antrean Cetak Printer' : 'Berhasil Disimpan';
      if (!emojiMatch) icon = '✅';
    } else if (
      str.startsWith('❌') ||
      str.startsWith('⚠️') ||
      lower.includes('gagal') ||
      lower.includes('error') ||
      lower.includes('salah') ||
      lower.includes('silakan') ||
      lower.includes('pilih') ||
      lower.includes('belum') ||
      lower.includes('terblokir')
    ) {
      type = 'warning';
      badgeText = lower.includes('gagal') || lower.includes('error') ? 'Perhatian Sistem' : 'Info Pengisian';
      if (!emojiMatch) icon = '⚠️';
    } else {
      type = 'info';
      badgeText = 'Informasi Photobooth';
    }

    // Strip leading emoji from first line so it doesn't duplicate the big icon ring
    const stripLeadingEmoji = (s) => s.replace(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}✅🎉🖨️🍎📲⚠️❌ℹ️📷🗑️🔄✨🔒🎟️]+)\s*/u, '');

    let title = '';
    let subtitle = '';
    let detailRows = [];

    if (lines.length <= 1) {
      const cleaned = stripLeadingEmoji(lines[0] || str);
      if (cleaned.length <= 58) {
        title = cleaned;
        subtitle = '';
      } else {
        title = type === 'success' ? 'Berhasil Diproses!' : (type === 'warning' ? 'Mohon Perhatian' : 'Informasi');
        subtitle = cleaned;
      }
    } else {
      title = stripLeadingEmoji(lines[0]);
      const rest = lines.slice(1);
      rest.forEach(line => {
        const cleanedLine = line.replace(/^[•\-*]\s*/, '');
        detailRows.push(cleanedLine);
      });
    }

    return { type, icon, badgeText, title, subtitle, detailRows };
  }

  function escapeSafe(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let activeBackdrop = null;
  let activeAutoTimer = null;

  window.showAppNotify = function showAppNotify(message, options = {}) {
    ensureNotifyStyles();

    if (activeBackdrop) {
      try { activeBackdrop.remove(); } catch (e) {}
      activeBackdrop = null;
    }
    if (activeAutoTimer) {
      clearTimeout(activeAutoTimer);
      activeAutoTimer = null;
    }

    const meta = parseMessageMeta(message);
    const type = options.type || meta.type;
    const icon = options.icon || meta.icon;
    const badgeText = options.badge || meta.badgeText;
    const title = options.title || meta.title;
    const subtitle = options.subtitle !== undefined ? options.subtitle : meta.subtitle;
    const detailRows = options.detailRows || meta.detailRows;
    const autoCloseMs = options.autoCloseMs !== undefined
      ? options.autoCloseMs
      : (detailRows.length > 2 ? 6500 : 4000);

    const backdrop = document.createElement('div');
    backdrop.className = `pb-notify-backdrop pb-notify-type-${type}`;

    const detailsHtml = detailRows.length > 0
      ? `<div class="pb-notify-details-box">
          ${detailRows.map(r => `
            <div class="pb-notify-detail-row">
              <span class="pb-notify-detail-dot">•</span>
              <span>${escapeSafe(r)}</span>
            </div>
          `).join('')}
        </div>`
      : '';

    const subtitleHtml = subtitle
      ? `<p class="pb-notify-message">${escapeSafe(subtitle)}</p>`
      : '';

    backdrop.innerHTML = `
      <div class="pb-notify-card" role="dialog" aria-modal="true">
        <button type="button" class="pb-notify-close-x" title="Tutup">✕</button>
        <div class="pb-notify-top-pill">${escapeSafe(badgeText)}</div>
        <div class="pb-notify-icon-ring">${icon}</div>
        <h3 class="pb-notify-title">${escapeSafe(title)}</h3>
        ${subtitleHtml}
        ${detailsHtml}
        <div class="pb-notify-actions">
          <button type="button" class="pb-notify-btn pb-notify-btn-primary" id="pbNotifyOkBtn">
            Oke, Mengerti ✓
          </button>
        </div>
        ${autoCloseMs > 0 ? `
          <div class="pb-notify-progress-wrap">
            <div class="pb-notify-progress-bar" id="pbNotifyProgressBar"></div>
          </div>
        ` : ''}
      </div>
    `;

    document.body.appendChild(backdrop);
    activeBackdrop = backdrop;

    const closePopup = () => {
      if (activeAutoTimer) {
        clearTimeout(activeAutoTimer);
        activeAutoTimer = null;
      }
      backdrop.classList.remove('pb-visible');
      document.removeEventListener('keydown', keyHandler);
      setTimeout(() => {
        try { backdrop.remove(); } catch (e) {}
        if (activeBackdrop === backdrop) activeBackdrop = null;
      }, 220);
    };

    const keyHandler = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        closePopup();
      }
    };
    document.addEventListener('keydown', keyHandler);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closePopup();
    });
    const okBtn = backdrop.querySelector('#pbNotifyOkBtn');
    const closeX = backdrop.querySelector('.pb-notify-close-x');
    if (okBtn) okBtn.addEventListener('click', closePopup);
    if (closeX) closeX.addEventListener('click', closePopup);

    requestAnimationFrame(() => {
      backdrop.classList.add('pb-visible');
      if (okBtn) okBtn.focus();
      const bar = backdrop.querySelector('#pbNotifyProgressBar');
      if (bar && autoCloseMs > 0) {
        bar.style.transitionDuration = `${autoCloseMs}ms`;
        requestAnimationFrame(() => {
          bar.style.transform = 'scaleX(0)';
        });
      }
    });

    if (autoCloseMs > 0) {
      activeAutoTimer = setTimeout(closePopup, autoCloseMs);
      const card = backdrop.querySelector('.pb-notify-card');
      if (card) {
        card.addEventListener('mouseenter', () => {
          if (activeAutoTimer) {
            clearTimeout(activeAutoTimer);
            activeAutoTimer = null;
          }
          const bar = backdrop.querySelector('#pbNotifyProgressBar');
          if (bar) {
            bar.style.transitionDuration = '0ms';
            bar.style.transform = 'scaleX(1)';
          }
        });
      }
    }
  };

  window.showAppConfirm = function showAppConfirm(message, options = {}) {
    ensureNotifyStyles();
    return new Promise((resolve) => {
      if (activeBackdrop) {
        try { activeBackdrop.remove(); } catch (e) {}
        activeBackdrop = null;
      }

      const backdrop = document.createElement('div');
      backdrop.className = 'pb-notify-backdrop pb-notify-type-warning';
      backdrop.innerHTML = `
        <div class="pb-notify-card" role="dialog" aria-modal="true">
          <button type="button" class="pb-notify-close-x" title="Batal">✕</button>
          <div class="pb-notify-top-pill">Konfirmasi Tindakan</div>
          <div class="pb-notify-icon-ring">${options.icon || '🗑️'}</div>
          <h3 class="pb-notify-title">${escapeSafe(options.title || 'Konfirmasi')}</h3>
          <p class="pb-notify-message">${escapeSafe(message)}</p>
          <div class="pb-notify-actions">
            <button type="button" class="pb-notify-btn pb-notify-btn-secondary" id="pbConfirmCancelBtn">
              ${escapeSafe(options.cancelText || 'Batal')}
            </button>
            <button type="button" class="pb-notify-btn pb-notify-btn-primary" id="pbConfirmOkBtn">
              ${escapeSafe(options.confirmText || 'Ya, Lanjutkan ✓')}
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(backdrop);
      activeBackdrop = backdrop;

      const finish = (result) => {
        backdrop.classList.remove('pb-visible');
        setTimeout(() => {
          try { backdrop.remove(); } catch (e) {}
          if (activeBackdrop === backdrop) activeBackdrop = null;
          resolve(result);
        }, 200);
      };

      backdrop.querySelector('#pbConfirmCancelBtn').addEventListener('click', () => finish(false));
      backdrop.querySelector('.pb-notify-close-x').addEventListener('click', () => finish(false));
      backdrop.querySelector('#pbConfirmOkBtn').addEventListener('click', () => finish(true));
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) finish(false);
      });

      requestAnimationFrame(() => {
        backdrop.classList.add('pb-visible');
        backdrop.querySelector('#pbConfirmOkBtn').focus();
      });
    });
  };

  window.showAppPrompt = function showAppPrompt(message, defaultValue = '', options = {}) {
    ensureNotifyStyles();
    return new Promise((resolve) => {
      if (activeBackdrop) {
        try { activeBackdrop.remove(); } catch (e) {}
        activeBackdrop = null;
      }

      const backdrop = document.createElement('div');
      backdrop.className = 'pb-notify-backdrop pb-notify-type-info';
      backdrop.innerHTML = `
        <div class="pb-notify-card" role="dialog" aria-modal="true">
          <button type="button" class="pb-notify-close-x" title="Batal">✕</button>
          <div class="pb-notify-top-pill">Input Informasi</div>
          <div class="pb-notify-icon-ring">✏️</div>
          <h3 class="pb-notify-title">${escapeSafe(message)}</h3>
          <div style="margin: 12px 0 18px;">
            <input type="text" id="pbPromptInput" value="${escapeSafe(defaultValue)}" style="width: 100%; padding: 12px 14px; border: 2px solid #EAD8C7; border-radius: 14px; font-size: 14px; font-weight: 600; color: #381E11; background: #FDF7F0; outline: none;">
          </div>
          <div class="pb-notify-actions">
            <button type="button" class="pb-notify-btn pb-notify-btn-secondary" id="pbPromptCancelBtn">Batal</button>
            <button type="button" class="pb-notify-btn pb-notify-btn-primary" id="pbPromptOkBtn">Simpan ✓</button>
          </div>
        </div>
      `;

      document.body.appendChild(backdrop);
      activeBackdrop = backdrop;
      const inp = backdrop.querySelector('#pbPromptInput');

      const finish = (val) => {
        backdrop.classList.remove('pb-visible');
        setTimeout(() => {
          try { backdrop.remove(); } catch (e) {}
          if (activeBackdrop === backdrop) activeBackdrop = null;
          resolve(val);
        }, 200);
      };

      backdrop.querySelector('#pbPromptCancelBtn').addEventListener('click', () => finish(null));
      backdrop.querySelector('.pb-notify-close-x').addEventListener('click', () => finish(null));
      backdrop.querySelector('#pbPromptOkBtn').addEventListener('click', () => finish(inp.value));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(inp.value);
        if (e.key === 'Escape') finish(null);
      });

      requestAnimationFrame(() => {
        backdrop.classList.add('pb-visible');
        inp.focus();
        inp.select();
      });
    });
  };

  // Override native window.alert globally so NO ugly browser alert can ever appear!
  window.alert = function customAlertOverride(msg) {
    window.showAppNotify(msg);
  };
})();
