/**
 * MAFAZA LANDING PAGE ENGINE
 * Interactive Features: Pricing Calculator, Frame Picker, Flyer Modal, FAQ Accordion
 */

document.addEventListener('DOMContentLoaded', () => {
  initNavbarScroll();
  initMobileMenu();
  initFrameTabs();
  initCalculator();
  initFaqAccordion();
  initFlyerModal();
  initAosObserver();
});

// 1. Navbar Scroll Effect
function initNavbarScroll() {
  const navbar = document.querySelector('.site-navbar');
  if (!navbar) return;
  window.addEventListener('scroll', () => {
    if (window.scrollY > 40) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  });
}

// 2. Mobile Menu Toggle
function initMobileMenu() {
  const btn = document.getElementById('mobileMenuBtn');
  const links = document.getElementById('navLinks');
  if (!btn || !links) return;

  btn.addEventListener('click', () => {
    const isShowing = links.style.display === 'flex';
    links.style.display = isShowing ? 'none' : 'flex';
    if (!isShowing) {
      links.style.flexDirection = 'column';
      links.style.position = 'absolute';
      links.style.top = '100%';
      links.style.left = '0';
      links.style.right = '0';
      links.style.background = '#FFFBF6';
      links.style.padding = '20px 24px';
      links.style.borderBottom = '2px solid #ECD8C6';
      links.style.boxShadow = '0 10px 25px rgba(0,0,0,0.1)';
      links.style.gap = '16px';
    }
  });

  // Close when clicking a link
  links.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        links.style.display = 'none';
      }
    });
  });
}

// 3. Frame Layouts Interactive Tabs
function initFrameTabs() {
  const tabBtns = document.querySelectorAll('.frame-tab-btn');
  const tabPanels = document.querySelectorAll('.frame-tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');

      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }
    });
  });
}

