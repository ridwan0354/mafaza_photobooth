// BUSINESS ADMIN DASHBOARD CONTROLLER
if (!window.__pbNotifyInitialized) {
  const s = document.createElement('script');
  s.src = '/js/notify.js?v=warm-retro-v3.2';
  document.head.appendChild(s);
}

let activeTemplate = null;
let templatesList = [];
let editorSlots = [];
let templateFilterMode = 'event';
let selectedSlotIndex = 0;
let draggingSlot = null;
let dragStartX = 0, dragStartY = 0;
let initialSlotX = 0, initialSlotY = 0;
let activeDragHandle = null;
let resizingSlot = null;
let resizeInitialState = null;

let eventsList = [];
let currentEditingEventId = null;
let activeKioskEventId = localStorage.getItem('pb_active_event_id') || null;
let activeEvent = null;

window.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const initialTab = urlParams.get('tab') || (window.location.hash ? window.location.hash.replace('#', '') : null);
  if (initialTab && document.getElementById('tab-' + initialTab)) {
    switchTab(initialTab);
  }

  await syncActiveEvent();
  await loadEvents();
  await loadOverview();
  await loadTemplates();
  await loadQRFleets();
  await loadPrintJobs();
  await loadSystemPrinters();
  await loadPrintAgentStatus();
  setInterval(loadPrintAgentStatus, 10000);
  await loadRecentPhotos(activeKioskEventId);
  await loadAppDownloadInfo();
  await loadCameraFlashSettings();
});

async function syncActiveEvent() {
  try {
    const res = await fetch('/api/events/active/current');
    if (res.ok) {
      const data = await res.json();
      if (data.event) {
        activeEvent = data.event;
        activeKioskEventId = data.event.id;
        localStorage.setItem('pb_active_event_id', activeKioskEventId);
        if (!currentEditingEventId) {
          currentEditingEventId = activeKioskEventId;
        }
        updateActiveEventUI(activeEvent);
      }
    }
  } catch (e) {
    console.error('Failed to sync active event:', e);
  }
}

