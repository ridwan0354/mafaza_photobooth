import crypto from 'node:crypto';
import { db, runInTransaction } from '../db/database.js';

const VALID_PAYMENT_METHODS = new Set(['Tunai', 'QRIS', 'Transfer', 'Lainnya']);
const SALES_ACTION_PIN = String(process.env.SALES_ACTION_PIN || '1318');

export function verifySalesActionPin(pin) {
  const input = String(pin ?? '').trim();
  const expected = SALES_ACTION_PIN;
  const bufIn = Buffer.from(input, 'utf8');
  const bufExp = Buffer.from(expected, 'utf8');
  if (!input || bufIn.length !== bufExp.length || !crypto.timingSafeEqual(bufIn, bufExp)) {
    const err = new Error('PIN salah! Masukkan PIN 1318 untuk mengedit atau menghapus penjualan.');
    err.statusCode = 403;
    throw err;
  }
  return true;
}

/**
 * Resolves the tenant's local calendar date (YYYY-MM-DD) and time (HH:MM)
 * using the matching event timezone or active event timezone (fallback Asia/Makassar).
 */
export function getTenantLocalDateInfo(tenantId, eventId = null, now = new Date()) {
  let timeZone = 'Asia/Makassar';
  try {
    let row = null;
    if (eventId) {
      row = db.prepare('SELECT timezone FROM events WHERE id = ? AND tenant_id = ?').get(eventId, tenantId);
    }
    if (!row) {
      row = db.prepare("SELECT timezone FROM events WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(tenantId);
    }
    if (row && row.timezone) {
      timeZone = row.timezone;
    }
  } catch (e) {}

  try {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now);
    return { timeZone, date, time };
  } catch (e) {
    const iso = now.toISOString();
    return { timeZone: 'UTC', date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
}

export function listProducts(tenantId, { includeInactive = false } = {}) {
  const where = includeInactive ? 'WHERE tenant_id = ?' : 'WHERE tenant_id = ? AND active = 1';
  return db.prepare(`
    SELECT id, tenant_id, name, category, price, unit, active, created_at, updated_at
    FROM sales_products
    ${where}
    ORDER BY active DESC, category ASC, name ASC
  `).all(tenantId);
}

export function createProduct(tenantId, data = {}) {
  const name = String(data.name || '').trim();
  if (!name) {
    throw new Error('Nama produk wajib diisi.');
  }
  const category = String(data.category || 'Umum').trim() || 'Umum';
  const unit = String(data.unit || 'pcs').trim() || 'pcs';
  const rawPrice = Number(data.price);
  if (!Number.isFinite(rawPrice) || rawPrice < 0) {
    throw new Error('Harga produk tidak valid.');
  }
  const price = Math.round(rawPrice);
  const active = data.active === false || data.active === 0 ? 0 : 1;
  const id = 'prod_' + crypto.randomBytes(6).toString('hex');

  db.prepare(`
    INSERT INTO sales_products (id, tenant_id, name, category, price, unit, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, name, category, price, unit, active);

  return db.prepare('SELECT * FROM sales_products WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}

export function updateProduct(tenantId, productId, data = {}) {
  const current = db.prepare('SELECT * FROM sales_products WHERE id = ? AND tenant_id = ?').get(productId, tenantId);
  if (!current) {
    throw new Error('Produk tidak ditemukan.');
  }

  const name = data.name !== undefined ? String(data.name).trim() : current.name;
  if (!name) throw new Error('Nama produk tidak boleh kosong.');
  const category = data.category !== undefined ? (String(data.category).trim() || 'Umum') : current.category;
  const unit = data.unit !== undefined ? (String(data.unit).trim() || 'pcs') : current.unit;
  let price = current.price;
  if (data.price !== undefined) {
    const parsed = Number(data.price);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Harga produk tidak valid.');
    price = Math.round(parsed);
  }
  const active = data.active !== undefined ? (data.active ? 1 : 0) : current.active;

  db.prepare(`
    UPDATE sales_products
    SET name = ?, category = ?, price = ?, unit = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND tenant_id = ?
  `).run(name, category, price, unit, active, productId, tenantId);

  return db.prepare('SELECT * FROM sales_products WHERE id = ? AND tenant_id = ?').get(productId, tenantId);
}

export function deleteProduct(tenantId, productId) {
  const res = db.prepare('DELETE FROM sales_products WHERE id = ? AND tenant_id = ?').run(productId, tenantId);
  if (!res.changes) {
    throw new Error('Produk tidak ditemukan.');
  }
  return { deleted: true, id: productId };
}

function normalizeDateString(raw) {
  const str = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
}

function normalizeTimeString(raw) {
  const str = String(raw || '').trim();
  return /^\d{2}:\d{2}$/.test(str) ? str : null;
}

function resolveSaleEventId(tenantId, rawEventId) {
  if (rawEventId && String(rawEventId).trim() && String(rawEventId).trim() !== 'all') {
    const ev = db.prepare('SELECT id FROM events WHERE id = ? AND tenant_id = ?').get(String(rawEventId).trim(), tenantId);
    if (!ev) throw new Error('Event tidak ditemukan.');
    return ev.id;
  }
  return null;
}

function normalizeSaleItemInput(tenantId, item = {}) {
  let product = null;
  if (item.productId) {
    product = db.prepare('SELECT * FROM sales_products WHERE id = ? AND tenant_id = ?').get(String(item.productId), tenantId);
    if (!product) throw new Error('Produk yang dipilih tidak ditemukan.');
  }

  const productName = String(item.productName || (product && product.name) || '').trim();
  if (!productName) {
    throw new Error('Pilih produk atau ketik nama produk yang terjual.');
  }

  const category = String(item.category || (product && product.category) || 'Umum').trim() || 'Umum';
  const unit = String(item.unit || (product && product.unit) || 'pcs').trim() || 'pcs';

  const rawUnitPrice = item.unitPrice !== undefined && item.unitPrice !== '' && item.unitPrice !== null
    ? Number(item.unitPrice)
    : (product ? Number(product.price) : NaN);
  if (!Number.isFinite(rawUnitPrice) || rawUnitPrice < 0) {
    throw new Error(`Harga satuan untuk "${productName}" tidak valid.`);
  }
  const unitPrice = Math.round(rawUnitPrice);

  const rawQty = Number(item.quantity ?? 1);
  if (!Number.isFinite(rawQty) || rawQty < 1 || rawQty > 10000) {
    throw new Error(`Jumlah terjual untuk "${productName}" minimal 1.`);
  }
  const quantity = Math.round(rawQty);

  return {
    product,
    productName,
    category,
    unit,
    unitPrice,
    quantity,
    totalAmount: unitPrice * quantity,
    saveToCatalog: !product && Boolean(item.saveToCatalog)
  };
}

function insertNormalizedSaleRow(tenantId, normalizedItem, sharedMeta) {
  let savedProductId = normalizedItem.product ? normalizedItem.product.id : null;
  if (normalizedItem.saveToCatalog) {
    const created = createProduct(tenantId, {
      name: normalizedItem.productName,
      category: normalizedItem.category,
      price: normalizedItem.unitPrice,
      unit: normalizedItem.unit
    });
    savedProductId = created.id;
  }

  const id = 'sale_' + crypto.randomBytes(6).toString('hex');
  db.prepare(`
    INSERT INTO sales_transactions (
      id, tenant_id, receipt_id, event_id, product_id, product_name, category, unit,
      unit_price, quantity, total_amount, payment_method, customer_name, notes,
      sold_date, sold_time, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, tenantId, sharedMeta.receiptId, sharedMeta.eventId, savedProductId,
    normalizedItem.productName, normalizedItem.category, normalizedItem.unit,
    normalizedItem.unitPrice, normalizedItem.quantity, normalizedItem.totalAmount,
    sharedMeta.paymentMethod, sharedMeta.customerName, sharedMeta.notes,
    sharedMeta.soldDate, sharedMeta.soldTime, sharedMeta.actorName
  );
  return id;
}

function resolveSharedReceiptMeta(tenantId, data = {}, actorName = 'Admin') {
  const eventId = resolveSaleEventId(tenantId, data.eventId);
  const rawMethod = String(data.paymentMethod || 'Tunai').trim();
  const paymentMethod = VALID_PAYMENT_METHODS.has(rawMethod) ? rawMethod : 'Tunai';
  const customerName = String(data.customerName || '').trim().slice(0, 120);
  const notes = String(data.notes || '').trim().slice(0, 300);
  const localNow = getTenantLocalDateInfo(tenantId, eventId);
  const soldDate = normalizeDateString(data.soldDate) || localNow.date;
  const soldTime = normalizeTimeString(data.soldTime) || localNow.time;
  const rawReceipt = String(data.receiptId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const receiptId = rawReceipt || ('rcp_' + crypto.randomBytes(6).toString('hex'));

  return {
    receiptId,
    eventId,
    paymentMethod,
    customerName,
    notes,
    soldDate,
    soldTime,
    actorName: String(actorName || 'Admin').slice(0, 80)
  };
}

export function recordSale(tenantId, data = {}, actorName = 'Admin') {
  const item = normalizeSaleItemInput(tenantId, data);
  const meta = resolveSharedReceiptMeta(tenantId, data, actorName);
  const id = runInTransaction(() => insertNormalizedSaleRow(tenantId, item, meta));

  return db.prepare(`
    SELECT s.*, e.name as event_name
    FROM sales_transactions s
    LEFT JOIN events e ON e.id = s.event_id
    WHERE s.id = ? AND s.tenant_id = ?
  `).get(id, tenantId);
}

export function recordSaleBatch(tenantId, data = {}, actorName = 'Admin') {
  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (rawItems.length === 0) {
    throw new Error('Keranjang belanja kosong. Tambahkan minimal 1 produk.');
  }
  if (rawItems.length > 50) {
    throw new Error('Maksimal 50 produk dalam 1 nota penjualan.');
  }

  const normalizedItems = rawItems.map((it) => normalizeSaleItemInput(tenantId, it));
  const meta = resolveSharedReceiptMeta(tenantId, data, actorName);

  const insertedIds = runInTransaction(() =>
    normalizedItems.map((item) => insertNormalizedSaleRow(tenantId, item, meta))
  );

  const placeholders = insertedIds.map(() => '?').join(', ');
  const items = db.prepare(`
    SELECT s.*, e.name as event_name
    FROM sales_transactions s
    LEFT JOIN events e ON e.id = s.event_id
    WHERE s.tenant_id = ? AND s.id IN (${placeholders})
    ORDER BY s.created_at ASC, s.id ASC
  `).all(tenantId, ...insertedIds);

  return {
    receiptId: meta.receiptId,
    itemsCount: items.length,
    totalQuantity: items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0),
    totalAmount: items.reduce((sum, it) => sum + (Number(it.total_amount) || 0), 0),
    items
  };
}

export function updateSale(tenantId, saleId, data = {}, actorName = 'Admin') {
  const current = db.prepare('SELECT * FROM sales_transactions WHERE id = ? AND tenant_id = ?').get(saleId, tenantId);
  if (!current) {
    const err = new Error('Transaksi penjualan tidak ditemukan.');
    err.statusCode = 404;
    throw err;
  }

  const productName = data.productName !== undefined
    ? String(data.productName).trim()
    : current.product_name;
  if (!productName) {
    throw new Error('Nama produk tidak boleh kosong.');
  }

  const category = data.category !== undefined
    ? (String(data.category).trim() || 'Umum')
    : current.category;
  const unit = data.unit !== undefined
    ? (String(data.unit).trim() || 'pcs')
    : current.unit;

  const unitPrice = data.unitPrice !== undefined && data.unitPrice !== '' && data.unitPrice !== null
    ? Math.round(Number(data.unitPrice))
    : Number(current.unit_price);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new Error('Harga satuan penjualan tidak valid.');
  }

  const quantity = data.quantity !== undefined && data.quantity !== '' && data.quantity !== null
    ? Math.round(Number(data.quantity))
    : Number(current.quantity);
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 10000) {
    throw new Error('Jumlah terjual minimal 1.');
  }
  const totalAmount = unitPrice * quantity;

  let eventId = current.event_id;
  if (data.eventId !== undefined) {
    const rawEv = String(data.eventId || '').trim();
    if (!rawEv || rawEv === 'all') {
      eventId = null;
    } else {
      const ev = db.prepare('SELECT id FROM events WHERE id = ? AND tenant_id = ?').get(rawEv, tenantId);
      if (!ev) throw new Error('Event tidak ditemukan.');
      eventId = ev.id;
    }
  }

  const rawMethod = data.paymentMethod !== undefined ? String(data.paymentMethod).trim() : current.payment_method;
  const paymentMethod = VALID_PAYMENT_METHODS.has(rawMethod) ? rawMethod : 'Tunai';
  const customerName = data.customerName !== undefined
    ? String(data.customerName || '').trim().slice(0, 120)
    : (current.customer_name || '');
  const notes = data.notes !== undefined
    ? String(data.notes || '').trim().slice(0, 300)
    : (current.notes || '');
  const soldDate = data.soldDate !== undefined
    ? (normalizeDateString(data.soldDate) || current.sold_date)
    : current.sold_date;
  const soldTime = data.soldTime !== undefined
    ? (normalizeTimeString(data.soldTime) || current.sold_time)
    : current.sold_time;

  db.prepare(`
    UPDATE sales_transactions
    SET event_id = ?, product_name = ?, category = ?, unit = ?,
        unit_price = ?, quantity = ?, total_amount = ?, payment_method = ?,
        customer_name = ?, notes = ?, sold_date = ?, sold_time = ?
    WHERE id = ? AND tenant_id = ?
  `).run(
    eventId, productName, category, unit,
    unitPrice, quantity, totalAmount, paymentMethod,
    customerName, notes, soldDate, soldTime,
    saleId, tenantId
  );

  return db.prepare(`
    SELECT s.*, e.name as event_name
    FROM sales_transactions s
    LEFT JOIN events e ON e.id = s.event_id
    WHERE s.id = ? AND s.tenant_id = ?
  `).get(saleId, tenantId);
}

export function deleteSale(tenantId, saleId) {
  const res = db.prepare('DELETE FROM sales_transactions WHERE id = ? AND tenant_id = ?').run(saleId, tenantId);
  if (!res.changes) {
    const err = new Error('Transaksi penjualan tidak ditemukan.');
    err.statusCode = 404;
    throw err;
  }
  return { deleted: true, id: saleId };
}

export function getSalesReport(tenantId, filters = {}) {
  const localNow = getTenantLocalDateInfo(tenantId, filters.eventId || null);
  const rawDate = String(filters.date || '').trim();
  const startDate = normalizeDateString(filters.startDate);
  const endDate = normalizeDateString(filters.endDate);
  const eventId = filters.eventId && filters.eventId !== 'all' ? String(filters.eventId).trim() : null;

  const whereParts = ['s.tenant_id = ?'];
  const params = [tenantId];

  let appliedRange = { mode: 'day', date: localNow.date, startDate: localNow.date, endDate: localNow.date };
  if (startDate && endDate) {
    whereParts.push('s.sold_date >= ? AND s.sold_date <= ?');
    params.push(startDate, endDate);
    appliedRange = { mode: 'range', date: null, startDate, endDate };
  } else if (rawDate === 'all') {
    appliedRange = { mode: 'all', date: 'all', startDate: null, endDate: null };
  } else {
    const targetDay = normalizeDateString(rawDate) || localNow.date;
    whereParts.push('s.sold_date = ?');
    params.push(targetDay);
    appliedRange = { mode: 'day', date: targetDay, startDate: targetDay, endDate: targetDay };
  }

  if (eventId) {
    whereParts.push('s.event_id = ?');
    params.push(eventId);
  }

  const rows = db.prepare(`
    SELECT s.*, e.name as event_name
    FROM sales_transactions s
    LEFT JOIN events e ON e.id = s.event_id
    WHERE ${whereParts.join(' AND ')}
    ORDER BY s.sold_date DESC, s.sold_time DESC, s.created_at DESC
  `).all(...params);

  let totalRevenue = 0;
  let totalItemsSold = 0;
  const receiptIds = new Set();
  const receiptCounts = new Map();
  const byPaymentMethod = {};
  const productMap = new Map();
  const dailyMap = new Map();

  for (const row of rows) {
    const receiptKey = row.receipt_id || row.id;
    receiptIds.add(receiptKey);
    receiptCounts.set(receiptKey, (receiptCounts.get(receiptKey) || 0) + 1);

    const qty = Number(row.quantity) || 0;
    const rev = Number(row.total_amount) || 0;
    totalRevenue += rev;
    totalItemsSold += qty;

    const method = row.payment_method || 'Tunai';
    if (!byPaymentMethod[method]) {
      byPaymentMethod[method] = { method, _receipts: new Set(), transactionsCount: 0, totalQty: 0, totalRevenue: 0 };
    }
    byPaymentMethod[method]._receipts.add(receiptKey);
    byPaymentMethod[method].transactionsCount = byPaymentMethod[method]._receipts.size;
    byPaymentMethod[method].totalQty += qty;
    byPaymentMethod[method].totalRevenue += rev;

    const pKey = `${row.product_name}__${row.unit || 'pcs'}`;
    if (!productMap.has(pKey)) {
      productMap.set(pKey, {
        productId: row.product_id || null,
        productName: row.product_name,
        category: row.category || 'Umum',
        unit: row.unit || 'pcs',
        totalQty: 0,
        totalRevenue: 0,
        transactionsCount: 0,
        lastUnitPrice: Number(row.unit_price) || 0
      });
    }
    const pAgg = productMap.get(pKey);
    pAgg.totalQty += qty;
    pAgg.totalRevenue += rev;
    pAgg.transactionsCount += 1;

    const dKey = row.sold_date;
    if (!dailyMap.has(dKey)) {
      dailyMap.set(dKey, {
        date: dKey,
        _receipts: new Set(),
        totalQty: 0,
        totalRevenue: 0,
        itemCounts: new Map()
      });
    }
    const dAgg = dailyMap.get(dKey);
    dAgg._receipts.add(receiptKey);
    dAgg.totalQty += qty;
    dAgg.totalRevenue += rev;
    dAgg.itemCounts.set(row.product_name, (dAgg.itemCounts.get(row.product_name) || 0) + qty);
  }

  for (const m of Object.values(byPaymentMethod)) {
    delete m._receipts;
  }

  const itemsSold = Array.from(productMap.values()).sort((a, b) =>
    (b.totalQty - a.totalQty) || (b.totalRevenue - a.totalRevenue) || a.productName.localeCompare(b.productName)
  );

  const dailyBreakdown = Array.from(dailyMap.values())
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((d) => ({
      date: d.date,
      transactionsCount: d._receipts.size,
      totalQty: d.totalQty,
      totalRevenue: d.totalRevenue,
      itemsSummary: Array.from(d.itemCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, qty]) => `${name} (${qty})`)
        .join(', ')
    }));

  const annotatedTransactions = rows.map((row) => {
    const key = row.receipt_id || row.id;
    return {
      ...row,
      receipt_item_count: receiptCounts.get(key) || 1
    };
  });

  return {
    todayDate: localNow.date,
    timeZone: localNow.timeZone,
    appliedRange,
    summary: {
      totalRevenue,
      totalItemsSold,
      totalTransactions: receiptIds.size,
      totalLineItems: rows.length,
      byPaymentMethod
    },
    itemsSold,
    dailyBreakdown,
    transactions: annotatedTransactions
  };
}

function escapeCsvCell(val) {
  let str = String(val ?? '');
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

export function buildSalesCsv(report) {
  const header = [
    'Tanggal',
    'Jam',
    'No. Nota',
    'Event',
    'Nama Produk',
    'Kategori',
    'Jumlah',
    'Satuan',
    'Harga Satuan (Rp)',
    'Total (Rp)',
    'Metode Bayar',
    'Pembeli',
    'Catatan',
    'Kasir'
  ];
  const lines = [header.map(escapeCsvCell).join(',')];
  for (const row of report.transactions || []) {
    lines.push([
      row.sold_date,
      row.sold_time,
      row.receipt_id || row.id,
      row.event_name || '-',
      row.product_name,
      row.category || 'Umum',
      row.quantity,
      row.unit || 'pcs',
      row.unit_price,
      row.total_amount,
      row.payment_method || 'Tunai',
      row.customer_name || '',
      row.notes || '',
      row.created_by || 'Admin'
    ].map(escapeCsvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}