// 4. Interactive Live Price Calculator & WA Builder
function initCalculator() {
  const selectBooth = document.getElementById('calcSelectBooth');
  const selectGuestbook = document.getElementById('calcSelectGuestbook');
  const inputOvertime = document.getElementById('calcInputOvertime');
  const inputExtraPrint = document.getElementById('calcInputExtraPrint');
  const inputDate = document.getElementById('calcInputDate');
  const inputLocation = document.getElementById('calcInputLocation');

  const textBoothName = document.getElementById('calcSummaryBoothName');
  const textBoothPrice = document.getElementById('calcSummaryBoothPrice');
  const textGuestbookName = document.getElementById('calcSummaryGuestbookName');
  const textGuestbookPrice = document.getElementById('calcSummaryGuestbookPrice');
  const textAddonName = document.getElementById('calcSummaryAddonName');
  const textAddonPrice = document.getElementById('calcSummaryAddonPrice');
  const rowDiscount = document.getElementById('calcRowDiscount');
  const textTotalPrice = document.getElementById('calcSummaryTotalPrice');
  const btnBookWa = document.getElementById('calcBtnBookWa');

  const prices = {
    booth: {
      none: { name: 'Belum Memilih Photobooth', price: 0 },
      sweet_start: { name: 'Sweet Start (Paket Hemat)', price: 849000 },
      little_joy: { name: 'Little Joy (2 Jam Unlimited)', price: 1199000 },
      sweet_story: { name: 'Sweet Story (3 Jam Unlimited - Most Loved)', price: 1499000 },
      grand_moment: { name: 'Grand Moment (4 Jam Unlimited)', price: 1799000 }
    },
    guestbook: {
      none: { name: 'Tanpa Digital Guestbook', price: 0 },
      silver: { name: 'Digital Guestbook (Silver)', price: 479000 },
      gold: { name: 'Digital Guestbook (Gold)', price: 979000 },
      diamond: { name: 'Digital Guestbook (Diamond)', price: 1179000 }
    },
    overtimePerHour: 150000,
    extraPrintPer100: 120000
  };

  function formatRp(num) {
    return 'Rp ' + Number(num).toLocaleString('id-ID');
  }

  function recalculate() {
    if (!selectBooth) return;

    const bKey = selectBooth.value || 'sweet_story';
    const gKey = selectGuestbook ? selectGuestbook.value : 'none';
    const otHours = Math.max(0, parseInt(inputOvertime ? inputOvertime.value : 0) || 0);
    const extraP = Math.max(0, parseInt(inputExtraPrint ? inputExtraPrint.value : 0) || 0);

    const bItem = prices.booth[bKey] || prices.booth.none;
    const gItem = prices.guestbook[gKey] || prices.guestbook.none;

    const bPrice = bItem.price;
    const gPrice = gItem.price;
    const otCost = otHours * prices.overtimePerHour;
    const printCost = Math.ceil(extraP / 100) * prices.extraPrintPer100;
    const addonCost = otCost + printCost;

    // Bundling Discount 300K if both Photobooth and Digital Guestbook are selected
    const isBundled = (bPrice > 0 && gPrice > 0);
    const discount = isBundled ? 300000 : 0;

    const total = Math.max(0, bPrice + gPrice + addonCost - discount);

    // Update UI elements
    if (textBoothName) textBoothName.innerText = bItem.name;
    if (textBoothPrice) textBoothPrice.innerText = bPrice > 0 ? formatRp(bPrice) : '-';

    if (textGuestbookName) textGuestbookName.innerText = gItem.name;
    if (textGuestbookPrice) textGuestbookPrice.innerText = gPrice > 0 ? formatRp(gPrice) : '-';

    if (textAddonName && textAddonPrice) {
      let addonSummary = [];
      if (otHours > 0) addonSummary.push(`Overtime ${otHours} Jam (${formatRp(otCost)})`);
      if (extraP > 0) addonSummary.push(`Ekstra Cetak ${extraP} Lembar (${formatRp(printCost)})`);
      textAddonName.innerText = addonSummary.length > 0 ? addonSummary.join(' + ') : 'Tanpa Add-on';
      textAddonPrice.innerText = addonCost > 0 ? formatRp(addonCost) : '-';
    }

    if (rowDiscount) {
      rowDiscount.style.display = isBundled ? 'flex' : 'none';
    }

    if (textTotalPrice) {
      textTotalPrice.innerText = formatRp(total);
    }

    // Build WhatsApp Pre-filled URL
    const eventDate = inputDate && inputDate.value ? inputDate.value : '(Belum ditentukan)';
    const eventLoc = inputLocation && inputLocation.value.trim() ? inputLocation.value.trim() : '(Belum ditentukan)';

    let waMessage = `Halo Admin MAFAZA Photobooth & Digital Guestbook! 🌸%0A%0A` +
      `Saya tertarik untuk booking paket spesial:%0A` +
      `• Paket Photobooth: *${encodeURIComponent(bItem.name)}* ${bPrice > 0 ? `(${formatRp(bPrice)})` : ''}%0A` +
      `• Digital Guestbook: *${encodeURIComponent(gItem.name)}* ${gPrice > 0 ? `(${formatRp(gPrice)})` : ''}%0A`;

    if (otHours > 0 || extraP > 0) {
      waMessage += `• Add-on Tambahan: ${otHours > 0 ? `Overtime ${otHours} Jam ` : ''}${extraP > 0 ? `+ Ekstra Cetak ${extraP} lbr` : ''}%0A`;
    }

    if (isBundled) {
      waMessage += `• *PROMO BUNDLING:* Diskon Spesial Rp 300.000 🎉%0A`;
    }

    waMessage += `• Estimasi Total: *${encodeURIComponent(formatRp(total))}*%0A` +
      `• Rencana Tanggal Acara: *${encodeURIComponent(eventDate)}*%0A` +
      `• Lokasi / Kota: *${encodeURIComponent(eventLoc)}*%0A%0A` +
      `Apakah slot tanggal tersebut masih tersedia? Terima kasih! 😊`;

    const waLink = `https://wa.me/6281803300354?text=${waMessage}`;

    if (btnBookWa) {
      btnBookWa.href = waLink;
    }

    // Also update sticky mobile CTA
    const mobileWaBtn = document.getElementById('mobileStickyWaBtn');
    if (mobileWaBtn) {
      mobileWaBtn.href = waLink;
    }
  }

  // Bind change listeners
  [selectBooth, selectGuestbook, inputOvertime, inputExtraPrint, inputDate, inputLocation].forEach(el => {
    if (el) {
      el.addEventListener('change', recalculate);
      el.addEventListener('input', recalculate);
    }
  });

  recalculate();
}