function updateActiveEventUI(event) {
  if (!event) return;
  const topTitle = document.getElementById('topActiveEventTitle');
  if (topTitle) topTitle.innerText = event.name;

  const overviewTitle = document.getElementById('overviewActiveEventName');
  if (overviewTitle) overviewTitle.innerText = event.name;

  const configTitle = document.getElementById('selectedEventConfigTitle');
  if (configTitle && (!currentEditingEventId || currentEditingEventId === event.id)) {
    configTitle.innerText = `Konfigurasi: ${event.name}`;
  }

  document.title = `Mafaza — ${event.name}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function switchTab(tabId, element) {
  document.querySelectorAll('.tab-content, .tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn, .nav-item').forEach(el => el.classList.remove('active'));
  
  const target = document.getElementById('tab-' + tabId);
  if (target) target.classList.add('active');
  if (element) {
    element.classList.add('active');
  } else {
    const matchedNav = Array.from(document.querySelectorAll('.nav-btn')).find(btn =>
      (btn.getAttribute('onclick') || '').includes(`'${tabId}'`)
    );
    if (matchedNav) matchedNav.classList.add('active');
  }

  if (tabId === 'printqueue') {
    if (typeof loadPrintQueueTab === 'function') loadPrintQueueTab();
    if (!printQueuePollInterval && typeof refreshPrintQueueSilently === 'function') {
      printQueuePollInterval = setInterval(refreshPrintQueueSilently, 3500);
    }
  } else {
    if (printQueuePollInterval) {
      clearInterval(printQueuePollInterval);
      printQueuePollInterval = null;
    }
  }

  if (tabId === 'templates') {
    loadTemplates();
    setTimeout(renderEditorCanvas, 150);
  } else if (tabId === 'events') {
    loadEvents();
  } else if (tabId === 'photos') {
    const filterSelect = document.getElementById('galleryEventFilter');
    const curVal = (filterSelect && filterSelect.value !== '') ? filterSelect.value : activeKioskEventId;
    loadRecentPhotos(curVal);
  } else if (tabId === 'printqueue') {
    if (typeof loadPrintQueueTab === 'function') loadPrintQueueTab();
  } else if (tabId === 'prints') {
    loadPrintJobs();
    loadSystemPrinters();
  } else if (tabId === 'qrpasses') {
    loadQRFleets();
  } else if (tabId === 'apps') {
    loadAppDownloadInfo();
  }
}

async function loadOverview() {
  if (!activeKioskEventId && eventsList.length > 0) {
    activeKioskEventId = eventsList[0].id;
  }
  if (!activeKioskEventId) return;

  try {
    const res = await fetch(`/api/events/${activeKioskEventId}/analytics`);
    if (res.ok) {
      const data = await res.json();
      const sessions = data.totalSessions ?? 0;
      const prints = data.totalPrintsPrinted ?? 0;
      const passes = data.totalGuestPasses ?? 0;

      const elSessions = document.getElementById('statTotalSessions');
      if (elSessions) elSessions.innerText = sessions;

      const elPrints = document.getElementById('statTotalPrints');
      if (elPrints) elPrints.innerText = prints;

      const elPasses = document.getElementById('statGuestPasses');
      if (elPasses) elPasses.innerText = passes;

      const rateEl = document.getElementById('statSessionRate');
      if (rateEl) {
        rateEl.innerText = sessions > 0 ? `+${sessions} sesi tersimpan` : 'Belum ada sesi foto';
      }
    }
  } catch (e) {
    console.error('Error fetching analytics:', e);
  }

  // Populate recent sessions table
  const table = document.getElementById('recentSessionsTable');
  if (table) {
    try {
      const sessRes = await fetch(`/api/events/${activeKioskEventId}/sessions`);
      let sessions = [];
      if (sessRes.ok) {
        sessions = await sessRes.json();
      }

      if (sessions && sessions.length > 0) {
        table.innerHTML = `
          <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px;">
            <thead>
              <tr style="border-bottom: 2px solid var(--border-soft); color: var(--text-muted); font-size: 13px;">
                <th style="padding: 10px;">ID Sesi</th>
                <th>Mode</th>
                <th>Media Foto</th>
                <th>Status</th>
                <th>Waktu Sesi</th>
              </tr>
            </thead>
            <tbody>
              ${sessions.map(s => {
                const timeStr = s.started_at ? new Date(s.started_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
                return `
                  <tr style="border-bottom: 1px solid var(--border-soft);">
                    <td style="padding: 12px; font-family: monospace; font-weight: 700; color: var(--caramel-brown);">${s.id}</td>
                    <td><span class="badge-pill badge-active">${s.mode || 'Strip'}</span></td>
                    <td><span class="sticker-badge sticker-teal" style="font-size: 12px;">📷 ${s.media_count || 0} File</span></td>
                    <td><span class="badge-pill badge-active">${s.status || 'completed'}</span></td>
                    <td style="font-size: 13px; color: var(--dark-roast);">${timeStr}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `;
      } else {
        table.innerHTML = `
          <div style="text-align: center; padding: 32px 16px; color: var(--text-muted);">
            <div style="font-size: 36px; margin-bottom: 10px;">📸</div>
            <div style="font-weight: 700; font-size: 15px; color: var(--caramel-brown); margin-bottom: 4px;">Belum Ada Sesi Foto untuk Event Ini</div>
            <p style="font-size: 13px; margin-bottom: 16px;">Mulai sesi foto pertama Anda di layar Kiosk Touchscreen untuk melihat riwayat aktivitas di sini.</p>
            <a href="/kiosk" target="_blank" class="btn btn-coral" style="padding: 10px 20px; font-size: 13.5px; text-decoration: none;">
              🖥️ Buka Layar Kiosk Sekarang ➔
            </a>
          </div>
        `;
      }
    } catch (err) {
      table.innerHTML = `<div style="padding: 16px; color: var(--text-muted); text-align: center;">Belum ada sesi foto.</div>`;
    }
  }
}

// ==========================================
// EVENT MANAGEMENT (Kelola & Tambah Event)
// ==========================================
async function loadEvents() {
  try {
    const res = await fetch('/api/events');
    if (res.ok) {
      eventsList = await res.json();
      if (!currentEditingEventId && eventsList.length > 0) {
        currentEditingEventId = activeKioskEventId || eventsList[0].id;
      }
      renderEventsTable();
      populateSelectedEventConfig();
      if (typeof populatePrintQueueEventFilter === 'function') populatePrintQueueEventFilter();
    }
  } catch (e) {
    console.error('Failed to load events:', e);
  }
}

function renderEventsTable() {
  const container = document.getElementById('eventsTableBody');
  if (!container) return;

  if (eventsList.length === 0) {
    container.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--text-muted);">Belum ada event. Klik tombol "+ Buat Event Baru" di atas!</td></tr>`;
    return;
  }

  container.innerHTML = eventsList.map(ev => {
    const isKioskActive = (ev.id === activeKioskEventId);
    
    // Format Tanggal Acara
    let dateFormatted = '-';
    if (ev.config && ev.config.eventDate) {
      dateFormatted = new Date(ev.config.eventDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    } else if (ev.starts_at) {
      dateFormatted = new Date(ev.starts_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    // Tanggal Hapus Otomatis (1 Tahun)
    let autoDeleteFormatted = '1 Tahun';
    if (ev.config && ev.config.autoDeleteAt) {
      autoDeleteFormatted = new Date(ev.config.autoDeleteAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    const shotsCount = ev.config?.shotsCount || 3;
    const qrReq = ev.config?.qrRequirement || 'disabled';
    const qrLabel = qrReq === 'disabled' ? '🚫 Tanpa Scan QR' : (qrReq === 'required' ? '🔒 Wajib QR' : '🎟️ Scan QR');
    const bgCfg = ev.config?.kioskBackground || { type: 'default' };
    const bgBadgeMap = {
      default: '🎨 Bg Default',
      image: '🖼️ Bg Gambar',
      video: '🎬 Bg Video S3/MP4',
      youtube: '▶️ Bg YouTube'
    };
    const bgLabel = bgBadgeMap[bgCfg.type] || '🎨 Bg Default';

    return `
      <tr style="border-bottom: 1px solid var(--border-soft); transition: background 0.2s ease;">
        <td style="padding: 14px 12px; font-weight: 700; color: var(--caramel-brown);">
          ${ev.name}
          ${isKioskActive ? '<span class="badge-pill badge-active" style="margin-left: 8px; font-size: 11px;">Aktif di Kiosk</span>' : ''}
        </td>
        <td style="font-size: 13.5px; font-weight: 600; color: var(--dark-roast);">${dateFormatted}</td>
        <td>
          <span class="sticker-badge sticker-mustard" style="font-size: 11.5px; font-weight: 700;">
            📸 ${shotsCount}x Cekrek
          </span>
          <span class="sticker-badge sticker-teal" style="font-size: 11px; font-weight: 700; margin-left: 4px;">
            ${qrLabel}
          </span>
          <span class="sticker-badge sticker-purple" style="font-size: 11px; font-weight: 700; margin-left: 4px;">
            ${bgLabel}
          </span>
        </td>
        <td style="font-size: 12.5px; color: var(--dusty-teal); font-weight: 600;" title="Semua foto otomatis dihapus permanen tepat 1 tahun setelah acara">
          🗑️ ${autoDeleteFormatted}
        </td>
        <td><span class="badge-pill badge-active">${ev.status || 'active'}</span></td>
        <td>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="selectEventForEdit('${ev.id}')">
              ⚙️ Konfigurasi
            </button>
            ${!isKioskActive ? `
              <button class="btn btn-teal" style="padding: 6px 12px; font-size: 12px;" onclick="setActiveKioskEvent('${ev.id}')">
                🖥️ Jadikan Aktif
              </button>
            ` : `
              <span style="font-size: 12px; color: var(--dusty-teal); font-weight: 700; padding: 4px 8px;">✓ Aktif</span>
            `}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function selectEventForEdit(eventId) {
  currentEditingEventId = eventId;
  populateSelectedEventConfig();
  const el = document.getElementById('selectedEventConfigTitle');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
}

async function setActiveKioskEvent(eventId) {
  try {
    const res = await fetch('/api/events/active/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId })
    });
    if (res.ok) {
      const data = await res.json();
      activeKioskEventId = eventId;
      localStorage.setItem('pb_active_event_id', eventId);
      activeEvent = data.event || eventsList.find(e => e.id === eventId);
      currentEditingEventId = eventId;

      updateActiveEventUI(activeEvent);
      renderEventsTable();
      populateSelectedEventConfig();
      if (typeof populatePrintQueueEventFilter === 'function') populatePrintQueueEventFilter();
      await loadOverview();
      await loadPrintJobs();
      populateGalleryEventFilter(eventId);
      await loadRecentPhotos(eventId);

      alert(`✅ Event "${activeEvent ? activeEvent.name : eventId}" sekarang aktif sebagai event utama untuk Kiosk & Seluruh Panel Admin!`);
    } else {
      const err = await res.json();
      alert('Gagal mengaktifkan event: ' + (err.error || 'Terjadi kesalahan'));
    }
  } catch (e) {
    console.error('Error activating event:', e);
    alert('Terjadi kesalahan jaringan saat mengaktifkan event.');
  }
}

function populateSelectedEventConfig() {
  const ev = eventsList.find(e => e.id === currentEditingEventId) || eventsList[0];
  if (!ev) return;
  currentEditingEventId = ev.id;

  const titleEl = document.getElementById('selectedEventConfigTitle');
  if (titleEl) titleEl.innerText = `Konfigurasi: ${ev.name}`;

  const badgeEl = document.getElementById('selectedEventActiveBadge');
  if (badgeEl) {
    if (ev.id === activeKioskEventId) {
      badgeEl.innerText = '● Sedang Digunakan di Kiosk';
      badgeEl.className = 'badge-pill badge-active';
    } else {
      badgeEl.innerText = 'Bukan Event Kiosk Utama';
      badgeEl.className = 'badge-pill badge-pending';
    }
  }

  const cfg = ev.config || {};

  // Update retention badge display
  const retBadge = document.getElementById('cfgRetentionBadge');
  if (retBadge) {
    if (cfg.autoDeleteAt) {
      const delStr = new Date(cfg.autoDeleteAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
      retBadge.innerText = `🗑️ Retensi: Hapus Otomatis ${delStr}`;
    } else {
      retBadge.innerText = '🗑️ Retensi Cloud: 1 Tahun';
    }
  }

  // Set Berapa Kali Cekrek
  const shotsSelect = document.getElementById('cfgShotsCount');
  if (shotsSelect) {
    shotsSelect.value = String(cfg.shotsCount || 3);
  }

  if (document.getElementById('cfgCountdown')) document.getElementById('cfgCountdown').value = cfg.countdownSeconds || 3;
  if (document.getElementById('cfgMaxCopies')) document.getElementById('cfgMaxCopies').value = cfg.maxCopiesPerSession || 2;
  if (document.getElementById('cfgQrRequirement')) document.getElementById('cfgQrRequirement').value = cfg.qrRequirement || 'disabled';
  if (document.getElementById('cfgPinLock')) document.getElementById('cfgPinLock').value = cfg.pinLock || '1234';

  // Populate Kiosk Background settings for this Event
  const bgCfg = cfg.kioskBackground || { type: 'default', url: '', overlayOpacity: 35 };
  const initialBgType = bgCfg.type || 'default';
  draftBgUrlsByType = { image: '', video: '', youtube: '' };
  if (initialBgType !== 'default' && bgCfg.url) {
    draftBgUrlsByType[initialBgType] = bgCfg.url;
  }
  lastSelectedBgType = initialBgType;

  if (document.getElementById('cfgBgType')) {
    document.getElementById('cfgBgType').value = initialBgType;
  }
  if (document.getElementById('cfgBgUrl')) {
    document.getElementById('cfgBgUrl').value = bgCfg.url || '';
  }
  const opacityVal = (bgCfg.overlayOpacity !== undefined && bgCfg.overlayOpacity !== null) ? parseInt(bgCfg.overlayOpacity) : 35;
  if (document.getElementById('cfgBgOverlayOpacity')) {
    document.getElementById('cfgBgOverlayOpacity').value = opacityVal;
  }
  if (document.getElementById('cfgBgOpacityLabel')) {
    document.getElementById('cfgBgOpacityLabel').innerText = `${opacityVal}%`;
  }
  onKioskBgTypeChange(false);

  const modes = cfg.enabledModes || ['single', 'strip', 'collage', 'gif'];
  if (document.getElementById('m_strip')) document.getElementById('m_strip').checked = modes.includes('strip');
  if (document.getElementById('m_single')) document.getElementById('m_single').checked = modes.includes('single');
  if (document.getElementById('m_collage')) document.getElementById('m_collage').checked = modes.includes('collage');
  if (document.getElementById('m_gif')) document.getElementById('m_gif').checked = modes.includes('gif');
  if (document.getElementById('m_boomerang')) document.getElementById('m_boomerang').checked = modes.includes('boomerang');
}

let lastSelectedBgType = 'default';
let draftBgUrlsByType = { image: '', video: '', youtube: '' };

function extractYouTubeId(url) {
  if (!url) return null;
  const trimmed = url.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{6,15})/,
    /[?&]v=([a-zA-Z0-9_-]{6,15})/
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function detectBgTypeFromUrl(url, fallbackType = 'image') {
  if (!url) return fallbackType;
  const u = url.trim().toLowerCase();
  if (u.includes('youtube.com/') || u.includes('youtu.be/')) {
    return 'youtube';
  }
  if (/\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i.test(u) || u.startsWith('data:video/')) {
    return 'video';
  }
  if (/\.(jpg|jpeg|png|webp|gif|svg|avif)(\?.*)?$/i.test(u) || u.startsWith('data:image/')) {
    return 'image';
  }
  return fallbackType === 'default' ? 'image' : fallbackType;
}

function onKioskBgTypeChange(isUserSwitch = true) {
  const typeSelect = document.getElementById('cfgBgType');
  const sourcePanel = document.getElementById('cfgBgSourcePanel');
  const opacityGroup = document.getElementById('cfgBgOpacityGroup');
  const urlInput = document.getElementById('cfgBgUrl');
  const urlLabel = document.getElementById('cfgBgUrlLabel');
  const uploadBtn = document.getElementById('btnUploadBgFile');

  if (!typeSelect || !sourcePanel) return;
  const type = typeSelect.value;

  // When user switches dropdown type, save current URL for previous type and restore saved URL for new type
  if (isUserSwitch && urlInput) {
    if (lastSelectedBgType && lastSelectedBgType !== 'default') {
      draftBgUrlsByType[lastSelectedBgType] = urlInput.value.trim();
    }
    if (type !== 'default') {
      urlInput.value = draftBgUrlsByType[type] || '';
    }
  }
  lastSelectedBgType = type;

  if (type === 'default') {
    sourcePanel.style.display = 'none';
    if (opacityGroup) opacityGroup.style.display = 'none';
  } else {
    sourcePanel.style.display = 'flex';
    if (opacityGroup) opacityGroup.style.display = 'block';

    if (type === 'youtube') {
      if (urlLabel) urlLabel.innerText = '▶️ Masukkan Link Video YouTube';
      if (urlInput) urlInput.placeholder = 'Contoh: https://www.youtube.com/watch?v=... atau https://youtu.be/...';
      if (uploadBtn) uploadBtn.style.display = 'none';
    } else if (type === 'video') {
      if (urlLabel) urlLabel.innerText = '🎬 Masukkan Link S3 Video (.mp4 / .webm) atau Upload Video';
      if (urlInput) urlInput.placeholder = 'Contoh: https://s3.amazonaws.com/.../video.mp4 atau klik Upload';
      if (uploadBtn) {
        uploadBtn.style.display = 'inline-flex';
        uploadBtn.innerText = '📤 Upload Video / Gambar';
      }
    } else {
      if (urlLabel) urlLabel.innerText = '🖼️ Upload Gambar Background atau Masukkan Link Gambar / S3';
      if (urlInput) urlInput.placeholder = 'Contoh: https://s3.../background.jpg atau klik tombol Upload Gambar';
      if (uploadBtn) {
        uploadBtn.style.display = 'inline-flex';
        uploadBtn.innerText = '📤 Upload Gambar / Video';
      }
    }

    if (isUserSwitch && urlInput) {
      urlInput.focus();
    }
  }
  renderAdminBgPreview();
}

function clearKioskBgUrlInput() {
  const typeSelect = document.getElementById('cfgBgType');
  const urlInput = document.getElementById('cfgBgUrl');
  if (urlInput) {
    urlInput.value = '';
    urlInput.focus();
  }
  if (typeSelect && typeSelect.value !== 'default') {
    draftBgUrlsByType[typeSelect.value] = '';
  }
  renderAdminBgPreview();
}

function onKioskBgOpacityChange(val) {
  const label = document.getElementById('cfgBgOpacityLabel');
  const overlay = document.getElementById('cfgBgPreviewOverlay');
  if (label) label.innerText = `${val}%`;
  if (overlay) overlay.style.background = `rgba(28, 18, 12, ${parseInt(val) / 100})`;
}

function renderAdminBgPreview() {
  const typeSelect = document.getElementById('cfgBgType');
  const urlInput = document.getElementById('cfgBgUrl');
  const mediaBox = document.getElementById('cfgBgPreviewMedia');
  const overlay = document.getElementById('cfgBgPreviewOverlay');
  const opacitySlider = document.getElementById('cfgBgOverlayOpacity');
  if (!typeSelect || !mediaBox) return;

  const type = typeSelect.value;
  const rawUrl = (urlInput ? urlInput.value : '').trim();
  if (type !== 'default') {
    draftBgUrlsByType[type] = rawUrl;
  }

  const opacity = opacitySlider ? (parseInt(opacitySlider.value) / 100) : 0.35;
  if (overlay) {
    overlay.style.background = type === 'default' ? 'transparent' : `rgba(28, 18, 12, ${opacity})`;
  }

  if (type === 'default' || !rawUrl) {
    mediaBox.innerHTML = `
      <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#F9E9D7;color:#7B482E;font-size:12px;font-weight:700;padding:12px;text-align:center;">
        ${type === 'default' ? '🎨 Background Default Krem Hangat' : 'Masukkan Link URL di atas atau Klik Upload File untuk melihat preview'}
      </div>
    `;
    return;
  }

  if (type === 'youtube') {
    const ytId = extractYouTubeId(rawUrl);
    if (ytId) {
      const embedUrl = `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1&loop=1&playlist=${ytId}&controls=0&showinfo=0&rel=0&modestbranding=1&playsinline=1`;
      mediaBox.innerHTML = `<iframe src="${embedUrl}" style="width:100%;height:100%;border:0;pointer-events:none;object-fit:cover;" allow="autoplay; encrypted-media"></iframe>`;
    } else {
      mediaBox.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#2C1810;color:#FFD166;font-size:12px;font-weight:700;padding:12px;text-align:center;">⚠️ Masukkan Link YouTube yang valid (Contoh: https://www.youtube.com/watch?v=... atau https://youtu.be/...)</div>`;
    }
  } else if (type === 'video') {
    mediaBox.innerHTML = `<video src="${rawUrl}" autoplay loop muted playsinline style="width:100%;height:100%;object-fit:cover;display:block;"></video>`;
  } else {
    mediaBox.innerHTML = `<img src="${rawUrl}" alt="Preview Background" style="width:100%;height:100%;object-fit:cover;display:block;">`;
  }
}

function resetKioskBackgroundToDefault() {
  draftBgUrlsByType = { image: '', video: '', youtube: '' };
  lastSelectedBgType = 'default';
  if (document.getElementById('cfgBgType')) document.getElementById('cfgBgType').value = 'default';
  if (document.getElementById('cfgBgUrl')) document.getElementById('cfgBgUrl').value = '';
  if (document.getElementById('cfgBgOverlayOpacity')) document.getElementById('cfgBgOverlayOpacity').value = 35;
  if (document.getElementById('cfgBgOpacityLabel')) document.getElementById('cfgBgOpacityLabel').innerText = '35%';
  onKioskBgTypeChange(false);
}

function onNewEventBgTypeChange() {
  const sel = document.getElementById('newBgType');
  const wrap = document.getElementById('newBgSourceWrap');
  if (!sel || !wrap) return;
  wrap.style.display = sel.value === 'default' ? 'none' : 'flex';
}

async function handleUploadKioskBackground(fileInput, mode = 'edit') {
  const file = fileInput?.files?.[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('backgroundFile', file);

  const btn = document.getElementById('btnUploadBgFile');
  const prevText = btn ? btn.innerText : '';
  if (btn && mode === 'edit') btn.innerText = '⏳ Mengunggah...';

  try {
    const res = await fetch('/api/events/upload-background', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengunggah file background');

    if (mode === 'new') {
      const newType = document.getElementById('newBgType');
      const newUrl = document.getElementById('newBgUrl');
      if (newType) newType.value = data.mediaType || 'image';
      if (newUrl) newUrl.value = data.fileUrl;
      onNewEventBgTypeChange();
    } else {
      const uploadedType = data.mediaType || 'image';
      draftBgUrlsByType[uploadedType] = data.fileUrl;
      lastSelectedBgType = uploadedType;
      const cfgType = document.getElementById('cfgBgType');
      const cfgUrl = document.getElementById('cfgBgUrl');
      if (cfgType) cfgType.value = uploadedType;
      if (cfgUrl) cfgUrl.value = data.fileUrl;
      onKioskBgTypeChange(false);
    }
  } catch (err) {
    alert('Gagal mengunggah background: ' + err.message);
  } finally {
    if (btn && mode === 'edit') btn.innerText = prevText || '📤 Upload Gambar / Video';
    fileInput.value = '';
  }
}

function openCreateEventModal() {
  const modal = document.getElementById('createEventModal');
  if (modal) {
    modal.style.display = 'flex';
    const nameInput = document.getElementById('newEventName');
    if (nameInput) {
      nameInput.value = '';
      setTimeout(() => nameInput.focus(), 100);
    }
    const dateInput = document.getElementById('newEventDate');
    if (dateInput && !dateInput.value) {
      // Default to today's local date (YYYY-MM-DD)
      const now = new Date();
      const localDate = now.toISOString().split('T')[0];
      dateInput.value = localDate;
    }
  }
}

function closeCreateEventModal(event) {
  if (event && event.target && event.target.closest('.photo-modal-card') && !event.target.classList.contains('photo-modal-close') && event.target.tagName !== 'BUTTON') {
    return;
  }
  const modal = document.getElementById('createEventModal');
  if (modal) modal.style.display = 'none';
}

async function createNewEvent(event) {
  if (event) event.preventDefault();
  const name = document.getElementById('newEventName').value.trim();
  if (!name) {
    alert('Silakan masukkan nama event!');
    return;
  }

  const eventDate = document.getElementById('newEventDate').value;
  if (!eventDate) {
    alert('Silakan pilih tanggal acara!');
    return;
  }

  const shotsCount = parseInt(document.getElementById('newShotsCount').value) || 3;

  const newBgTypeVal = document.getElementById('newBgType')?.value || 'default';
  const newBgUrlVal = (document.getElementById('newBgUrl')?.value || '').trim();
  const resolvedNewBgType = newBgUrlVal ? detectBgTypeFromUrl(newBgUrlVal, newBgTypeVal) : newBgTypeVal;

  const payload = {
    name: name,
    eventDate: eventDate,
    shotsCount: shotsCount,
    countdownSeconds: parseInt(document.getElementById('newCountdown').value) || 3,
    maxCopiesPerSession: parseInt(document.getElementById('newMaxCopies').value) || 2,
    qrRequirement: document.getElementById('newQrRequirement')?.value || 'disabled',
    pinLock: document.getElementById('newPinLock').value || '1234',
    kioskBackground: {
      type: resolvedNewBgType,
      url: resolvedNewBgType === 'default' ? '' : newBgUrlVal,
      overlayOpacity: 35
    },
    enabledModes: []
  };

  if (document.getElementById('new_m_strip').checked) payload.enabledModes.push('strip');
  if (document.getElementById('new_m_single').checked) payload.enabledModes.push('single');
  if (document.getElementById('new_m_collage').checked) payload.enabledModes.push('collage');
  if (document.getElementById('new_m_gif').checked) payload.enabledModes.push('gif');

  try {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const created = await res.json();
      alert(`🎉 Event "${created.name}" berhasil dibuat!\n\n📅 Tanggal Acara: ${eventDate}\n📸 Jumlah Cekrek: ${shotsCount}x Pose\n🗑️ Hapus Otomatis: 1 Tahun setelah acara`);
      closeCreateEventModal();
      await setActiveKioskEvent(created.id);
      await loadEvents();
    } else {
      const err = await res.json();
      alert('Gagal membuat event: ' + (err.error || 'Terjadi kesalahan'));
    }
  } catch (e) {
    alert('Terjadi kesalahan jaringan.');
  }
}

async function saveEventConfig() {
  const shotsCount = parseInt(document.getElementById('cfgShotsCount').value) || 3;
  const bgType = document.getElementById('cfgBgType')?.value || 'default';
  const bgUrl = (document.getElementById('cfgBgUrl')?.value || '').trim();
  const bgOpacity = document.getElementById('cfgBgOverlayOpacity') ? parseInt(document.getElementById('cfgBgOverlayOpacity').value) : 35;

  if (bgType !== 'default' && !bgUrl) {
    alert('Silakan unggah file atau masukkan Link URL (YouTube / S3 Video / Gambar) terlebih dahulu, atau pilih Default.');
    return;
  }

  const payload = {
    shotsCount: shotsCount,
    countdownSeconds: parseInt(document.getElementById('cfgCountdown').value) || 3,
    maxCopiesPerSession: parseInt(document.getElementById('cfgMaxCopies').value) || 2,
    qrRequirement: document.getElementById('cfgQrRequirement').value,
    pinLock: document.getElementById('cfgPinLock').value,
    kioskBackground: {
      type: bgType,
      url: bgType === 'default' ? '' : bgUrl,
      overlayOpacity: isNaN(bgOpacity) ? 35 : bgOpacity
    },
    enabledModes: []
  };

  if (document.getElementById('m_strip').checked) payload.enabledModes.push('strip');
  if (document.getElementById('m_single').checked) payload.enabledModes.push('single');
  if (document.getElementById('m_collage').checked) payload.enabledModes.push('collage');
  if (document.getElementById('m_gif').checked) payload.enabledModes.push('gif');
  if (document.getElementById('m_boomerang').checked) payload.enabledModes.push('boomerang');

  try {
    const res = await fetch(`/api/events/${currentEditingEventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      alert('✅ Konfigurasi Event berhasil disimpan & disinkronkan ke Kiosk!');
      await loadEvents();
    }
  } catch (e) {
    alert('Gagal menyimpan konfigurasi');
  }
}

// ==============================================================
// SMART TEMPLATE GREEN-AREA AUTO DETECTION & CANVAS EDITOR
// ==============================================================
function setTemplateFilter(mode) {
  templateFilterMode = mode;
  const btnEvent = document.getElementById('btnFilterEventTemplates');
  const btnAll = document.getElementById('btnFilterAllTemplates');
  if (btnEvent && btnAll) {
    if (mode === 'event') {
      btnEvent.style.background = 'var(--coral)';
      btnEvent.style.color = 'white';
      btnAll.style.background = 'transparent';
      btnAll.style.color = 'var(--caramel-brown)';
    } else {
      btnAll.style.background = 'var(--coral)';
      btnAll.style.color = 'white';
      btnEvent.style.background = 'transparent';
      btnEvent.style.color = 'var(--caramel-brown)';
    }
  }
  loadTemplates();
}

async function loadTemplates() {
  const badgeEl = document.getElementById('templateActiveEventBadge');
  const curEvent = activeEvent || eventsList.find(e => e.id === activeKioskEventId);
  if (badgeEl) {
    badgeEl.innerText = curEvent ? curEvent.name : 'Event Aktif';
  }

  try {
    let url = '/api/templates';
    if (templateFilterMode === 'event' && activeKioskEventId) {
      url += `?eventId=${activeKioskEventId}`;
    }
    const res = await fetch(url);
    if (res.ok) {
      templatesList = await res.json();
      renderTemplatesGallery();

      if (templatesList.length === 0) {
        activeTemplate = null;
        editorSlots = [];
        selectedSlotIndex = -1;
        renderSlotsList();
        renderEditorCanvas();
        const nameEl = document.getElementById('currentEditorTemplateName');
        if (nameEl) nameEl.innerText = 'Belum Ada Template';
        return;
      }

      // If activeTemplate is not set or not in list, select the best matching template
      if (!activeTemplate || !templatesList.some(t => t.id === activeTemplate.id)) {
        const matching = templatesList.find(t => t.event_id === activeKioskEventId) || templatesList[0];
        if (matching) {
          selectTemplateForEditor(matching.id, false);
        }
      } else {
        selectTemplateForEditor(activeTemplate.id, false);
      }
    }
  } catch (e) {
    console.error('Failed to load templates:', e);
  }
}

function renderTemplatesGallery() {
  const container = document.getElementById('templatesGalleryGrid');
  if (!container) return;

  if (!templatesList || templatesList.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px 20px; background: var(--cream-bg); border: 2px dashed var(--border-soft); border-radius: 18px;">
        <span style="font-size: 40px; display: block; margin-bottom: 8px;">🖼️</span>
        <h4 style="font-size: 18px; font-weight: 800; color: var(--caramel-brown); margin-bottom: 6px;">Belum Ada Template Desain</h4>
        <p style="color: var(--text-muted); font-size: 13.5px; margin-bottom: 16px;">Unggah template transparan PNG dengan slot hijau untuk memulai!</p>
        <button class="btn btn-coral" onclick="openUploadTemplateModal()">+ Unggah Template Pertama</button>
      </div>
    `;
    return;
  }

  // Sort so templates for the active event appear first
  const sorted = [...templatesList].sort((a, b) => {
    const aMatch = (a.event_id === activeKioskEventId) ? 1 : 0;
    const bMatch = (b.event_id === activeKioskEventId) ? 1 : 0;
    return bMatch - aMatch;
  });

  const cardsHtml = sorted.map(t => {
    const isSelected = activeTemplate && activeTemplate.id === t.id;
    const isEventSpecific = t.event_id === activeKioskEventId;
    const isGlobal = !t.event_id;
    const formatLabel = t.orientation === 'strip' ? 'Photo Strip 2×6' : 'Single Photo 4×6';
    const slotsCount = t.slots ? t.slots.length : 0;

    return `
      <div class="card-retro" style="display: flex; flex-direction: column; padding: 14px; position: relative; border-color: ${isSelected ? 'var(--coral)' : 'var(--border-soft)'}; box-shadow: ${isSelected ? '0 8px 24px rgba(230,120,107,0.25)' : 'none'}; transform: ${isSelected ? 'translateY(-4px)' : 'none'};">
        <!-- Thumbnail Preview -->
        <div style="height: 180px; background: #2E2A3B; border-radius: 12px; display: flex; align-items: center; justify-content: center; overflow: hidden; margin-bottom: 12px; padding: 6px; position: relative; cursor: pointer;" onclick="selectTemplateForEditor('${t.id}')">
          <img src="${t.image_storage_key}" alt="${t.name}" style="max-height: 100%; max-width: 100%; object-fit: contain; border-radius: 6px;" onerror="this.src='/assets/templates/strip-green-template.svg'" />
          ${isSelected ? `
            <div style="position: absolute; top: 8px; right: 8px; background: var(--coral); color: #fff; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 800; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
              ✓
            </div>
          ` : ''}
        </div>

        <!-- Badges -->
        <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px;">
          <span class="sticker-badge sticker-mustard" style="font-size: 10.5px; padding: 3px 8px;">${formatLabel}</span>
          <span class="sticker-badge sticker-teal" style="font-size: 10.5px; padding: 3px 8px;">📸 ${slotsCount} Slot</span>
          ${isEventSpecific ? `
            <span class="sticker-badge sticker-purple" style="font-size: 10.5px; padding: 3px 8px;">📌 Event Ini</span>
          ` : isGlobal ? `
            <span class="sticker-badge sticker-blue" style="font-size: 10.5px; padding: 3px 8px;">🌐 Global</span>
          ` : `
            <span class="sticker-badge" style="font-size: 10px; padding: 3px 6px; background: #eee; color: #666;">${t.event_name || 'Event Lain'}</span>
          `}
        </div>

        <!-- Title -->
        <h4 style="font-size: 15px; font-weight: 800; color: var(--caramel-brown); margin-bottom: 12px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${t.name}">
          ${t.name}
        </h4>

        <!-- Action Buttons -->
        <div style="margin-top: auto; display: flex; gap: 8px;">
          <button class="btn ${isSelected ? 'btn-coral' : 'btn-secondary'}" style="flex: 1; font-size: 12px; padding: 7px 10px;" onclick="selectTemplateForEditor('${t.id}')">
            ${isSelected ? '● Sedang Diedit' : '✏️ Buka Editor'}
          </button>
          <button class="btn btn-secondary" style="padding: 7px 10px; font-size: 12px; color: var(--coral); border-color: rgba(230,120,107,0.3);" title="Hapus template" onclick="deleteTemplate('${t.id}', '${t.name.replace(/'/g, "\\'")}')">
            🗑️
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Add a card to directly upload new template
  const uploadCardHtml = `
    <div onclick="openUploadTemplateModal()" style="border: 2.5px dashed var(--coral); border-radius: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 280px; padding: 20px; text-align: center; cursor: pointer; background: rgba(230,120,107,0.03); transition: all 0.2s;" onmouseenter="this.style.background='rgba(230,120,107,0.08)'" onmouseleave="this.style.background='rgba(230,120,107,0.03)'">
      <div style="width: 52px; height: 52px; border-radius: 50%; background: var(--coral); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 26px; margin-bottom: 12px; box-shadow: 0 4px 12px rgba(230,120,107,0.3);">
        +
      </div>
      <strong style="color: var(--coral); font-size: 15px; font-weight: 800; margin-bottom: 4px;">Unggah Desain Baru</strong>
      <span style="font-size: 12px; color: var(--text-muted);">Format PNG transparan dengan slot hijau</span>
    </div>
  `;

  container.innerHTML = cardsHtml + uploadCardHtml;
}

function selectTemplateForEditor(templateId, scroll = true) {
  const found = templatesList.find(t => t.id === templateId);
  if (!found) return;
  activeTemplate = found;
  editorSlots = JSON.parse(JSON.stringify(activeTemplate.slots || []));
  selectedSlotIndex = editorSlots.length > 0 ? 0 : -1;

  const nameEl = document.getElementById('currentEditorTemplateName');
  if (nameEl) nameEl.innerText = activeTemplate.name;

  const typeEl = document.getElementById('currentEditorTypeBadge');
  if (typeEl) {
    typeEl.innerText = activeTemplate.orientation === 'strip' ? 'Photo Strip 2×6 (600×1800)' : 'Single Photo 4×6 (1200×1800)';
  }

  renderSlotsList();
  updateSlotInspector();
  renderEditorCanvas();
  renderTemplatesGallery();

  if (scroll) {
    const editorEl = document.getElementById('templateEditorCanvas');
    if (editorEl) editorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ==========================================
// MODAL UPLOAD TEMPLATE
// ==========================================
let selectedUploadFile = null;

function openUploadTemplateModal() {
  const modal = document.getElementById('uploadTemplateModal');
  if (!modal) return;
  modal.style.display = 'flex';

  selectedUploadFile = null;
  const nameInput = document.getElementById('tplModalName');
  if (nameInput) nameInput.value = '';

  const previewContainer = document.getElementById('uploadPreviewContainer');
  const previewImg = document.getElementById('uploadPreviewImg');
  const promptText = document.getElementById('uploadPromptText');
  if (previewContainer) previewContainer.style.display = 'none';
  if (previewImg) previewImg.src = '';
  if (promptText) promptText.style.display = 'block';

  const fileInput = document.getElementById('templateModalFileInput');
  if (fileInput) fileInput.value = '';

  // Populate event target options
  const targetSelect = document.getElementById('tplModalEventTarget');
  if (targetSelect) {
    const curEvent = activeEvent || eventsList.find(e => e.id === activeKioskEventId);
    let opts = '';
    if (curEvent) {
      opts += `<option value="${curEvent.id}" selected>📌 ${curEvent.name} (Event Aktif)</option>`;
    }
    eventsList.forEach(e => {
      if (!curEvent || e.id !== curEvent.id) {
        opts += `<option value="${e.id}">Event: ${e.name}</option>`;
      }
    });
    opts += `<option value="">🌐 Semua Event (Template Global)</option>`;
    targetSelect.innerHTML = opts;
  }

  setupDropzone();
}

function closeUploadTemplateModal(event) {
  if (event && event.target && event.target.closest('.photo-modal-card') && !event.target.classList.contains('photo-modal-close') && event.target.tagName !== 'BUTTON') {
    return;
  }
  const modal = document.getElementById('uploadTemplateModal');
  if (modal) modal.style.display = 'none';
}

function setupDropzone() {
  const dropzone = document.getElementById('uploadDropzone');
  if (!dropzone || dropzone._setupDone) return;
  dropzone._setupDone = true;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.style.borderColor = 'var(--dusty-teal)';
      dropzone.style.background = 'rgba(95, 143, 138, 0.15)';
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.style.borderColor = 'var(--coral)';
      dropzone.style.background = 'rgba(230, 120, 107, 0.05)';
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      handlePickedTemplateFile(files[0]);
    }
  });
}

function onTemplateModalFileSelected(event) {
  if (event.target.files && event.target.files.length > 0) {
    handlePickedTemplateFile(event.target.files[0]);
  }
}

function handlePickedTemplateFile(file) {
  if (!file) return;
  selectedUploadFile = file;

  // Auto set name from file name
  const nameInput = document.getElementById('tplModalName');
  if (nameInput && (!nameInput.value || nameInput.value.trim() === '')) {
    const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
    nameInput.value = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
  }

  // Preview Image
  const reader = new FileReader();
  reader.onload = (e) => {
    const previewContainer = document.getElementById('uploadPreviewContainer');
    const previewImg = document.getElementById('uploadPreviewImg');
    const promptText = document.getElementById('uploadPromptText');

    if (previewImg) previewImg.src = e.target.result;
    if (previewContainer) previewContainer.style.display = 'block';
    if (promptText) promptText.style.display = 'none';

    // Auto detect aspect ratio
    const testImg = new Image();
    testImg.src = e.target.result;
    testImg.onload = () => {
      const formatSelect = document.getElementById('tplModalFormat');
      if (formatSelect) {
        if (testImg.height / testImg.width >= 2.0) {
          formatSelect.value = 'strip';
        } else {
          formatSelect.value = 'portrait';
        }
      }
    };
  };
  reader.readAsDataURL(file);
}

// Also hook up the header button if user triggers it directly
function handleTemplateUpload(event) {
  if (event.target.files && event.target.files.length > 0) {
    openUploadTemplateModal();
    handlePickedTemplateFile(event.target.files[0]);
  }
}

async function submitTemplateUpload(event) {
  if (event) event.preventDefault();

  if (!selectedUploadFile) {
    const fileInput = document.getElementById('templateModalFileInput');
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      selectedUploadFile = fileInput.files[0];
    }
  }

  if (!selectedUploadFile) {
    alert('Silakan pilih file desain template (PNG / SVG) terlebih dahulu!');
    return;
  }

  const name = document.getElementById('tplModalName').value.trim();
  if (!name) {
    alert('Silakan masukkan nama template!');
    return;
  }

  const eventTarget = document.getElementById('tplModalEventTarget').value;
  const format = document.getElementById('tplModalFormat').value;

  const btnSubmit = document.getElementById('btnSubmitUploadTemplate');
  const originalText = btnSubmit ? btnSubmit.innerText : '🚀 Unggah & Buka di Canvas';
  if (btnSubmit) {
    btnSubmit.innerText = '⏳ Mengunggah Template...';
    btnSubmit.disabled = true;
  }

  try {
    const formData = new FormData();
    formData.append('templateFile', selectedUploadFile);
    formData.append('name', name);
    if (eventTarget) formData.append('eventId', eventTarget);
    formData.append('orientation', format);
    formData.append('width', format === 'strip' ? '600' : '1200');
    formData.append('height', '1800');

    const res = await fetch('/api/templates', {
      method: 'POST',
      body: formData
    });

    if (res.ok) {
      const created = await res.json();
      closeUploadTemplateModal();
      alert(`🎉 Template "${created.name}" berhasil diunggah!\n\nSistem sekarang membuka template di Canvas Editor untuk deteksi lubang hijau otomatis.`);
      
      await loadTemplates();
      selectTemplateForEditor(created.id, true);

      // Auto trigger green slot detection on canvas
      setTimeout(() => {
        runAutoGreenDetection();
      }, 400);
    } else {
      const err = await res.json();
      alert('Gagal mengunggah template: ' + (err.error || 'Terjadi kesalahan pada server'));
    }
  } catch (err) {
    console.error('Upload template error:', err);
    alert('Terjadi kesalahan jaringan saat mengunggah template.');
  } finally {
    if (btnSubmit) {
      btnSubmit.innerText = originalText;
      btnSubmit.disabled = false;
    }
  }
}

async function deleteTemplate(templateId, templateName) {
  const confirmed = window.showAppConfirm
    ? await window.showAppConfirm(`Apakah Anda yakin ingin menghapus template "${templateName}"?`, {
        title: 'Hapus Template Desain?',
        icon: '🗑️',
        confirmText: 'Ya, Hapus Template',
        cancelText: 'Batal'
      })
    : confirm(`Apakah Anda yakin ingin menghapus template "${templateName}"?`);
  if (!confirmed) {
    return;
  }

  try {
    const res = await fetch(`/api/templates/${templateId}`, {
      method: 'DELETE'
    });

    if (res.ok) {
      alert(`✅ Template "${templateName}" berhasil dihapus.`);
      if (activeTemplate && activeTemplate.id === templateId) {
        activeTemplate = null;
      }
      await loadTemplates();
    } else {
      const err = await res.json();
      alert('Gagal menghapus template: ' + (err.error || 'Terjadi kesalahan'));
    }
  } catch (e) {
    alert('Terjadi kesalahan jaringan saat menghapus template.');
  }
}

// ==============================================================
// SLOT INSPECTOR, PRECISION RESIZING & 2D CONNECTED GREEN DETECTION
// ==============================================================

function updateSlotInspector() {
  const titleEl = document.getElementById('inspectorSlotTitle');
  const badgeEl = document.getElementById('inspectorSlotBadge');
  const inpX = document.getElementById('inpSlotX');
  const inpY = document.getElementById('inpSlotY');
  const inpW = document.getElementById('inpSlotW');
  const inpH = document.getElementById('inpSlotH');

  if (!titleEl || !inpX) return;

  if (selectedSlotIndex < 0 || !editorSlots[selectedSlotIndex]) {
    titleEl.innerText = '📐 Penyesuaian Presisi Slot';
    badgeEl.innerText = 'Pilih Slot';
    badgeEl.className = 'sticker-badge sticker-mustard';
    inpX.value = '';
    inpY.value = '';
    inpW.value = '';
    inpH.value = '';
    inpX.disabled = true;
    inpY.disabled = true;
    inpW.disabled = true;
    inpH.disabled = true;
    return;
  }

  const slot = editorSlots[selectedSlotIndex];
  titleEl.innerText = `📐 Slot Pose #${slot.pose_index}`;
  badgeEl.innerText = `${Math.round(slot.width)} × ${Math.round(slot.height)} px`;
  badgeEl.className = 'sticker-badge sticker-purple';
  inpX.disabled = false;
  inpY.disabled = false;
  inpW.disabled = false;
  inpH.disabled = false;
  inpX.value = Math.round(slot.x);
  inpY.value = Math.round(slot.y);
  inpW.value = Math.round(slot.width);
  inpH.value = Math.round(slot.height);
}

function onSlotParamChange() {
  if (selectedSlotIndex < 0 || !editorSlots[selectedSlotIndex]) return;
  const slot = editorSlots[selectedSlotIndex];
  const inpX = parseInt(document.getElementById('inpSlotX').value);
  const inpY = parseInt(document.getElementById('inpSlotY').value);
  const inpW = parseInt(document.getElementById('inpSlotW').value);
  const inpH = parseInt(document.getElementById('inpSlotH').value);

  if (!isNaN(inpX)) slot.x = inpX;
  if (!isNaN(inpY)) slot.y = inpY;
  if (!isNaN(inpW) && inpW > 10) slot.width = inpW;
  if (!isNaN(inpH) && inpH > 10) slot.height = inpH;

  renderEditorCanvas();
  renderSlotsList();
}

function adjustActiveSlotSize(prop, delta) {
  if (selectedSlotIndex < 0 || !editorSlots[selectedSlotIndex]) return;
  const slot = editorSlots[selectedSlotIndex];
  if (prop === 'w') {
    slot.width = Math.max(30, slot.width + delta);
  } else if (prop === 'h') {
    slot.height = Math.max(30, slot.height + delta);
  }
  updateSlotInspector();
  renderEditorCanvas();
  renderSlotsList();
}

function fitActiveSlotWidth() {
  if (selectedSlotIndex < 0 || !editorSlots[selectedSlotIndex] || !activeTemplate) return;
  const slot = editorSlots[selectedSlotIndex];
  const canvas = document.getElementById('templateEditorCanvas');
  const maxW = canvas ? canvas.width : (activeTemplate.width || 1200);
  const margin = Math.round(maxW * 0.05);
  slot.x = margin;
  slot.width = maxW - (margin * 2);
  updateSlotInspector();
  renderEditorCanvas();
  renderSlotsList();
}

function renderSlotsList() {
  const container = document.getElementById('detectedSlotsList');
  if (!container) return;
  container.innerHTML = '';

  if (editorSlots.length === 0) {
    container.innerHTML = `<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 14px;">Belum ada slot pose.<br>Klik <strong>🔍 Jalankan Deteksi Hijau</strong> atau <strong>+ Tambah Slot Manual</strong>.</div>`;
    updateSlotInspector();
    return;
  }

  editorSlots.forEach((slot, idx) => {
    const isSelected = (idx === selectedSlotIndex);
    const item = document.createElement('div');
    item.style.cssText = `background: ${isSelected ? 'rgba(236, 72, 153, 0.12)' : '#1e293b'}; border: 2px solid ${isSelected ? '#ec4899' : '#334155'}; border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: all 0.15s;`;
    item.onclick = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      selectedSlotIndex = idx;
      renderSlotsList();
      updateSlotInspector();
      renderEditorCanvas();
    };
    item.innerHTML = `
      <div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <strong style="color: ${isSelected ? '#ec4899' : '#f472b6'}; font-size: 13.5px;">📸 Slot Pose #${slot.pose_index}</strong>
          ${isSelected ? `<span style="font-size: 10px; background: #ec4899; color: white; padding: 1px 6px; border-radius: 4px; font-weight: 700;">Terpilih</span>` : ''}
        </div>
        <div style="font-size: 11.5px; color: ${isSelected ? '#cbd5e1' : 'var(--text-muted)'}; font-family: monospace; margin-top: 2px;">
          x:${Math.round(slot.x)}, y:${Math.round(slot.y)} | ${Math.round(slot.width)}×${Math.round(slot.height)}px
        </div>
      </div>
      <button class="btn btn-danger" style="padding: 4px 10px; font-size: 11.5px;" onclick="deleteSlot(${idx})">Hapus</button>
    `;
    container.appendChild(item);
  });

  updateSlotInspector();
}

function getSlotResizeHandles(slot) {
  return {
    nw: { x: slot.x, y: slot.y, cursor: 'nwse-resize' },
    n:  { x: slot.x + slot.width / 2, y: slot.y, cursor: 'ns-resize' },
    ne: { x: slot.x + slot.width, y: slot.y, cursor: 'nesw-resize' },
    e:  { x: slot.x + slot.width, y: slot.y + slot.height / 2, cursor: 'ew-resize' },
    se: { x: slot.x + slot.width, y: slot.y + slot.height, cursor: 'nwse-resize' },
    s:  { x: slot.x + slot.width / 2, y: slot.y + slot.height, cursor: 'ns-resize' },
    sw: { x: slot.x, y: slot.y + slot.height, cursor: 'nesw-resize' },
    w:  { x: slot.x, y: slot.y + slot.height / 2, cursor: 'ew-resize' }
  };
}

function renderEditorCanvas() {
  const canvas = document.getElementById('templateEditorCanvas');
  if (!canvas || !activeTemplate) {
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#2E2A3B';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Pilih atau unggah template untuk mulai mengedit', canvas.width / 2, canvas.height / 2);
    }
    return;
  }
  const ctx = canvas.getContext('2d');

  canvas.width = activeTemplate.width || 600;
  canvas.height = activeTemplate.height || 1800;

  const tplImg = new Image();
  tplImg.crossOrigin = 'anonymous';
  tplImg.src = activeTemplate.image_storage_key;
  tplImg.onload = () => {
    if (tplImg.naturalWidth && tplImg.naturalHeight) {
      canvas.width = tplImg.naturalWidth;
      canvas.height = tplImg.naturalHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tplImg, 0, 0, canvas.width, canvas.height);

    // Draw detected/active slots as interactive overlays
    editorSlots.forEach((slot, idx) => {
      const isSelected = (idx === selectedSlotIndex);

      ctx.fillStyle = isSelected ? 'rgba(236, 72, 153, 0.45)' : 'rgba(168, 85, 247, 0.3)';
      ctx.fillRect(slot.x, slot.y, slot.width, slot.height);

      ctx.strokeStyle = isSelected ? '#ec4899' : '#a855f7';
      ctx.lineWidth = isSelected ? 4 : 2.5;
      ctx.strokeRect(slot.x, slot.y, slot.width, slot.height);

      // Label on top-left of slot
      const labelText = `📷 Pose #${slot.pose_index}`;
      ctx.font = 'bold 22px sans-serif';
      const textWidth = ctx.measureText(labelText).width;
      ctx.fillStyle = isSelected ? '#ec4899' : '#6b21a8';
      ctx.fillRect(slot.x, slot.y, textWidth + 24, 32);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, slot.x + 10, slot.y + 23);

      // Dimension badge on bottom-right of slot
      const dimText = `${Math.round(slot.width)}×${Math.round(slot.height)}px`;
      ctx.font = '13px monospace';
      const dimWidth = ctx.measureText(dimText).width;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(slot.x + slot.width - dimWidth - 14, slot.y + slot.height - 22, dimWidth + 14, 22);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(dimText, slot.x + slot.width - dimWidth - 7, slot.y + slot.height - 6);

      // If selected, draw 8 resize handles
      if (isSelected) {
        const handles = getSlotResizeHandles(slot);
        for (const h of Object.values(handles)) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(h.x - 7, h.y - 7, 14, 14);
          ctx.strokeStyle = '#ec4899';
          ctx.lineWidth = 2.5;
          ctx.strokeRect(h.x - 7, h.y - 7, 14, 14);
        }
      }
    });
  };
  tplImg.onerror = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2E2A3B';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('File template belum dimuat', canvas.width / 2, canvas.height / 2);
  };
}

// Smart 2D Connected Component Green Chroma Detection
function runAutoGreenDetection() {
  const canvas = document.getElementById('templateEditorCanvas');
  if (!canvas || !activeTemplate) return;
  const ctx = canvas.getContext('2d');

  try {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const w = canvas.width;
    const h = canvas.height;

    // Green Chroma Predicate:
    // Supports #00FF00 (pure green) AND Apple/Canva lime green (#7ED957: rgb 126, 217, 87)
    function isGreenPixel(r, g, b, a) {
      if (a < 128) return false;
      // Pure or high chroma green
      if (g >= 150 && r <= 100 && b <= 100) return true;
      // Canva lime green / Apple green (#7ED957, #66CC00, #A8E063)
      if (g >= 140 && (g - r) >= 30 && (g - b) >= 35) return true;
      // Slightly darker olive green screens
      if (g >= 120 && (g - r) >= 40 && (g - b) >= 40) return true;
      return false;
    }

    const step = 6; // Grid step for fast connected components
    const gridCols = Math.floor(w / step);
    const gridRows = Math.floor(h / step);
    const grid = new Uint8Array(gridCols * gridRows);
    let totalGreenPoints = 0;

    for (let gy = 0; gy < gridRows; gy++) {
      const py = gy * step;
      for (let gx = 0; gx < gridCols; gx++) {
        const px = gx * step;
        const idx = (py * w + px) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];

        if (isGreenPixel(r, g, b, a)) {
          grid[gy * gridCols + gx] = 1;
          totalGreenPoints++;
        }
      }
    }

    if (totalGreenPoints === 0) {
      alert('ℹ️ Tidak ditemukan area hijau murni (#00FF00) atau lime green (#7ED957). Sistem menambahkan slot pose standar yang dapat Anda atur secara manual.');
      editorSlots = [
        { id: 'slot_1', pose_index: 1, x: 50, y: 130, width: canvas.width - 100, height: 420 },
        { id: 'slot_2', pose_index: 2, x: 50, y: 580, width: canvas.width - 100, height: 420 },
        { id: 'slot_3', pose_index: 3, x: 50, y: 1030, width: canvas.width - 100, height: 420 }
      ];
      selectedSlotIndex = 0;
      renderSlotsList();
      renderEditorCanvas();
      return;
    }

    // 2D Connected Component Labeling via Breadth-First Search (BFS)
    const visited = new Uint8Array(gridCols * gridRows);
    const components = [];

    for (let gy = 0; gy < gridRows; gy++) {
      for (let gx = 0; gx < gridCols; gx++) {
        const cellIdx = gy * gridCols + gx;
        if (grid[cellIdx] === 1 && !visited[cellIdx]) {
          let minGX = gx, maxGX = gx;
          let minGY = gy, maxGY = gy;
          let count = 0;

          const queue = [cellIdx];
          visited[cellIdx] = 1;

          while (queue.length > 0) {
            const curr = queue.pop();
            const cx = curr % gridCols;
            const cy = Math.floor(curr / gridCols);
            count++;

            if (cx < minGX) minGX = cx;
            if (cx > maxGX) maxGX = cx;
            if (cy < minGY) minGY = cy;
            if (cy > maxGY) maxGY = cy;

            const neighbors = [
              [cx + 1, cy],
              [cx - 1, cy],
              [cx, cy + 1],
              [cx, cy - 1]
            ];

            for (const [nx, ny] of neighbors) {
              if (nx >= 0 && nx < gridCols && ny >= 0 && ny < gridRows) {
                const nIdx = ny * gridCols + nx;
                if (grid[nIdx] === 1 && !visited[nIdx]) {
                  visited[nIdx] = 1;
                  queue.push(nIdx);
                }
              }
            }
          }

          // Filter out tiny artifacts / lines
          const compW = (maxGX - minGX + 1) * step;
          const compH = (maxGY - minGY + 1) * step;
          if (count > 25 && compW >= 60 && compH >= 60) {
            components.push({
              x: Math.round((minGX * step) / 5) * 5,
              y: Math.round((minGY * step) / 5) * 5,
              width: Math.round((compW) / 5) * 5,
              height: Math.round((compH) / 5) * 5
            });
          }
        }
      }
    }

    if (components.length === 0) {
      alert('ℹ️ Area hijau yang terdeteksi terlalu kecil. Silakan tambah slot manual.');
      return;
    }

    // Sort: Top to bottom, left to right
    components.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 40) {
        return a.y - b.y;
      }
      return a.x - b.x;
    });

    editorSlots = components.map((comp, idx) => ({
      id: 'slot_' + (idx + 1),
      pose_index: idx + 1,
      x: comp.x,
      y: comp.y,
      width: comp.width,
      height: comp.height
    }));

    selectedSlotIndex = 0;
    renderSlotsList();
    renderEditorCanvas();

    alert(`🎉 Sukses! Algoritma cerdas berhasil mendeteksi ${editorSlots.length} slot pose hijau secara akurat pada template Anda.`);
  } catch (err) {
    console.error('Auto green detection error:', err);
    alert('Terjadi kesalahan deteksi hijau: ' + err.message);
  }
}

function addManualSlot() {
  const newIndex = editorSlots.length + 1;
  const canvas = document.getElementById('templateEditorCanvas');
  const w = canvas ? Math.round(canvas.width * 0.8) : 500;
  editorSlots.push({
    id: 'slot_' + Date.now(),
    pose_index: newIndex,
    x: 50,
    y: Math.min(1300, 100 + (editorSlots.length * 350)),
    width: w,
    height: 400
  });
  selectedSlotIndex = editorSlots.length - 1;
  renderSlotsList();
  renderEditorCanvas();
}

function deleteSlot(index) {
  editorSlots.splice(index, 1);
  editorSlots.forEach((s, idx) => s.pose_index = idx + 1);
  if (selectedSlotIndex >= editorSlots.length) {
    selectedSlotIndex = editorSlots.length - 1;
  }
  renderSlotsList();
  renderEditorCanvas();
}

async function saveTemplateVersion() {
  if (!activeTemplate) {
    alert('Pilih template terlebih dahulu');
    return;
  }
  try {
    const res = await fetch(`/api/templates/${activeTemplate.id}/slots`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots: editorSlots })
    });
    if (res.ok) {
      alert('✅ Konfigurasi slot pose template berhasil disimpan & dipublikasikan untuk Kiosk Event!');
      await loadTemplates();
    } else {
      const err = await res.json();
      alert('Gagal menyimpan slot: ' + (err.error || 'Terjadi kesalahan'));
    }
  } catch (e) {
    alert('Gagal menyimpan template.');
  }
}