// 5. FAQ Accordion Toggle
function initFaqAccordion() {
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const btn = item.querySelector('.faq-question-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const isActive = item.classList.contains('active');
        faqItems.forEach(i => i.classList.remove('active'));
        if (!isActive) {
          item.classList.add('active');
        }
      });
    }
  });
}

// 6. Official Price List Flyer Lightbox Viewer
function initFlyerModal() {
  const modal = document.getElementById('flyerModalBackdrop');
  const btnOpen = document.querySelectorAll('.btn-open-flyer-modal');
  const btnClose = document.getElementById('flyerModalClose');
  const flyerImg = document.getElementById('flyerModalImage');
  const flyerPageText = document.getElementById('flyerModalPageText');
  const btnPrev = document.getElementById('flyerModalPrev');
  const btnNext = document.getElementById('flyerModalNext');

  if (!modal || !flyerImg) return;

  let currentPage = 1;
  const totalPages = 7;

  function showPage(p) {
    if (p < 1) p = 1;
    if (p > totalPages) p = totalPages;
    currentPage = p;
    flyerImg.src = `/assets/pl/pl_page_${currentPage}.jpg`;
    if (flyerPageText) {
      flyerPageText.innerText = `Halaman ${currentPage} dari ${totalPages}`;
    }
    if (btnPrev) btnPrev.disabled = (currentPage === 1);
    if (btnNext) btnNext.disabled = (currentPage === totalPages);
  }

  btnOpen.forEach(b => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const pageAttr = parseInt(b.getAttribute('data-flyer-page') || 1);
      showPage(pageAttr);
      modal.style.display = 'flex';
    });
  });

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  });

  if (btnPrev) {
    btnPrev.addEventListener('click', () => showPage(currentPage - 1));
  }
  if (btnNext) {
    btnNext.addEventListener('click', () => showPage(currentPage + 1));
  }

  // Keyboard navigation
  window.addEventListener('keydown', (e) => {
    if (modal.style.display === 'flex') {
      if (e.key === 'Escape') modal.style.display = 'none';
      if (e.key === 'ArrowLeft') showPage(currentPage - 1);
      if (e.key === 'ArrowRight') showPage(currentPage + 1);
    }
  });
}

// 7. Subtle Scroll Animations (IntersectionObserver)
function initAosObserver() {
  if (!('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('aos-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.animate-on-scroll').forEach(el => {
    observer.observe(el);
  });
}

// Global helper for booking specific package directly from card
window.bookPackageDirectly = function(packageName, category = 'Photobooth') {
  const calcSelect = category === 'Photobooth' ? document.getElementById('calcSelectBooth') : document.getElementById('calcSelectGuestbook');
  if (calcSelect) {
    calcSelect.value = packageName;
    calcSelect.dispatchEvent(new Event('change'));
    const calcSection = document.getElementById('simulasi-harga');
    if (calcSection) {
      calcSection.scrollIntoView({ behavior: 'smooth' });
    }
  } else {
    const text = encodeURIComponent(`Halo Admin MAFAZA, saya ingin menanyakan dan booking paket *${packageName}*. Apakah slot masih tersedia? 😊`);
    window.open(`https://wa.me/6281803300354?text=${text}`, '_blank');
  }
};