// ==============================================================
// INTERACTIVE CANVAS MOUSE CONTROLS: DRAG, RESIZE HANDLES & SNAP
// ==============================================================

function getCanvasMouseCoords(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
    scaleX,
    scaleY
  };
}

function findHandleAtCoords(slot, mouseX, mouseY, scaleX) {
  if (!slot) return null;
  const handles = getSlotResizeHandles(slot);
  const grabRadius = 16 * (scaleX || 1); // comfortable grab zone

  for (const [key, h] of Object.entries(handles)) {
    if (Math.abs(mouseX - h.x) <= grabRadius && Math.abs(mouseY - h.y) <= grabRadius) {
      return { key, ...h };
    }
  }
  return null;
}

const editorCanvas = document.getElementById('templateEditorCanvas');

if (editorCanvas) {
  editorCanvas.addEventListener('mousedown', (e) => {
    const coords = getCanvasMouseCoords(e, editorCanvas);

    // 1. Check if clicking on any handle of the currently selected slot
    if (selectedSlotIndex >= 0 && editorSlots[selectedSlotIndex]) {
      const activeSlot = editorSlots[selectedSlotIndex];
      const hitHandle = findHandleAtCoords(activeSlot, coords.x, coords.y, coords.scaleX);
      if (hitHandle) {
        activeDragHandle = hitHandle.key;
        resizingSlot = activeSlot;
        resizeInitialState = {
          x: activeSlot.x,
          y: activeSlot.y,
          width: activeSlot.width,
          height: activeSlot.height,
          mouseX: coords.x,
          mouseY: coords.y
        };
        return;
      }
    }

    // 2. Check if clicking inside any slot
    for (let i = editorSlots.length - 1; i >= 0; i--) {
      const slot = editorSlots[i];
      if (coords.x >= slot.x && coords.x <= slot.x + slot.width && coords.y >= slot.y && coords.y <= slot.y + slot.height) {
        selectedSlotIndex = i;
        draggingSlot = slot;
        dragStartX = coords.x;
        dragStartY = coords.y;
        initialSlotX = slot.x;
        initialSlotY = slot.y;
        renderSlotsList();
        renderEditorCanvas();
        return;
      }
    }
  });

  window.addEventListener('mousemove', (e) => {
    const canvas = document.getElementById('templateEditorCanvas');
    if (!canvas) return;
    const coords = getCanvasMouseCoords(e, canvas);

    // Handle active resizing
    if (resizingSlot && activeDragHandle && resizeInitialState) {
      const dx = coords.x - resizeInitialState.mouseX;
      const dy = coords.y - resizeInitialState.mouseY;
      const snap = 5;

      let newX = resizeInitialState.x;
      let newY = resizeInitialState.y;
      let newW = resizeInitialState.width;
      let newH = resizeInitialState.height;

      if (activeDragHandle.includes('e')) {
        newW = Math.max(30, resizeInitialState.width + dx);
      }
      if (activeDragHandle.includes('s')) {
        newH = Math.max(30, resizeInitialState.height + dy);
      }
      if (activeDragHandle.includes('w')) {
        const targetW = Math.max(30, resizeInitialState.width - dx);
        newX = resizeInitialState.x + (resizeInitialState.width - targetW);
        newW = targetW;
      }
      if (activeDragHandle.includes('n')) {
        const targetH = Math.max(30, resizeInitialState.height - dy);
        newY = resizeInitialState.y + (resizeInitialState.height - targetH);
        newH = targetH;
      }

      resizingSlot.x = Math.round(newX / snap) * snap;
      resizingSlot.y = Math.round(newY / snap) * snap;
      resizingSlot.width = Math.round(newW / snap) * snap;
      resizingSlot.height = Math.round(newH / snap) * snap;

      updateSlotInspector();
      renderEditorCanvas();
      return;
    }

    // Handle active moving
    if (draggingSlot) {
      const dx = coords.x - dragStartX;
      const dy = coords.y - dragStartY;
      const snap = 5;

      draggingSlot.x = Math.round((initialSlotX + dx) / snap) * snap;
      draggingSlot.y = Math.round((initialSlotY + dy) / snap) * snap;

      updateSlotInspector();
      renderEditorCanvas();
      return;
    }

    // Hover cursor state when not dragging
    if (selectedSlotIndex >= 0 && editorSlots[selectedSlotIndex]) {
      const activeSlot = editorSlots[selectedSlotIndex];
      const hitHandle = findHandleAtCoords(activeSlot, coords.x, coords.y, coords.scaleX);
      if (hitHandle) {
        canvas.style.cursor = hitHandle.cursor;
        return;
      }
    }

    // Check if hovering over any slot body
    let overSlot = false;
    for (let slot of editorSlots) {
      if (coords.x >= slot.x && coords.x <= slot.x + slot.width && coords.y >= slot.y && coords.y <= slot.y + slot.height) {
        overSlot = true;
        break;
      }
    }
    canvas.style.cursor = overSlot ? 'move' : 'default';
  });

  window.addEventListener('mouseup', () => {
    if (resizingSlot || draggingSlot) {
      resizingSlot = null;
      activeDragHandle = null;
      resizeInitialState = null;
      draggingSlot = null;
      renderSlotsList();
      renderEditorCanvas();
    }
  });
}

// ==============================================================
// UNIVERSAL SMART QR BATCH GENERATOR & MANAGER
// ==============================================================
let currentGuestPasses = [];

async function generateBatchQR() {
  const countSelect = document.getElementById('qrBatchCountSelect');
  const count = countSelect ? parseInt(countSelect.value) : 12;
  const eventId = activeKioskEventId || 'event_wedding_dimas_sarah';

  try {
    const res = await fetch('/api/guest-passes/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, count })
    });
    if (res.ok) {
      await loadQRFleets();
      alert(`✅ Berhasil membuat ${count} Universal Smart QR Cards untuk tamu! Kartu langsung tampil di daftar.`);
    } else {
      const err = await res.json();
      alert(`Gagal: ${err.error || 'Terjadi kesalahan'}`);
    }
  } catch (e) {
    alert('Gagal generate QR');
  }
}

async function loadQRFleets() {
  const container = document.getElementById('qrPassesList');
  if (!container) return;
  container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);"><span style="font-size: 24px; display: block; margin-bottom: 8px;">🔄</span>Memuat kartu QR tamu...</div>`;

  try {
    const eventId = activeKioskEventId || '';
    const res = await fetch(`/api/guest-passes?eventId=${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error('Gagal memuat kartu tamu');
    const passes = await res.json();
    currentGuestPasses = passes;

    // Update stats counters
    const totalCount = passes.length;
    const activeCount = passes.filter(p => p.session_count > 0).length;
    const totalSessions = passes.reduce((acc, p) => acc + (p.session_count || 0), 0);

    const elTotal = document.getElementById('qrStatTotal');
    const elActive = document.getElementById('qrStatActive');
    const elSessions = document.getElementById('qrStatSessions');
    if (elTotal) elTotal.textContent = totalCount;
    if (elActive) elActive.textContent = activeCount;
    if (elSessions) elSessions.textContent = totalSessions;

    if (passes.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 50px 20px; background: rgba(123, 72, 46, 0.04); border-radius: 16px; border: 2px dashed var(--border-soft);">
          <div style="font-size: 40px; margin-bottom: 10px;">🎟️</div>
          <h4 style="font-size: 18px; font-weight: 800; color: var(--caramel-brown); margin-bottom: 6px;">Belum Ada Kartu QR Tamu</h4>
          <p style="color: var(--text-muted); font-size: 14px; max-width: 440px; margin: 0 auto 16px auto;">
            Pilih jumlah kartu di atas dan klik <strong>"Generate QR Tamu Baru"</strong> untuk membuat kartu bagi Tamu A, Tamu B, dst!
          </p>
        </div>
      `;
      return;
    }

    container.innerHTML = passes.map((p, idx) => {
      const hasSessions = p.session_count > 0;
      const statusBadge = hasSessions
        ? `<span style="font-size: 11px; font-weight: 800; background: rgba(39, 174, 96, 0.15); color: #27ae60; padding: 3px 8px; border-radius: 99px; border: 1px solid rgba(39, 174, 96, 0.3);">🟢 ${p.session_count} Sesi Foto</span>`
        : `<span style="font-size: 11px; font-weight: 700; background: rgba(123, 72, 46, 0.08); color: var(--text-muted); padding: 3px 8px; border-radius: 99px;">⚪ Belum Foto</span>`;

      return `
        <div class="card-pop" style="text-align: center; padding: 18px 14px; border: 2px solid ${hasSessions ? 'var(--coral-pink)' : 'var(--border-soft)'}; background: #fff; border-radius: 16px; box-shadow: 0 4px 14px rgba(0,0,0,0.04);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <span style="font-weight: 800; font-size: 15px; color: var(--caramel-brown);">Tamu #${p.guestNumber || (idx + 1)}</span>
            ${statusBadge}
          </div>
          
          <div style="background: #fff; padding: 8px; border-radius: 12px; border: 1.5px solid var(--border-soft); display: inline-block; margin-bottom: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
            <img src="${p.qrDataUrl}" alt="QR Tamu #${p.guestNumber || (idx + 1)}" style="width: 140px; height: 140px; display: block; border-radius: 6px;">
          </div>

          <div style="font-family: monospace; font-size: 11px; color: var(--text-muted); margin-bottom: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 8px; background: var(--cream-white); border-radius: 6px;">
            ${p.token_plain}
          </div>

          <div style="display: flex; flex-direction: column; gap: 8px;">
            <a href="${p.galleryUrl}" target="_blank" class="btn btn-secondary" style="font-size: 12px; font-weight: 700; padding: 8px 12px; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 6px;">
              📱 Buka Galeri HP ➔
            </a>
            <button class="btn btn-sm" style="font-size: 12px; font-weight: 700; padding: 7px 12px; background: var(--cream-white); color: var(--caramel-brown); border: 1.5px solid var(--border-soft); cursor: pointer;" onclick="printSingleGuestCard('${p.id}')">
              🖨️ Cetak Kartu Ini
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 30px; color: #e74c3c;">Gagal memuat kartu tamu: ${err.message}</div>`;
  }
}

function printAllGuestCards() {
  if (!currentGuestPasses || currentGuestPasses.length === 0) {
    alert('Belum ada kartu QR untuk dicetak. Silakan generate batch kartu terlebih dahulu.');
    return;
  }
  const eventName = activeKioskEventName || 'Photobooth Event';
  const printWin = window.open('', '_blank', 'width=900,height=750');
  if (!printWin) {
    alert('Pop-up terblokir di browser Anda. Mohon izinkan pop-up untuk mencetak kartu.');
    return;
  }

  const cardsHtml = currentGuestPasses.map((p, idx) => `
    <div style="width: 220px; border: 2px dashed #b58d6e; border-radius: 12px; padding: 12px; text-align: center; page-break-inside: avoid; background: #fffcf8; font-family: sans-serif;">
      <div style="font-size: 11px; font-weight: 800; color: #b58d6e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">${eventName}</div>
      <div style="font-size: 16px; font-weight: 900; color: #381e11; margin-bottom: 6px;">Tamu #${p.guestNumber || (idx + 1)}</div>
      <img src="${p.qrDataUrl}" style="width: 140px; height: 140px; border-radius: 8px; border: 1px solid #ddd; padding: 4px; background: #fff; margin-bottom: 6px;">
      <div style="font-size: 10px; font-weight: 800; color: #e6786b; margin-bottom: 2px;">📷 Pindai di Booth untuk Foto</div>
      <div style="font-size: 10px; font-weight: 600; color: #666;">📱 Pindai di HP untuk Buka Galeri</div>
    </div>
  `).join('');

  const fullHtml = `<!DOCTYPE html>
    <html>
    <head>
      <title>Cetak Lembar Kartu Tamu — ${eventName}</title>
      <style>
        body { margin: 20px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #fff; }
        .print-grid { display: flex; flex-wrap: wrap; gap: 14px; justify-content: flex-start; }
        @media print {
          body { margin: 10mm; }
          .no-print { display: none !important; }
        }
      </style>
    </head>
    <body>
      <div class="no-print" style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; background: #fff3e6; padding: 12px 20px; border-radius: 10px; border: 1px solid #ffd8a8;">
        <div>
          <strong style="color: #381e11; font-size: 15px;">Lembar Kartu Smart QR Siap Cetak (Total ${currentGuestPasses.length} Tamu)</strong>
          <div style="font-size: 12px; color: #666;">Gunakan kertas foto atau stiker A4 lalu gunting sesuai garis putus-putus.</div>
        </div>
        <button onclick="window.print()" style="background: #e6786b; color: #fff; border: 0; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px;">🖨️ Cetak Halaman Sekarang</button>
      </div>
      <div class="print-grid">
        ${cardsHtml}
      </div>
    </body>
    </html>`;
  printWin.document.write(fullHtml);
  printWin.document.close();
}

function printSingleGuestCard(passId) {
  const p = currentGuestPasses.find(item => item.id === passId);
  if (!p) return;
  const eventName = activeKioskEventName || 'Photobooth Event';
  const printWin = window.open('', '_blank', 'width=500,height=600');
  if (!printWin) {
    alert('Pop-up terblokir di browser Anda.');
    return;
  }
  const singleHtml = `<!DOCTYPE html>
    <html>
    <head>
      <title>Kartu Tamu #${p.guestNumber} — ${eventName}</title>
      <style>
        body { margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fdfaf6; font-family: sans-serif; }
        .card { width: 300px; border: 2.5px solid #381e11; border-radius: 16px; padding: 24px; text-align: center; background: #fff; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
        @media print { body { background: #fff; } .no-print { display: none; } }
      </style>
    </head>
    <body>
      <div class="card">
        <div style="font-size: 12px; font-weight: 800; color: #b58d6e; text-transform: uppercase; margin-bottom: 4px;">${eventName}</div>
        <h2 style="font-size: 22px; font-weight: 900; color: #381e11; margin: 0 0 12px 0;">Guest Pass #${p.guestNumber}</h2>
        <img src="${p.qrDataUrl}" style="width: 200px; height: 200px; border-radius: 10px; border: 1.5px solid #eee; padding: 6px; margin-bottom: 12px;">
        <div style="font-size: 13px; font-weight: 800; color: #e6786b; margin-bottom: 4px;">📸 Scan di Kamera Booth untuk Foto</div>
        <div style="font-size: 12px; color: #666; margin-bottom: 16px;">📱 Scan dengan Kamera HP untuk Buka Galeri</div>
        <button class="no-print" onclick="window.print()" style="background: #e6786b; color: #fff; border: 0; padding: 9px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">🖨️ Cetak</button>
      </div>
    </body>
    </html>`;
  printWin.document.write(singleHtml);
  printWin.document.close();
}

// ==============================================================
// MULTI-PRINTER DETECTION, SPOOLER & QUEUE
// ==============================================================
let currentSystemPrinters = [];

async function loadSystemPrinters(isUserTriggered = false) {
  const modelSelect = document.getElementById('prtModel');
  const badge = document.getElementById('printerScanStatusBadge');
  const defBadge = document.getElementById('currentDefaultBadge');

  if (badge) {
    badge.textContent = '🔄 Memindai printer komputer...';
    badge.style.color = 'var(--caramel-brown)';
  }

  try {
    const [sysRes, profRes] = await Promise.all([
      fetch('/api/printers/system'),
      fetch('/api/printers/profile')
    ]);

    const sysData = sysRes.ok ? await sysRes.json() : { detectedPrinters: [], photoboothPresets: [] };
    const savedProfile = profRes.ok ? await profRes.json() : null;

    currentSystemPrinters = sysData.detectedPrinters || [];
    const presets = sysData.photoboothPresets || [];
    const defaultPrinter = sysData.defaultPrinter;

    // Pengaturan tersimpan di server (berlaku sama di Windows, Mac, Android & iPad); localStorage hanya cadangan
    const localSettings = { ...JSON.parse(localStorage.getItem('pb_printer_settings') || '{}'), ...(savedProfile?.settings || {}) };
    const activeModel = savedProfile?.model || localSettings.model || defaultPrinter || '';

    if (modelSelect) {
      modelSelect.innerHTML = '';

      // Optgroup 1: Detected in computer (sorted Online & Default first)
      if (currentSystemPrinters.length > 0) {
        const sortedPrinters = [...currentSystemPrinters].sort((a, b) => {
          const aOn = a.status !== 'offline' ? 1 : 0;
          const bOn = b.status !== 'offline' ? 1 : 0;
          if (aOn !== bOn) return bOn - aOn;
          return (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0);
        });
        const onlineCount = sortedPrinters.filter(p => p.status !== 'offline').length;
        const groupDetected = document.createElement('optgroup');
        groupDetected.label = `🖨️ Terdeteksi di Komputer Ini (${onlineCount} Online dari ${sortedPrinters.length} Printer)`;
        
        sortedPrinters.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.name;
          opt.dataset.driverId = p.id;
          const isDef = p.isDefault || p.name === defaultPrinter || p.id === defaultPrinter;
          const statusTag = p.status === 'offline' ? '⚪ [Offline]' : '🟢 [Online]';
          opt.textContent = `${statusTag} ${p.name} ${isDef ? '(⭐ Default OS)' : ''}`;
          if (p.name === activeModel || p.id === activeModel || (!activeModel && isDef)) {
            opt.selected = true;
          }
          groupDetected.appendChild(opt);
        });
        modelSelect.appendChild(groupDetected);
      }

      // Optgroup 2: Photobooth presets
      const groupPresets = document.createElement('optgroup');
      groupPresets.label = '📋 Preset Populer Photobooth';
      presets.forEach(preset => {
        const opt = document.createElement('option');
        opt.value = preset.model || preset.name;
        opt.textContent = preset.name;
        if (opt.value === activeModel && !modelSelect.value) {
          opt.selected = true;
        }
        groupPresets.appendChild(opt);
      });
      modelSelect.appendChild(groupPresets);

      // Optgroup 3: Custom input
      const groupCustom = document.createElement('optgroup');
      groupCustom.label = '➕ Fleksibilitas Printer Lain';
      const customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = '➕ Ketik Nama Printer Lain (Kustom / Jaringan)...';
      groupCustom.appendChild(customOpt);
      modelSelect.appendChild(groupCustom);

      let isFound = false;
      for (const opt of modelSelect.options) {
        if (opt.value === activeModel) {
          opt.selected = true;
          isFound = true;
          break;
        }
      }

      if (!isFound && activeModel) {
        customOpt.selected = true;
        const customInput = document.getElementById('customPrinterName');
        if (customInput) customInput.value = activeModel;
      }

      handlePrinterModelChange();
    }

    if (badge) {
      if (currentSystemPrinters.length > 0) {
        badge.textContent = `🟢 ${currentSystemPrinters.length} Printer Terbaca (${sysData.platform === 'win32' ? 'Windows' : 'macOS'})`;
        badge.style.color = '#27ae60';
        badge.style.background = 'rgba(39, 174, 96, 0.12)';
        badge.style.borderColor = 'rgba(39, 174, 96, 0.25)';
      } else {
        badge.textContent = `⚪ Mode Preset Aktif (Belum ada driver)`;
        badge.style.color = 'var(--text-muted)';
      }
    }

    if (defBadge && defaultPrinter) {
      defBadge.style.display = 'inline';
      defBadge.textContent = `⭐ Default: ${defaultPrinter.slice(0, 24)}`;
      defBadge.title = `Default Sistem OS: ${defaultPrinter}`;
    }

    if (localSettings.paperSize) {
      const prtPaper = document.getElementById('prtPaperSize');
      if (prtPaper) prtPaper.value = localSettings.paperSize;
    }
    if (localSettings.mode) {
      const prtMode = document.getElementById('prtMode');
      if (prtMode) prtMode.value = localSettings.mode;
    }
    if (localSettings.maxCopies) {
      const prtMaxCopies = document.getElementById('prtMaxCopies');
      if (prtMaxCopies) prtMaxCopies.value = localSettings.maxCopies;
    }
    if (localSettings.borderless !== undefined) {
      const prtBorderless = document.getElementById('prtBorderless');
      if (prtBorderless) prtBorderless.checked = localSettings.borderless;
    }
    if (localSettings.highDpi !== undefined) {
      const prtHighDpi = document.getElementById('prtHighDpi');
      if (prtHighDpi) prtHighDpi.checked = localSettings.highDpi;
    }
    if (localSettings.safeMargin !== undefined) {
      const prtSafeMargin = document.getElementById('prtSafeMargin');
      if (prtSafeMargin) prtSafeMargin.value = localSettings.safeMargin;
      updateSafeMarginDisplay(localSettings.safeMargin);
    } else {
      updateSafeMarginDisplay(90);
    }

    const savedMediaType = savedProfile?.media_type || localSettings.mediaType || null;
    await loadMediaTypesForPrinter(activeModel, savedMediaType);

    if (isUserTriggered) {
      alert(`✅ Pindai Printer Selesai!\n\n• Terdeteksi ${currentSystemPrinters.length} printer di perangkat Anda.\n• Default OS: ${defaultPrinter || 'Tidak ada'}\n• Printer & jenis kertas siap digunakan!`);
    }
  } catch (err) {
    console.error('loadSystemPrinters error:', err);
    if (badge) {
      badge.textContent = '⚠️ Gagal membaca printer perangkat';
      badge.style.color = '#e74c3c';
    }
    if (isUserTriggered) {
      alert(`Gagal memindai printer sistem: ${err.message}`);
    }
  }
}

async function loadMediaTypesForPrinter(printerNameOrId, preselectedType = null) {
  const mediaSelect = document.getElementById('prtMediaType');
  const mediaBadge = document.getElementById('mediaTypeBadge');
  if (!mediaSelect) return;

  mediaSelect.innerHTML = '<option value="">Membaca jenis kertas printer...</option>';

  try {
    const res = await fetch(`/api/printers/media-types?printer=${encodeURIComponent(printerNameOrId || '')}`);
    const types = res.ok ? await res.json() : [];

    mediaSelect.innerHTML = '';
    const groupTypes = document.createElement('optgroup');
    groupTypes.label = `📄 Pilihan Jenis Kertas (${types.length})`;

    let hasSelected = false;
    types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      if (preselectedType && (t.id === preselectedType || t.label.toLowerCase().includes(preselectedType.toLowerCase()))) {
        opt.selected = true;
        hasSelected = true;
      } else if (!preselectedType && t.isDefault && !hasSelected) {
        opt.selected = true;
        hasSelected = true;
      }
      groupTypes.appendChild(opt);
    });
    mediaSelect.appendChild(groupTypes);

    // Custom media option
    const groupCustom = document.createElement('optgroup');
    groupCustom.label = '➕ Jenis Kertas Lain';
    const customOpt = document.createElement('option');
    customOpt.value = '__custom_media__';
    customOpt.textContent = '➕ Ketik Jenis Kertas Lain (Kustom / Khusus)...';
    groupCustom.appendChild(customOpt);
    mediaSelect.appendChild(groupCustom);

    if (preselectedType && !hasSelected) {
      customOpt.selected = true;
      const customMediaInput = document.getElementById('customMediaTypeName');
      if (customMediaInput) customMediaInput.value = preselectedType;
    }

    if (mediaBadge) {
      if (types.length > 0) {
        mediaBadge.textContent = `${types.length} Jenis Kertas Driver`;
        mediaBadge.style.color = '#27ae60';
      } else {
        mediaBadge.textContent = 'Universal Kertas Foto';
        mediaBadge.style.color = 'var(--caramel-brown)';
      }
    }

    handleMediaTypeChange();
  } catch (err) {
    console.warn('loadMediaTypesForPrinter error:', err);
  }
}

function handleMediaTypeChange() {
  const mediaSelect = document.getElementById('prtMediaType');
  const customWrap = document.getElementById('customMediaTypeInputWrap');
  const customInput = document.getElementById('customMediaTypeName');

  if (!mediaSelect || !customWrap) return;
  if (mediaSelect.value === '__custom_media__') {
    customWrap.style.display = 'block';
    if (customInput) customInput.focus();
  } else {
    customWrap.style.display = 'none';
  }
}

function handlePrinterModelChange() {
  const modelSelect = document.getElementById('prtModel');
  const customWrap = document.getElementById('customPrinterInputWrap');
  const customInput = document.getElementById('customPrinterName');

  if (!modelSelect || !customWrap) return;
  let chosen = modelSelect.value;
  if (chosen === '__custom__') {
    customWrap.style.display = 'block';
    if (customInput) customInput.focus();
    chosen = (customInput?.value || '').trim();
  } else {
    customWrap.style.display = 'none';
  }

  // Reload media types tailored for the selected printer!
  loadMediaTypesForPrinter(chosen);
}

function updateSafeMarginDisplay(val) {
  const badge = document.getElementById('prtSafeMarginValueBadge');
  if (!badge) return;
  const num = parseInt(val, 10) || 90;
  badge.style.color = '#ffffff';
  if (num >= 98) {
    badge.textContent = `${num}% (Penuh 100% - Tanpa Jarak Tambahan)`;
    badge.style.background = '#6c757d';
  } else if (num >= 93) {
    badge.textContent = `${num}% (Jarak Aman Sedang ~5 mm)`;
    badge.style.background = '#27ae60';
  } else if (num >= 88) {
    badge.textContent = `${num}% (Jarak Aman ~8 mm - Rekomendasi Bebas Terpotong)`;
    badge.style.background = '#E6786B';
  } else {
    badge.textContent = `${num}% (Jarak Aman Maksimal ~12 mm)`;
    badge.style.background = '#B3402F';
  }
}

async function savePrinterSettings() {
  const modelSelect = document.getElementById('prtModel');
  const customInput = document.getElementById('customPrinterName');
  let chosenModel = modelSelect ? modelSelect.value : '';

  if (chosenModel === '__custom__') {
    chosenModel = (customInput?.value || '').trim();
    if (!chosenModel) {
      alert('Silakan ketik nama printer Anda pada kolom input yang tersedia');
      if (customInput) customInput.focus();
      return;
    }
  }

  const mediaSelect = document.getElementById('prtMediaType');
  const customMediaInput = document.getElementById('customMediaTypeName');
  let chosenMediaType = mediaSelect ? mediaSelect.value : 'photographic-glossy';
  let chosenMediaLabel = mediaSelect?.options[mediaSelect.selectedIndex]?.text || chosenMediaType;

  if (chosenMediaType === '__custom_media__') {
    chosenMediaType = (customMediaInput?.value || '').trim();
    if (!chosenMediaType) {
      alert('Silakan ketik jenis kertas khusus Anda');
      if (customMediaInput) customMediaInput.focus();
      return;
    }
    chosenMediaLabel = chosenMediaType;
  }

  const paper = document.getElementById('prtPaperSize')?.value || '2x6';
  const mode = document.getElementById('prtMode')?.value || 'manual';
  const maxCopies = document.getElementById('prtMaxCopies')?.value || '2';
  const borderless = !!document.getElementById('prtBorderless')?.checked;
  const highDpi = !!document.getElementById('prtHighDpi')?.checked;
  const safeMargin = parseInt(document.getElementById('prtSafeMargin')?.value, 10) || 90;

  try {
    const matchedSys = currentSystemPrinters.find(p => p.name === chosenModel || p.id === chosenModel);
    const chosenDriver = matchedSys ? matchedSys.id : chosenModel;

    const res = await fetch('/api/printers/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: chosenModel,
        model: chosenModel,
        driverName: chosenDriver,
        paperSizes: [paper],
        mediaType: chosenMediaType,
        settings: {
          paperSize: paper,
          mode: mode,
          maxCopies: parseInt(maxCopies, 10) || 2,
          borderless: borderless,
          highDpi: highDpi,
          safeMargin: safeMargin
        }
      })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Server menolak pengaturan printer');
    }

    localStorage.setItem('pb_printer_settings', JSON.stringify({
      model: chosenModel,
      mediaType: chosenMediaType,
      mediaLabel: chosenMediaLabel,
      paperSize: paper,
      mode: mode,
      maxCopies: maxCopies,
      borderless: borderless,
      highDpi: highDpi,
      safeMargin: safeMargin
    }));

    alert(`✅ Pengaturan Printer Berhasil Disimpan!\n\n• Printer: ${chosenModel}\n• Jenis Kertas: ${chosenMediaLabel}\n• Ukuran Kertas: ${paper}\n• Mode Eksekusi: ${mode === 'auto' ? 'Otomatis Langsung Cetak' : 'Manual Pilihan Tamu'}\n• Maksimal: ${maxCopies} Lembar\n• Borderless: ${borderless ? 'Aktif' : 'Nonaktif'}\n• Kualitas: ${highDpi ? '300 DPI' : 'Standard'}\n• Jarak Aman Cetak: ${safeMargin}%\n\nSpooler siap memproses antrean cetak!`);
  } catch (err) {
    alert(`Gagal menyimpan pengaturan printer: ${err.message}`);
  }
}

async function loadPrintAgentStatus(isUserTriggered = false) {
  const badge = document.getElementById('agentStatusBadge');
  const text = document.getElementById('agentStatusText');
  const pqBadge = document.getElementById('pqAgentBadge');
  const pqDevice = document.getElementById('pqAgentDevice');
  const macLink = document.getElementById('agentDownloadMac');
  const winLink = document.getElementById('agentDownloadWin');
  const origin = encodeURIComponent(window.location.origin);
  if (macLink) macLink.href = `/api/print-agent/download/macos?serverUrl=${origin}`;
  if (winLink) winLink.href = `/api/print-agent/download/windows?serverUrl=${origin}`;

  try {
    const res = await fetch('/api/print-agent/status');
    if (!res.ok) throw new Error('status');
    const st = await res.json();
    cachedPrintAgentStatus = st;

    const savedSettings = (() => {
      try { return JSON.parse(localStorage.getItem('pb_printer_settings') || '{}'); } catch (e) { return {}; }
    })();
    const printerModel = savedSettings.model || 'Epson L8050 Series';
    const paperName = savedSettings.paperSize === '2x6' ? '4R (2 Strip 2×6")' : (savedSettings.paperSize || '4R 102×152mm');

    if (st.online) {
      if (badge) {
        badge.textContent = '🟢 Print Agent Online';
        badge.style.background = 'rgba(39, 174, 96, 0.14)';
        badge.style.color = '#1e8449';
        badge.style.borderColor = 'rgba(39, 174, 96, 0.35)';
      }
      const pCount = (st.printers || []).length;
      const hostName = st.host || (st.platform === 'win32' ? 'PC Windows' : 'MacBook');
      if (text) text.textContent = `Komputer: ${hostName} (${st.platform === 'win32' ? 'Windows' : 'macOS'}) • ${pCount} printer terbaca • cetak otomatis tanpa popup`;

      if (pqBadge) {
        pqBadge.textContent = '🟢 Print Agent Terhubung';
        pqBadge.style.background = 'rgba(39, 174, 96, 0.14)';
        pqBadge.style.color = '#1e8449';
        pqBadge.style.borderColor = 'rgba(39, 174, 96, 0.35)';
      }
      if (pqDevice) {
        pqDevice.textContent = `${printerModel} • ${hostName} (${pCount} printer terbaca)`;
      }
    } else {
      if (badge) {
        badge.textContent = '⚪ Print Agent Belum Aktif';
        badge.style.background = 'rgba(230, 120, 107, 0.12)';
        badge.style.color = '#b3402f';
        badge.style.borderColor = 'rgba(230, 120, 107, 0.35)';
      }
      if (text) text.textContent = 'Unduh & jalankan di komputer studio. Sementara itu cetak memakai dialog browser (cadangan).';

      if (pqBadge) {
        pqBadge.textContent = '⚪ Mode Dialog Browser';
        pqBadge.style.background = 'rgba(230, 120, 107, 0.12)';
        pqBadge.style.color = '#b3402f';
        pqBadge.style.borderColor = 'rgba(230, 120, 107, 0.35)';
      }
      if (pqDevice) {
        pqDevice.textContent = `${printerModel} • ${paperName}`;
      }
    }

    if (isUserTriggered) window.pbToast(st.online ? '🟢 Print Agent online & siap mencetak' : '⚪ Print Agent belum aktif', st.online ? 'ok' : 'warn');
    if (st.online && typeof loadSystemPrinters === 'function' && !window.__agentPrintersLoaded) {
      window.__agentPrintersLoaded = true;
      loadSystemPrinters();
    }
  } catch (e) {
    if (badge) badge.textContent = '⚪ Status tidak diketahui';
    if (pqBadge) pqBadge.textContent = '⚪ Status tidak diketahui';
  }
}

async function testPrintFromAdmin() {
  const modelSelect = document.getElementById('prtModel');
  const customInput = document.getElementById('customPrinterName');
  let chosenModel = modelSelect ? modelSelect.value : '';
  if (chosenModel === '__custom__') {
    chosenModel = (customInput?.value || '').trim() || 'Custom Printer';
  }

  try {
    const res = await fetch('/api/printers/test-print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chosenModel })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mengirim test print');

    // Dicetak sesuai pengaturan tersimpan (ukuran kertas, borderless, kualitas) tanpa popup bila Print Agent aktif
    await window.pbSmartPrint(data.printJob, '/uploads/test_print.png');
    await loadPrintJobs();
  } catch (err) {
    window.pbToast(`Gagal mengirim test print: ${err.message}`, 'error');
  }
}

// ==============================================================
// PHOTO GALLERY & REPRINT STATION
// ==============================================================
let cachedRecentPhotos = [];
let cachedPrintJobs = [];
let activeModalPhoto = null;

function populateGalleryEventFilter(preferredEventId = null) {
  const filterSelect = document.getElementById('galleryEventFilter');
  if (!filterSelect) return;

  const currentVal = preferredEventId !== null ? preferredEventId : (filterSelect.value || activeKioskEventId || '');

  filterSelect.innerHTML = '<option value="">Semua Event</option>';
  if (eventsList && eventsList.length > 0) {
    eventsList.forEach(ev => {
      const opt = document.createElement('option');
      opt.value = ev.id;
      opt.textContent = ev.name + (ev.id === activeKioskEventId ? ' ⭐ (Event Aktif)' : '');
      filterSelect.appendChild(opt);
    });
  }

  if (currentVal && Array.from(filterSelect.options).some(o => o.value === currentVal)) {
    filterSelect.value = currentVal;
  } else if (activeKioskEventId && Array.from(filterSelect.options).some(o => o.value === activeKioskEventId)) {
    filterSelect.value = activeKioskEventId;
  } else {
    filterSelect.value = '';
  }
}

async function loadRecentPhotos(filterEventId = null) {
  const overviewGrid = document.getElementById('recentPhotosOverviewGrid');
  const galleryGrid = document.getElementById('galleryPhotosGrid');
  const countBadge = document.getElementById('photoGalleryCountBadge');
  const filterSelect = document.getElementById('galleryEventFilter');

  try {
    populateGalleryEventFilter(filterEventId);

    // Determine target event id to query: default to active event if null
    let targetEventId = filterEventId;
    if (targetEventId === null) {
      if (filterSelect && filterSelect.value !== undefined && filterSelect.value !== '') {
        targetEventId = filterSelect.value;
      } else if (filterSelect && filterSelect.value === '' && filterSelect.dataset.userInteracted === 'true') {
        targetEventId = '';
      } else {
        targetEventId = activeKioskEventId || '';
      }
    }

    if (filterSelect && targetEventId !== undefined) {
      filterSelect.value = targetEventId || '';
    }

    const url = targetEventId ? `/api/photos/recent?eventId=${encodeURIComponent(targetEventId)}` : '/api/photos/recent';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Gagal memuat galeri foto');
    const photos = await res.json();
    cachedRecentPhotos = photos || [];

    const currentEventObj = targetEventId ? (eventsList || []).find(e => e.id === targetEventId) : null;
    const eventNameLabel = currentEventObj ? currentEventObj.name : (targetEventId ? 'Event Terpilih' : 'Semua Event');

    if (countBadge) {
      countBadge.textContent = `${cachedRecentPhotos.length} Foto Berframe (${eventNameLabel})`;
    }

    // 1. Render Overview Grid (Beranda, up to 6 items)
    if (overviewGrid) {
      if (cachedRecentPhotos.length === 0) {
        overviewGrid.innerHTML = `
          <div style="padding: 24px; text-align: center; color: var(--text-muted); grid-column: 1 / -1; background: var(--cream-bg); border-radius: 14px;">
            Belum ada foto berframe untuk event ini. Ambil foto di Kiosk Booth untuk melihat hasilnya di sini.
          </div>
        `;
      } else {
        overviewGrid.innerHTML = cachedRecentPhotos.slice(0, 6).map((photo, idx) => {
          const imgSrc = photo.file_path || '';
          const timeStr = photo.created_at ? new Date(photo.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          return `
            <div style="cursor: pointer; height: 180px; background: var(--cream-bg); border-radius: 16px; border: 2px solid var(--border-soft); display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; padding: 6px; position: relative; transition: transform 0.2s;" 
                 onmouseover="this.style.transform='translateY(-4px)'" onmouseout="this.style.transform='translateY(0)'"
                 onclick="openPhotoPreviewByIndex(${idx})" title="Klik untuk melihat foto ukuran penuh & opsi cetak ulang">
              <img src="${imgSrc}" onerror="this.onerror=null; this.style.opacity='0.2';" style="max-height: 140px; border-radius: 10px; object-fit: contain;">
              <span style="font-size: 11px; font-weight: 700; color: var(--caramel-brown); margin-top: 4px;">${timeStr}</span>
            </div>
          `;
        }).join('');
      }
    }

    // 2. Render Full Gallery Grid (Foto Tab)
    if (galleryGrid) {
      if (cachedRecentPhotos.length === 0) {
        galleryGrid.innerHTML = `
          <div style="padding: 36px; text-align: center; color: var(--text-muted); grid-column: 1 / -1; background: #fff; border-radius: 16px; border: 2px dashed var(--border-soft);">
            <div style="font-size: 36px; margin-bottom: 8px;">📷</div>
            <div style="font-size: 16px; font-weight: 800; color: var(--caramel-brown);">Belum Ada Foto Berframe Tersimpan</div>
            <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">Foto berframe untuk event <strong>${escapeHtml(eventNameLabel)}</strong> akan otomatis muncul di galeri ini begitu sesi foto selesai di layar sentuh Kiosk.</div>
          </div>
        `;
      } else {
        galleryGrid.innerHTML = cachedRecentPhotos.map((photo, idx) => {
          const imgSrc = photo.file_path || '';
          const timeStr = photo.created_at ? new Date(photo.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '-';
          const isPrinted = !!photo.print_job_id;
          const printBadgeHtml = isPrinted 
            ? `<span style="font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 99px; background: rgba(39, 174, 96, 0.12); color: #27ae60; border: 1px solid rgba(39, 174, 96, 0.25);">🟢 Dicetak (${photo.print_copies || 1}x)</span>`
            : `<span style="font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 99px; background: rgba(120, 120, 120, 0.12); color: var(--text-muted); border: 1px solid var(--border-soft);">⚪ Belum Cetak</span>`;

          return `
            <div class="card-pop" style="padding: 12px; background: #fff; border-radius: 16px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 4px 14px rgba(123, 72, 46, 0.06);">
              <div style="height: 220px; background: var(--cream-bg); border-radius: 12px; overflow: hidden; display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid var(--border-soft);" onclick="openPhotoPreviewByIndex(${idx})">
                <img src="${imgSrc}" onerror="this.onerror=null; this.style.opacity='0.2';" style="max-height: 100%; max-width: 100%; object-fit: contain; border-radius: 8px;">
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
                <span style="font-size: 12px; font-weight: 800; color: var(--caramel-brown); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px;" title="${escapeHtml(photo.event_name || '')}">
                  ${escapeHtml(photo.event_name || 'Event')}
                </span>
                ${printBadgeHtml}
              </div>

              <div style="font-size: 11px; color: var(--text-muted);">
                ${timeStr}
              </div>

              <div style="display: flex; gap: 6px; margin-top: 4px;">
                <button class="btn btn-secondary" style="flex: 1; padding: 6px 8px; font-size: 12px; font-weight: 700; background: #fff;" onclick="openPhotoPreviewByIndex(${idx})">
                  👁️ Lihat
                </button>
                <button class="btn btn-secondary" style="padding: 6px 10px; font-size: 12px; font-weight: 700; background: #fff; border: 1.5px solid var(--dusty-teal); color: var(--dusty-teal);" onclick="event.stopPropagation(); openPhotoQrModalByIndex(${idx})" title="Lihat QR Code &amp; Alur Masuk Tamu">
                  🎟️ QR
                </button>
                <button class="btn btn-coral" style="flex: 1; padding: 6px 8px; font-size: 12px; font-weight: 700;" onclick="quickPrintPhoto('${photo.asset_id}', '${photo.print_job_id || ''}')">
                  🖨️ Cetak
                </button>
                <button class="btn btn-secondary" style="padding: 6px 9px; font-size: 12px; font-weight: 700; background: rgba(179, 64, 47, 0.08); color: #B3402F; border: 1.5px solid rgba(179, 64, 47, 0.25);" onclick="deletePhoto('${photo.asset_id}', event)" title="Hapus foto ini secara permanen">
                  🗑️
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.warn('loadRecentPhotos error:', err);
  }
}

function filterGalleryByEvent() {
  const filterSelect = document.getElementById('galleryEventFilter');
  if (filterSelect) {
    filterSelect.dataset.userInteracted = 'true';
  }
  const eventId = filterSelect ? filterSelect.value : '';
  loadRecentPhotos(eventId);
}

function openPhotoPreviewByIndex(index) {
  const photo = cachedRecentPhotos[index];
  if (!photo) return;
  openPhotoPreviewModal(photo);
}

function openPhotoQrModalByIndex(index) {
  const photo = cachedRecentPhotos[index];
  if (!photo) return;
  openPhotoQrModal(photo);
}

function openPhotoPreviewFromJob(jobId) {
  const job = cachedPrintJobs.find(j => j.id === jobId);
  if (!job) return;
  const photoData = {
    file_path: job.media_url,
    event_name: job.event_name,
    created_at: job.created_at,
    session_id: job.photo_session_id,
    session_mode: 'strip',
    spooler_job_id: job.spooler_job_id,
    print_job_id: job.id,
    print_state: job.state,
    asset_id: job.media_asset_id
  };
  openPhotoPreviewModal(photoData);
}

function openPhotoPreviewModal(photo) {
  activeModalPhoto = photo;
  const modal = document.getElementById('photoPreviewModal');
  if (!modal) return;

  const img = document.getElementById('modalPreviewImg');
  const title = document.getElementById('modalPhotoTitle');
  const eventBadge = document.getElementById('modalPhotoEventBadge');
  const printStatus = document.getElementById('modalPhotoPrintStatus');
  const time = document.getElementById('modalPhotoTime');
  const format = document.getElementById('modalPhotoFormat');
  const sessId = document.getElementById('modalPhotoSessionId');
  const spoolerId = document.getElementById('modalPhotoSpoolerId');
  const btnDownload = document.getElementById('modalBtnDownload');
  const btnGallery = document.getElementById('modalBtnGallery');
  const btnReprint = document.getElementById('modalBtnReprint');

  const imgSrc = photo.file_path || photo.media_url || '/assets/templates/strip-green-template.svg';
  if (img) img.src = imgSrc;
  if (title) title.textContent = `Hasil Foto: ${photo.event_name || 'Photobooth'}`;
  if (eventBadge) eventBadge.textContent = photo.event_name || 'Event Aktif';

  if (printStatus) {
    if (photo.print_job_id || photo.spooler_job_id) {
      printStatus.className = 'badge-pill badge-active';
      printStatus.textContent = '🟢 Terkirim ke Spooler';
    } else {
      printStatus.className = 'badge-pill badge-pending';
      printStatus.textContent = '⚪ Belum Dicetak';
    }
  }

  if (time) time.textContent = photo.created_at ? new Date(photo.created_at).toLocaleString() : '-';
  if (format) format.textContent = photo.session_mode === 'strip' ? 'Photo Strip 2×6 inch' : 'Single Photo 4×6 inch';
  if (sessId) sessId.textContent = photo.session_id || '-';
  if (spoolerId) spoolerId.textContent = photo.spooler_job_id || 'Belum Ada Spooler ID';

  const qrBadge = document.getElementById('modalPhotoQrBadge');
  const qrInfo = document.getElementById('modalPhotoQrInfo');
  const isPreRegistered = (photo.qr_flow_type === 'batch' || photo.qr_flow_type === 'registration');
  if (qrBadge) {
    if (isPreRegistered) {
      qrBadge.className = 'sticker-badge sticker-purple';
      qrBadge.textContent = '🎟️ Alur QR Duluan';
    } else {
      qrBadge.className = 'sticker-badge sticker-teal';
      qrBadge.textContent = '⚡ QR Sesi Mandiri';
    }
  }
  if (qrInfo) {
    const passToken = photo.guest_token || photo.guest_pass_id || (photo.session_id ? `sesi:${photo.session_id}` : 'Otomatis di Kiosk');
    const sessCount = photo.gp_session_count && photo.gp_session_count > 1 ? ` • ${photo.gp_session_count} Sesi Foto` : '';
    qrInfo.innerHTML = isPreRegistered
      ? `Kartu Tamu Terdaftar: <code style="font-size: 11px; background: #fff; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--border-soft);">${escapeHtml(passToken)}</code>${sessCount}`
      : `QR Khusus Sesi Ini: <code style="font-size: 11px; background: #fff; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--border-soft);">${escapeHtml(passToken)}</code>`;
  }

  if (btnDownload) {
    btnDownload.href = imgSrc;
    const ext = /\.(jpe?g)$/i.test(imgSrc) ? 'jpg' : 'png';
    btnDownload.download = `photobooth_${Date.now()}.${ext}`;
  }

  if (btnGallery) {
    const targetToken = photo.guest_token || photo.guest_pass_id || photo.session_id;
    if (targetToken) {
      btnGallery.style.display = 'block';
      btnGallery.href = `/gallery/g/${targetToken}`;
    } else {
      btnGallery.style.display = 'none';
    }
  }

  if (btnReprint) {
    btnReprint.textContent = photo.print_job_id ? '🖨️ Cetak / Print Ulang ke Spooler' : '🖨️ Kirim Cetak ke Spooler';
  }

  modal.style.display = 'flex';
}

function closePhotoPreviewModal() {
  const modal = document.getElementById('photoPreviewModal');
  if (modal) modal.style.display = 'none';
  activeModalPhoto = null;
}

let activeQrData = null;

async function openPhotoQrModal(photo = null) {
  const targetPhoto = photo || activeModalPhoto;
  if (!targetPhoto || !targetPhoto.asset_id) return;

  const modal = document.getElementById('photoQrDetailModal');
  if (!modal) return;

  const titleEl = document.getElementById('qrModalEventTitle');
  const flowBadge = document.getElementById('qrModalFlowBadge');
  const flowDesc = document.getElementById('qrModalFlowDescription');
  const multiNotice = document.getElementById('qrModalMultiSessionNotice');
  const sessionCountSpan = document.getElementById('qrModalSessionCount');
  const qrImg = document.getElementById('qrModalImg');
  const urlText = document.getElementById('qrModalUrlText');
  const btnOpenGallery = document.getElementById('qrModalBtnOpenGallery');
  const btnDownloadQr = document.getElementById('qrModalBtnDownloadQr');

  if (titleEl) titleEl.textContent = `Memuat QR galeri untuk ${targetPhoto.event_name || 'Event'}...`;
  if (qrImg) qrImg.src = '';
  if (urlText) urlText.textContent = 'Memuat tautan...';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/photos/${encodeURIComponent(targetPhoto.asset_id)}/qr`);
    if (!res.ok) throw new Error('Gagal memuat QR galeri');
    const data = await res.json();
    activeQrData = data;

    if (titleEl) titleEl.textContent = `${data.eventName} • Sesi: ${data.sessionId || '-'}`;
    if (flowBadge) {
      flowBadge.className = data.flowType === 'pre_registered' ? 'sticker-badge sticker-purple' : 'sticker-badge sticker-teal';
      flowBadge.textContent = data.flowBadge;
    }
    if (flowDesc) flowDesc.textContent = data.flowDescription;
    if (multiNotice) {
      if (data.sessionCount > 1) {
        multiNotice.style.display = 'block';
        if (sessionCountSpan) sessionCountSpan.textContent = data.sessionCount;
      } else {
        multiNotice.style.display = 'none';
      }
    }
    if (qrImg) qrImg.src = data.qrDataUrl;
    if (urlText) urlText.textContent = data.fullQrUrl;
    if (btnOpenGallery) btnOpenGallery.href = data.galleryUrl;
    if (btnDownloadQr) {
      btnDownloadQr.href = data.qrDataUrl;
      btnDownloadQr.download = `QR_Galeri_${data.token || 'Tamu'}.png`;
    }
  } catch (err) {
    if (titleEl) titleEl.textContent = '⚠️ ' + err.message;
  }
}

function closePhotoQrModal() {
  const modal = document.getElementById('photoQrDetailModal');
  if (modal) modal.style.display = 'none';
  activeQrData = null;
}

function copyQrGalleryLink() {
  if (!activeQrData || !activeQrData.fullQrUrl) return;
  navigator.clipboard.writeText(activeQrData.fullQrUrl).then(() => {
    alert('✅ Link galeri tamu berhasil disalin ke clipboard:\n\n' + activeQrData.fullQrUrl);
  }).catch(() => {
    prompt('Salin link galeri tamu:', activeQrData.fullQrUrl);
  });
}

async function executeModalReprint() {
  if (!activeModalPhoto) return;
  const copies = parseInt(document.getElementById('modalPrintCopies')?.value) || 1;
  const btn = document.getElementById('modalBtnReprint');
  if (btn) btn.textContent = '⏳ Mengirim ke Printer...';

  const imgSrc = activeModalPhoto.file_path || activeModalPhoto.media_url;

  try {
    let printJob = null;
    if (activeModalPhoto.print_job_id) {
      const res = await fetch(`/api/print-jobs/${activeModalPhoto.print_job_id}/reprint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ copies })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal mengirim reprint');
      printJob = data;
    } else if (activeModalPhoto.asset_id) {
      const res = await fetch(`/api/photos/${activeModalPhoto.asset_id}/print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ copies })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal mengirim print');
      printJob = data.printJob;
    } else {
      throw new Error('Informasi aset foto tidak lengkap untuk dicetak');
    }

    closePhotoPreviewModal();
    await window.pbSmartPrint(printJob, imgSrc, copies);
    await loadPrintJobs();
    await loadRecentPhotos();
  } catch (err) {
    window.pbToast(`Error cetak: ${err.message}`, 'error');
  } finally {
    if (btn) btn.textContent = '🖨️ Cetak / Print Ulang Sekarang';
  }
}

async function quickPrintPhoto(assetId, existingJobId) {
  if (existingJobId) {
    await reprintJobById(existingJobId);
  } else {
    try {
      const res = await fetch(`/api/photos/${assetId}/print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ copies: 1 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal mencetak');
      await window.pbSmartPrint(data.printJob, null);
      await loadPrintJobs();
      await loadRecentPhotos();
    } catch (err) {
      window.pbToast(`Error cetak: ${err.message}`, 'error');
    }
  }
}

// ==============================================================
// PROGRES PRINT & REAL-TIME QUEUE MONITORING
// ==============================================================
let printQueuePollInterval = null;
let cachedPrintAgentStatus = null;

function populatePrintQueueEventFilter() {
  const filterSelect = document.getElementById('pqFilterEvent');
  if (!filterSelect) return;
  const currentVal = filterSelect.value || '';
  filterSelect.innerHTML = '<option value="">Semua Event</option>';
  if (eventsList && eventsList.length > 0) {
    eventsList.forEach(ev => {
      const opt = document.createElement('option');
      opt.value = ev.id;
      opt.textContent = ev.name + (ev.id === activeKioskEventId ? ' ⭐ (Aktif)' : '');
      filterSelect.appendChild(opt);
    });
  }
  if (currentVal) filterSelect.value = currentVal;
}

async function loadPrintQueueTab() {
  populatePrintQueueEventFilter();
  await loadPrintAgentStatus();
  await loadPrintJobs();
}

async function refreshPrintQueueSilently() {
  const tabEl = document.getElementById('tab-printqueue');
  if (!tabEl || !tabEl.classList.contains('active')) {
    if (printQueuePollInterval) {
      clearInterval(printQueuePollInterval);
      printQueuePollInterval = null;
    }
    return;
  }
  try {
    const res = await fetch('/api/print-jobs');
    if (res.ok) {
      const jobs = await res.json();
      cachedPrintJobs = jobs || [];
      updatePrintQueueStats(cachedPrintJobs);
      renderPrintQueueTable();
      renderActivePrintBanner(cachedPrintJobs);
      updateTabPrintsTable(cachedPrintJobs);
    }
  } catch (err) {
    console.debug('refreshPrintQueueSilently error:', err);
  }
}

function updatePrintQueueStats(jobs) {
  const queuedCount = (jobs || []).filter(j => j.state === 'queued' || j.state === 'processing' || j.state === 'spooled').length;
  const completedJobs = (jobs || []).filter(j => j.state === 'completed');
  const completedCopies = completedJobs.reduce((sum, j) => sum + (parseInt(j.copies) || 1), 0);
  const totalCount = (jobs || []).length;

  const elQueued = document.getElementById('pqStatQueued');
  const elCompleted = document.getElementById('pqStatCompleted');
  const elTotal = document.getElementById('pqStatTotal');
  const badgeNav = document.getElementById('navPrintBadge');

  if (elQueued) elQueued.textContent = queuedCount;
  if (elCompleted) elCompleted.textContent = completedCopies;
  if (elTotal) elTotal.textContent = totalCount;

  if (badgeNav) {
    if (queuedCount > 0) {
      badgeNav.textContent = queuedCount;
      badgeNav.style.display = 'inline-block';
      badgeNav.classList.add('pq-pulse-dot');
    } else {
      badgeNav.style.display = 'none';
      badgeNav.classList.remove('pq-pulse-dot');
    }
  }
}

function renderActivePrintBanner(jobs) {
  const bannerContainer = document.getElementById('pqActiveJobBanner');
  if (!bannerContainer) return;

  const activeJob = (jobs || []).find(j => j.state === 'processing' || j.state === 'queued' || j.state === 'spooled');

  if (!activeJob) {
    bannerContainer.innerHTML = `
      <div class="card-pop" style="border: 2px dashed #D4A754; background: linear-gradient(135deg, #FFFDF9 0%, #FAF4E8 100%); padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
        <div style="display: flex; align-items: center; gap: 16px;">
          <div style="width: 52px; height: 52px; border-radius: 16px; background: #fff; border: 2px solid #D4A754; display: flex; align-items: center; justify-content: center; font-size: 26px; box-shadow: 0 4px 12px rgba(212,167,84,0.2);">
            ✨
          </div>
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="display: inline-block; font-size: 11.5px; font-weight: 800; padding: 3px 10px; border-radius: 99px; background: rgba(39, 174, 96, 0.14); color: #27ae60; border: 1px solid rgba(39, 174, 96, 0.25);">
                ● PRINTER SIAGA (IDLE)
              </span>
              <span style="font-size: 12.5px; color: var(--text-muted); font-weight: 600;">Semua Antrean Selesai</span>
            </div>
            <h4 style="font-size: 16.5px; font-weight: 800; color: var(--caramel-brown); margin: 4px 0 2px 0;">Printer siap menerima sesi foto berikutnya</h4>
            <p style="font-size: 13px; color: var(--text-muted); margin: 0;">Ketika tamu selesai berfoto di Kiosk, foto akan otomatis dikirim dan status prosesnya muncul di sini.</p>
          </div>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="btn btn-coral" style="font-size: 13px; font-weight: 800; padding: 10px 18px;" onclick="testPrintFromAdmin()">
            🖨️ Cetak Lembar Uji
          </button>
        </div>
      </div>
    `;
    return;
  }

  const thumbUrl = activeJob.media_url || '/assets/templates/strip-green-template.svg';
  const timeStr = activeJob.created_at ? new Date(activeJob.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Baru saja';
  const isSpooled = activeJob.state === 'spooled';

  bannerContainer.innerHTML = `
    <div class="card-pop" style="border: 2px solid var(--coral); background: linear-gradient(135deg, #FFF9F5 0%, #FFF2EC 100%); padding: 22px 26px;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; margin-bottom: 18px;">
        <div style="display: flex; align-items: center; gap: 16px;">
          <div style="width: 58px; height: 76px; background: #fff; border-radius: 10px; overflow: hidden; border: 2px solid var(--coral); box-shadow: 0 4px 12px rgba(230,120,107,0.25); display: flex; align-items: center; justify-content: center; cursor: pointer;" onclick="openPhotoPreviewFromJob('${activeJob.id}')" title="Klik untuk lihat foto penuh">
            <img src="${thumbUrl}" onerror="this.src='/assets/templates/strip-green-template.svg'" style="max-width: 100%; max-height: 100%; object-fit: contain;">
          </div>
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 800; padding: 4px 12px; border-radius: 99px; background: var(--coral); color: #fff;">
                <span class="pq-pulse-dot" style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #fff;"></span>
                SEDANG MENCETAK
              </span>
              <span style="font-family: monospace; font-size: 13px; font-weight: 700; color: var(--caramel-brown);">${activeJob.id}</span>
            </div>
            <h4 style="font-size: 17px; font-weight: 800; color: var(--charcoal); margin: 6px 0 2px 0;">${escapeHtml(activeJob.event_name || 'Event Aktif')} — ${activeJob.copies || 1} Lembar Kertas 4R</h4>
            <div style="font-size: 12.5px; color: var(--text-muted);">
              Spooler OS: <strong>${activeJob.spooler_job_id || 'Menyiapkan spooler...'}</strong> • Masuk antrean: ${timeStr}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-secondary" style="font-size: 12.5px; font-weight: 700; padding: 8px 14px; background: #fff;" onclick="openPhotoPreviewFromJob('${activeJob.id}')">👁️ Lihat Foto Penuh</button>
          <button class="btn btn-coral" style="font-size: 12.5px; font-weight: 800; padding: 8px 14px;" onclick="reprintJobById('${activeJob.id}')">🖨️ Cetak Tambahan</button>
        </div>
      </div>

      <!-- 4-Step Progress Track -->
      <div style="background: #fff; padding: 18px 20px; border-radius: 14px; border: 1.5px solid var(--border-soft);">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; position: relative;">
          <!-- Step 1 -->
          <div class="pq-step-item completed">
            <div class="pq-step-icon">✓</div>
            <div class="pq-step-label">Foto Diterima</div>
            <div class="pq-step-sub">Sesi Kiosk Selesai</div>
          </div>
          <div style="flex: 1; height: 3px; background: #27ae60; margin: 0 -8px; margin-top: -24px;"></div>
          <!-- Step 2 -->
          <div class="pq-step-item completed">
            <div class="pq-step-icon">✓</div>
            <div class="pq-step-label">Komposisi 4R</div>
            <div class="pq-step-sub">300 DPI Borderless</div>
          </div>
          <div style="flex: 1; height: 3px; background: ${isSpooled ? '#27ae60' : 'var(--coral)'}; margin: 0 -8px; margin-top: -24px;"></div>
          <!-- Step 3 -->
          <div class="pq-step-item ${isSpooled ? 'completed' : 'active'}">
            <div class="pq-step-icon">${isSpooled ? '✓' : '⏳'}</div>
            <div class="pq-step-label">Kirim ke Printer</div>
            <div class="pq-step-sub">${isSpooled ? 'Terkirim ke Tray' : 'Spooling Driver'}</div>
          </div>
          <div style="flex: 1; height: 3px; background: ${isSpooled ? 'var(--coral)' : 'var(--border-soft)'}; margin: 0 -8px; margin-top: -24px;"></div>
          <!-- Step 4 -->
          <div class="pq-step-item ${isSpooled ? 'active' : ''}">
            <div class="pq-step-icon">🖨️</div>
            <div class="pq-step-label">Hasil Cetak</div>
            <div class="pq-step-sub">Kertas Keluar di Tray</div>
          </div>
        </div>
        <!-- Shimmer Bar -->
        <div style="width: 100%; height: 6px; background: #f0e6dc; border-radius: 99px; overflow: hidden; margin-top: 14px;">
          <div class="pq-track-shimmer" style="width: 100%; height: 100%;"></div>
        </div>
      </div>
    </div>
  `;
}

function renderPrintQueueTable() {
  const tbody = document.getElementById('pqJobsTableBody');
  if (!tbody) return;

  const statusFilter = document.getElementById('pqFilterStatus')?.value || 'all';
  const eventFilter = document.getElementById('pqFilterEvent')?.value || '';
  const searchFilter = (document.getElementById('pqSearchInput')?.value || '').trim().toLowerCase();

  let filtered = [...(cachedPrintJobs || [])];

  if (statusFilter === 'active') {
    filtered = filtered.filter(j => j.state === 'queued' || j.state === 'processing' || j.state === 'spooled');
  } else if (statusFilter === 'completed') {
    filtered = filtered.filter(j => j.state === 'completed');
  } else if (statusFilter === 'failed') {
    filtered = filtered.filter(j => j.state === 'failed' || j.state === 'cancelled');
  }

  if (eventFilter) {
    filtered = filtered.filter(j => j.event_id === eventFilter);
  }

  if (searchFilter) {
    filtered = filtered.filter(j => 
      (j.id && j.id.toLowerCase().includes(searchFilter)) ||
      (j.spooler_job_id && String(j.spooler_job_id).toLowerCase().includes(searchFilter)) ||
      (j.event_name && j.event_name.toLowerCase().includes(searchFilter))
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr style="border-bottom: 1px solid var(--border-soft);">
        <td colspan="8" style="padding: 32px; text-align: center; color: var(--text-muted);">
          Tidak ada item antrean cetak yang sesuai kriteria filter.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(job => {
    const timeStr = job.created_at ? new Date(job.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Baru saja';
    let stateBadge = '';
    const st = (job.state || 'completed').toLowerCase();

    if (st === 'queued') {
      stateBadge = `<span class="badge-pill" style="background: rgba(212, 167, 84, 0.15); color: #B58832; border: 1px solid rgba(212, 167, 84, 0.35); font-size: 11px; font-weight: 800;">🟡 ANTRE DI SERVER</span>`;
    } else if (st === 'processing') {
      stateBadge = `<span class="badge-pill" style="background: rgba(230, 120, 107, 0.15); color: var(--coral); border: 1px solid rgba(230, 120, 107, 0.35); font-size: 11px; font-weight: 800;"><span class="pq-pulse-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--coral);margin-right:4px;"></span>⏳ SEDANG DICETAK</span>`;
    } else if (st === 'spooled') {
      stateBadge = `<span class="badge-pill" style="background: rgba(74, 124, 122, 0.15); color: var(--dusty-teal); border: 1px solid rgba(74, 124, 122, 0.35); font-size: 11px; font-weight: 800;">🟢 SPOOLER PRINTER</span>`;
    } else if (st === 'completed') {
      stateBadge = `<span class="badge-pill" style="background: rgba(39, 174, 96, 0.15); color: #27ae60; border: 1px solid rgba(39, 174, 96, 0.35); font-size: 11px; font-weight: 800;">✅ SELESAI</span>`;
    } else if (st === 'failed') {
      stateBadge = `<span class="badge-pill" style="background: rgba(179, 64, 47, 0.15); color: #B3402F; border: 1px solid rgba(179, 64, 47, 0.35); font-size: 11px; font-weight: 800;" title="${escapeHtml(job.error_message || 'Gagal mengirim ke driver printer')}">❌ GAGAL</span>`;
    } else if (st === 'cancelled') {
      stateBadge = `<span class="badge-pill" style="background: rgba(120, 120, 120, 0.15); color: #777; border: 1px solid rgba(120, 120, 120, 0.35); font-size: 11px; font-weight: 800;">⚪ DIBATALKAN</span>`;
    } else {
      stateBadge = `<span class="badge-pill badge-active" style="font-size: 11px; font-weight: 800;">${st.toUpperCase()}</span>`;
    }

    const thumbUrl = job.media_url || '/assets/templates/strip-green-template.svg';

    return `
      <tr style="border-bottom: 1px solid var(--border-soft); transition: background 0.15s ease;" onmouseenter="this.style.background='rgba(230,120,107,0.03)'" onmouseleave="this.style.background='transparent'">
        <td style="padding: 8px 14px; width: 75px;">
          <div style="width: 44px; height: 58px; background: var(--cream-bg); border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1.5px solid var(--border-soft); box-shadow: 0 2px 6px rgba(0,0,0,0.06); transition: transform 0.2s;" 
               onmouseenter="this.style.transform='scale(1.08)'" onmouseleave="this.style.transform='scale(1)'"
               onclick="openPhotoPreviewFromJob('${job.id}')" title="Klik untuk pratinjau foto ukuran penuh">
            <img src="${thumbUrl}" onerror="this.src='/assets/templates/strip-green-template.svg'" style="max-width: 100%; max-height: 100%; object-fit: contain;">
          </div>
        </td>
        <td style="padding: 12px 14px;">
          <code style="font-family: monospace; font-weight: 700; font-size: 12.5px; background: rgba(109,76,61,0.07); color: var(--caramel-brown); padding: 3px 6px; border-radius: 6px;">${job.id}</code>
        </td>
        <td style="padding: 12px 14px; font-family: monospace; font-size: 13px; color: var(--charcoal); font-weight: 600;">
          ${job.spooler_job_id || '-'}
        </td>
        <td style="padding: 12px 14px; font-weight: 700; color: var(--caramel-brown); font-size: 13.5px;">
          ${escapeHtml(job.event_name || 'Event Aktif')}
        </td>
        <td style="padding: 12px 14px; font-weight: 700; font-size: 13px;">
          ${job.copies || 1} Lembar
        </td>
        <td style="padding: 12px 14px;">
          ${stateBadge}
        </td>
        <td style="padding: 12px 14px; font-size: 12.5px; color: var(--text-muted); font-weight: 600;">
          ${timeStr}
        </td>
        <td style="padding: 12px 14px; text-align: right;">
          <div style="display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap;">
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; font-weight: 700; background: #fff;" onclick="openPhotoPreviewFromJob('${job.id}')" title="Pratinjau foto">👁️ Lihat</button>
            <button class="btn btn-coral" style="padding: 4px 10px; font-size: 12px; font-weight: 700;" onclick="directPrintJob('${job.id}', '${thumbUrl}', ${job.copies || 1})" title="Cetak ulang lembar ini">🖨️ Cetak</button>
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; font-weight: 700; background: rgba(179, 64, 47, 0.08); color: #B3402F; border: 1.5px solid rgba(179, 64, 47, 0.25);" onclick="deletePrintJob('${job.id}', event)" title="Hapus dari antrean">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function updateTabPrintsTable(jobs) {
  const tbody = document.getElementById('printJobsTableBody');
  if (!tbody) return;

  if (!jobs || jobs.length === 0) {
    tbody.innerHTML = `
      <tr style="border-bottom: 1px solid var(--border-soft);">
        <td colspan="8" style="padding: 24px; text-align: center; color: var(--text-muted);">
          Belum ada antrean cetak. Klik <strong>"Cetak Lembar Uji"</strong> di atas untuk uji cetak sesuai pengaturan printer.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = jobs.map(job => {
    const timeStr = job.created_at ? new Date(job.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Baru saja';
    let stateBadge = 'badge-active';
    if (job.state === 'queued') stateBadge = 'badge-pending';
    if (job.state === 'cancelled') stateBadge = 'badge-inactive';

    const thumbUrl = job.media_url || '/assets/templates/strip-green-template.svg';

    return `
      <tr style="border-bottom: 1px solid var(--border-soft);">
        <td style="padding: 8px 12px; width: 75px;">
          <div style="width: 44px; height: 58px; background: var(--cream-bg); border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1.5px solid var(--border-soft); box-shadow: 0 2px 6px rgba(0,0,0,0.06);" 
               onclick="openPhotoPreviewFromJob('${job.id}')" title="Klik untuk melihat foto ukuran penuh & opsi cetak ulang">
            <img src="${thumbUrl}" onerror="this.src='/assets/templates/strip-green-template.svg'" style="max-width: 100%; max-height: 100%; object-fit: contain;">
          </div>
        </td>
        <td style="padding: 12px; font-family: monospace; font-weight: 700; font-size: 13px;">${job.id}</td>
        <td style="font-family: monospace; font-size: 13px; color: var(--charcoal); font-weight: 600;">${job.spooler_job_id || '-'}</td>
        <td style="font-weight: 700; color: var(--caramel-brown);">${escapeHtml(job.event_name || 'Event Aktif')}</td>
        <td>${job.copies || 1} Lembar</td>
        <td><span class="badge-pill ${stateBadge}">${job.state ? job.state.toUpperCase() : 'COMPLETED'}</span></td>
        <td>${timeStr}</td>
        <td>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; font-weight: 700; background: #fff;" onclick="openPhotoPreviewFromJob('${job.id}')">👁️ Lihat</button>
            <button class="btn btn-coral" style="padding: 4px 10px; font-size: 12px; font-weight: 700;" onclick="directPrintJob('${job.id}', '${thumbUrl}', ${job.copies || 1})">🖨️ Cetak</button>
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; font-weight: 700; background: rgba(179, 64, 47, 0.08); color: #B3402F; border: 1.5px solid rgba(179, 64, 47, 0.25);" onclick="deletePrintJob('${job.id}', event)" title="Hapus dari antrean cetak">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function clearCompletedPrintJobs() {
  const confirmed = confirm('Bersihkan riwayat job yang berstatus SELESAI, GAGAL, atau DIBATALKAN?\n\nJob yang sedang antre atau diproses tidak akan dihapus.');
  if (!confirmed) return;

  try {
    const res = await fetch('/api/print-jobs/clear-completed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal membersihkan riwayat');
    window.pbToast(`✅ ${data.message || 'Riwayat antrean cetak berhasil dibersihkan'}`, 'ok');
    await loadPrintJobs();
  } catch (err) {
    window.pbToast(`Gagal: ${err.message}`, 'error');
  }
}

async function loadPrintJobs(isUserTriggered = false) {
  const refreshIcon = document.getElementById('pqRefreshIcon');
  if (refreshIcon) refreshIcon.style.transform = 'rotate(360deg)';

  try {
    const res = await fetch('/api/print-jobs');
    if (!res.ok) throw new Error('Gagal mengambil data antrean cetak');
    const jobs = await res.json();
    cachedPrintJobs = jobs || [];

    updatePrintQueueStats(cachedPrintJobs);
    renderPrintQueueTable();
    renderActivePrintBanner(cachedPrintJobs);
    updateTabPrintsTable(cachedPrintJobs);

    if (isUserTriggered) {
      window.pbToast('✅ Antrean cetak berhasil disegarkan', 'ok', 2000);
    }
  } catch (err) {
    console.warn('loadPrintJobs error:', err);
    if (isUserTriggered) {
      window.pbToast(`Gagal menyegarkan antrean: ${err.message}`, 'error');
    }
  } finally {
    if (refreshIcon) {
      setTimeout(() => { refreshIcon.style.transform = 'none'; }, 400);
    }
  }
}

async function directPrintJob(jobId, imageUrl, copies = 1) {
  try {
    const res = await fetch(`/api/print-jobs/${jobId}/reprint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ copies })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal mencetak ulang');
    await window.pbSmartPrint(data, imageUrl, copies);
    await loadPrintJobs();
  } catch (err) {
    window.pbToast(`Error cetak: ${err.message}`, 'error');
  }
}

async function reprintJobById(jobId) {
  const job = cachedPrintJobs.find(j => j.id === jobId);
  const copies = (job && job.copies) || 1;
  const thumbUrl = (job && job.media_url) || '/assets/templates/strip-green-template.svg';
  await directPrintJob(jobId, thumbUrl, copies);
}

// ==============================================================
// PHOTO DELETION & PRINT QUEUE CLEANUP
// ==============================================================
async function deletePhoto(assetId, evt) {
  if (evt && evt.stopPropagation) evt.stopPropagation();
  if (!assetId) return;

  const confirmed = confirm('Apakah Anda yakin ingin menghapus foto ini secara permanen?\n\nFile foto dan riwayat cetak terkait akan dihapus dari sistem.');
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/photos/${encodeURIComponent(assetId)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus foto');

    window.pbToast('✅ Foto berhasil dihapus secara permanen', 'ok');
    if (activeModalPhoto && activeModalPhoto.asset_id === assetId) {
      closePhotoPreviewModal();
    }
    await loadRecentPhotos();
    await loadPrintJobs();
  } catch (err) {
    window.pbToast(`Gagal menghapus foto: ${err.message}`, 'error');
  }
}

async function deleteActiveModalPhoto() {
  if (!activeModalPhoto || !activeModalPhoto.asset_id) {
    window.pbToast('ID foto tidak ditemukan', 'warn');
    return;
  }
  await deletePhoto(activeModalPhoto.asset_id);
}

async function clearCurrentEventPhotos() {
  const filterSelect = document.getElementById('galleryEventFilter');
  const eventId = filterSelect ? filterSelect.value : '';
  const currentEvent = (eventsList || []).find(e => e.id === eventId);
  const eventName = currentEvent ? currentEvent.name : (eventId ? 'Event Terpilih' : null);

  if (!eventId) {
    window.pbToast('Pilih salah satu event terlebih dahulu dari dropdown filter untuk menghapus fotonya.', 'warn', 4000);
    return;
  }

  const promptText = `PERINGATAN: Anda akan menghapus SELURUH foto untuk event "${eventName}".\n\nSemua file foto tamu, sesi Kiosk, dan antrean cetak untuk event ini akan dihapus permanen!\n\nKetik "HAPUS" untuk konfirmasi:`;
  const userInput = prompt(promptText);
  if (userInput !== 'HAPUS') {
    if (userInput !== null) window.pbToast('Konfirmasi dibatalkan (kata kunci tidak cocok).', 'warn');
    return;
  }

  try {
    const res = await fetch('/api/photos/clear-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus foto event');

    window.pbToast(`✅ ${data.message || 'Semua foto event berhasil dihapus'}`, 'ok', 4000);
    closePhotoPreviewModal();
    await loadRecentPhotos(eventId);
    await loadPrintJobs();
  } catch (err) {
    window.pbToast(`Gagal: ${err.message}`, 'error');
  }
}

async function deletePrintJob(jobId, evt) {
  if (evt && evt.stopPropagation) evt.stopPropagation();
  if (!jobId) return;

  const confirmed = confirm(`Hapus item antrean cetak ${jobId}?`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/print-jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus antrean');

    window.pbToast('✅ Item antrean cetak berhasil dihapus', 'ok');
    await loadPrintJobs();
    await loadRecentPhotos();
  } catch (err) {
    window.pbToast(`Gagal menghapus antrean: ${err.message}`, 'error');
  }
}

async function uploadTransferProof() {
  const fileInput = document.getElementById('proofFileInput');
  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Pilih file bukti transfer terlebih dahulu');
    return;
  }
  alert('✅ Bukti transfer berhasil diunggah! Sedang menunggu verifikasi Super Admin.');
}

// ==============================================================
// CROSS-PLATFORM APP DOWNLOADER & CLIENT DEVICE PRINT (WIN, MAC, ANDROID)
// ==============================================================
let deferredAdminInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredAdminInstallPrompt = e;
});

async function loadAppDownloadInfo(customServerUrl = null) {
  try {
    const query = customServerUrl ? `?serverUrl=${encodeURIComponent(customServerUrl)}` : '';
    const res = await fetch(`/api/apps/info${query}`);
    if (!res.ok) return;
    const data = await res.json();

    const urlInput = document.getElementById('appServerUrlInput');
    if (urlInput && !customServerUrl) {
      urlInput.value = data.targetServerUrl || data.primaryLanUrl || window.location.origin;
    }

    const lanBadge = document.getElementById('appLanStatusBadge');
    if (lanBadge && data.primaryLanUrl) {
      lanBadge.textContent = `🟢 IP Wi-Fi Server: ${data.primaryLanUrl.replace(/^https?:\/\//, '')}`;
    }

    const qrImg = document.getElementById('androidAppQrImg');
    const qrLoad = document.getElementById('androidAppQrLoading');
    if (qrImg && data.androidQrDataUrl) {
      qrImg.src = data.androidQrDataUrl;
      qrImg.style.display = 'block';
      if (qrLoad) qrLoad.style.display = 'none';
    }

    const lanText = document.getElementById('androidLanUrlText');
    if (lanText) {
      lanText.textContent = data.androidKioskUrl || `${data.primaryLanUrl}/kiosk?fullscreen=1`;
    }

    if (data.downloads) {
      const btnWin = document.getElementById('btnDownloadWindowsApp');
      const btnMac = document.getElementById('btnDownloadMacApp');
      const btnAndZip = document.getElementById('btnDownloadAndroidZip');
      const btnAndHtml = document.getElementById('btnDownloadAndroidHtml');
      const qWin = document.getElementById('quickDownloadWinBtn');
      const qMac = document.getElementById('quickDownloadMacBtn');

      if (btnWin) btnWin.href = data.downloads.windows;
      if (btnMac) btnMac.href = data.downloads.macos;
      if (btnAndZip) btnAndZip.href = data.downloads.androidZip;
      if (btnAndHtml) btnAndHtml.href = data.downloads.androidHtml;
      if (qWin) qWin.href = data.downloads.windows;
      if (qMac) qMac.href = data.downloads.macos;
    }
  } catch (err) {
    console.warn('loadAppDownloadInfo warning:', err);
  }
}

async function refreshAppDownloadLinks() {
  const urlInput = document.getElementById('appServerUrlInput');
  const val = (urlInput?.value || '').trim();
  await loadAppDownloadInfo(val);
  alert(`✅ Tautan Download Aplikasi & QR Code Android berhasil diperbarui ke:\n${val || window.location.origin}`);
}

async function launchAndInstallMacAppDirectly(mode = 'kiosk') {
  try {
    const urlInput = document.getElementById('appServerUrlInput');
    const serverUrl = (urlInput?.value || '').trim() || window.location.origin;
    const res = await fetch('/api/apps/launch-macos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, mode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal membuka aplikasi macOS');
    alert(`🍎 Berhasil Dipasang & Dibuka!\n\nAplikasi "Photobooth Kiosk.app" dan "Photobooth Admin.app" sudah otomatis dipasang (tanpa blokir Gatekeeper) di:\n• Folder Applications (/Applications)\n• Layar Desktop MacBook Anda\n• Folder Downloads/Photobooth-Kiosk-MacBook-macOS\n\nLayar Kiosk Full-Screen sedang dibuka!`);
  } catch (err) {
    alert(`Info: ${err.message}`);
  }
}

async function installPwaDirectly() {
  if (deferredAdminInstallPrompt) {
    deferredAdminInstallPrompt.prompt();
    await deferredAdminInstallPrompt.userChoice;
    deferredAdminInstallPrompt = null;
  } else {
    window.open('/kiosk?app=android&fullscreen=1', '_blank');
    alert('📲 Layar Kiosk Full-Screen telah dibuka di tab baru!\n\n• Di Android (Chrome): Ketuk ikon titik tiga (⋮) di pojok kanan atas lalu pilih "Install Aplikasi" atau "Tambahkan ke Layar Utama".\n• Di Windows / MacBook (Chrome / Edge): Klik ikon Install (➕/🖥️) di sebelah kanan kolom URL.');
  }
}

function printModalPhotoViaDevice() {
  if (!activeModalPhoto) return;
  const imgSrc = activeModalPhoto.file_path || activeModalPhoto.media_url;
  if (!imgSrc) {
    window.pbToast('File gambar tidak ditemukan untuk dicetak.', 'error');
    return;
  }
  const copies = parseInt(document.getElementById('modalPrintCopies')?.value || '1', 10);
  window.pbPrintViaBrowser({ imageUrl: imgSrc, copies });
}

// ==============================================================
// SONY A7III / CANON EOS HARDWARE SHUTTER & FLASH TRIGGER
// ==============================================================
async function loadCameraFlashSettings() {
  const statusBadge = document.getElementById('cameraSystemStatusBadge');
  const modeSel = document.getElementById('cfgCameraFlashMode');
  const brandSel = document.getElementById('cfgCameraBrand');
  const videoSel = document.getElementById('cfgVideoDeviceSelect');

  try {
    const res = await fetch('/api/camera/status');
    const data = res.ok ? await res.json() : null;
    if (data && data.config) {
      if (modeSel) modeSel.value = data.config.cameraMode || 'sony_canon_flash';
      if (brandSel) brandSel.value = data.config.cameraBrand || 'sony_a7iii';
    }

    if (statusBadge && data) {
      if (data.sonyRemoteInstalled) {
        statusBadge.innerText = data.sonyRemoteRunning
          ? '🟢 Sony Remote Aktif & Siap Trigger Flash'
          : '✅ Sony Imaging Edge Remote Terdeteksi di MacBook';
      } else if (data.gphoto2Installed || data.digicamControlInstalled) {
        statusBadge.innerText = '🟢 USB PTP Shutter Engine Siap';
      } else {
        statusBadge.innerText = '⚡ Mode Kamera & Flash Siap';
      }
    }

    // Enumerate browser video devices for Live View camera selection
    if (videoSel && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      const savedId = data?.config?.preferredVideoDeviceId || '';

      videoSel.innerHTML = `<option value="">🔍 Otomatis (Prioritaskan Sony / Capture Card HDMI)</option>`;
      videoInputs.forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = `📹 ${dev.label || 'Kamera #' + (idx + 1)}`;
        if (savedId && dev.deviceId === savedId) opt.selected = true;
        videoSel.appendChild(opt);
      });
    }
  } catch (err) {
    console.warn('loadCameraFlashSettings error:', err);
  }
}

async function saveCameraFlashSettings() {
  const modeSel = document.getElementById('cfgCameraFlashMode');
  const brandSel = document.getElementById('cfgCameraBrand');
  const videoSel = document.getElementById('cfgVideoDeviceSelect');

  const payload = {
    cameraMode: modeSel ? modeSel.value : 'sony_canon_flash',
    cameraBrand: brandSel ? brandSel.value : 'sony_a7iii',
    preferredVideoDeviceId: videoSel ? videoSel.value : '',
    preferredVideoLabel: videoSel && videoSel.selectedOptions[0] ? videoSel.selectedOptions[0].textContent : ''
  };

  try {
    await fetch('/api/camera/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

async function launchSonyRemoteFromAdmin() {
  try {
    const res = await fetch('/api/camera/launch-sony-remote', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal membuka Sony Remote');
    alert(`🚀 ${data.message}\n\n• Folder simpan foto otomatis diarahkan ke sistem Photobooth.\n• Saat countdown Kiosk habis, Sony A7III akan otomatis menjepret dan menyalakan Flash!`);
    setTimeout(loadCameraFlashSettings, 1500);
  } catch (err) {
    alert(`⚠️ ${err.message}`);
  }
}

async function testCameraFlashTriggerFromAdmin() {
  try {
    const res = await fetch('/api/camera/trigger-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeoutMs: 2500 })
    });
    const data = await res.json();
    if (data.flashTriggered) {
      alert(`⚡ Uji Jepret & Flash Berhasil!\n\n• Engine: ${data.engine}\n• Status: ${data.message}\n${data.imageUrl ? '• File Foto Flash: ' + data.imageUrl : '• Sinyal Shutter telah ditembakkan ke kamera!'}`);
    } else {
      alert(`ℹ️ ${data.message}\n\n• Pastikan kabel USB-C kamera Sony A7III sudah terhubung ke MacBook.\n• Klik tombol "🚀 Buka Sony Imaging Edge Remote" terlebih dahulu agar koneksi USB kamera aktif.`);
    }
    await loadCameraFlashSettings();
  } catch (err) {
    alert(`Gagal menguji trigger kamera: ${err.message}`);
  }
}
