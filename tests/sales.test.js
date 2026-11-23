import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { initDatabase, db } from '../src/db/database.js';
import { apiRouter } from '../src/routes/api.js';
import { createToken } from '../src/services/auth.js';

initDatabase();

test('Sales Catalog, Ad-hoc Products, Daily Reports, CSV Export, and Tenant Isolation work end-to-end', async () => {
  const root = process.cwd();
  const adminHtml = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(root, 'public/js/admin.js'), 'utf8');
  assert.match(adminHtml, /id="navBtnSales"[^>]*switchTab\('sales', this\)/);
  assert.match(adminHtml, /id="tab-sales"/);
  assert.match(adminHtml, /id="salesItemsSoldTableBody"/);
  assert.match(adminHtml, /id="salesDailyBreakdownTableBody"/);
  assert.match(adminHtml, /id="salesTransactionsTableBody"/);
  assert.match(adminHtml, /id="salesPinModal"/);
  assert.match(adminHtml, /id="editSaleModal"/);
  assert.match(adminHtml, /id="btnAddToSalesCart"/);
  assert.match(adminHtml, /id="salesCartBox"/);
  assert.match(adminJs, /function loadSalesDashboard\(/);
  assert.match(adminJs, /function addCurrentItemToSalesCart\(/);
  assert.match(adminJs, /function renderSalesCart\(/);
  assert.match(adminJs, /function submitSalesProduct\(/);
  assert.match(adminJs, /function submitSalesTransaction\(/);
  assert.match(adminJs, /function openSalesPinModal\(/);
  assert.match(adminJs, /function submitEditSale\(/);
  assert.match(adminJs, /function exportSalesCsv\(/);

  const app = express();
  app.use((req, res, next) => { req.cookies = {}; next(); });
  app.use(express.json());
  app.use('/api', apiRouter);
  const srv = app.listen(0);
  const port = srv.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const suffix = Date.now();
  const otherTenantId = `tenant_sales_iso_${suffix}`;
  const createdProductIds = [];
  const createdSaleIds = [];

  try {
    db.prepare('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)')
      .run(otherTenantId, 'Studio Lain', `studio-lain-${suffix}`, 'active');

    // 1. Auth guard checks
    const unauthReport = await fetch(`${baseUrl}/api/sales/report`);
    assert.equal(unauthReport.status, 401);
    const unauthProd = await fetch(`${baseUrl}/api/sales/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', price: 1000 })
    });
    assert.equal(unauthProd.status, 401);

    const tokenA = createToken({ userId: 'u_admin', tenantId: 'tenant_studiokeren_01', role: 'business_admin', email: 'kasirA@mafaza.id' });
    const tokenB = createToken({ userId: 'u_other', tenantId: otherTenantId, role: 'business_admin', email: 'kasirB@lain.id' });
    const headersA = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` };
    const headersB = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` };

    // 2. Create arbitrary products for Tenant B (isolated from default Tenant A seed data)
    const prodRes1 = await fetch(`${baseUrl}/api/sales/products`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ name: 'Frame Akrilik 4R', category: 'Aksesoris', price: 35000, unit: 'pcs' })
    });
    assert.equal(prodRes1.status, 201);
    const prod1 = await prodRes1.json();
    createdProductIds.push(prod1.id);

    const prodRes2 = await fetch(`${baseUrl}/api/sales/products`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ name: 'Es Kopi Susu Booth', category: 'Minuman', price: 18000, unit: 'cup' })
    });
    assert.equal(prodRes2.status, 201);
    const prod2 = await prodRes2.json();
    createdProductIds.push(prod2.id);

    // Edit price on product 1 requires PIN 1318
    const patchNoPin = await fetch(`${baseUrl}/api/sales/products/${prod1.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({ price: 40000 })
    });
    assert.equal(patchNoPin.status, 403);

    const patchBadPin = await fetch(`${baseUrl}/api/sales/products/${prod1.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({ pin: '0000', price: 40000 })
    });
    assert.equal(patchBadPin.status, 403);

    const patchRes = await fetch(`${baseUrl}/api/sales/products/${prod1.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({ pin: '1318', price: 40000 })
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).price, 40000);

    // Tenant A cannot edit or delete Tenant B product even with PIN 1318
    const crossPatch = await fetch(`${baseUrl}/api/sales/products/${prod1.id}`, {
      method: 'PATCH',
      headers: headersA,
      body: JSON.stringify({ pin: '1318', price: 100 })
    });
    assert.equal(crossPatch.status, 404);

    // 3. Record sales across 2 dates + ad-hoc product saved to catalog
    const day1 = '2026-11-22';
    const day2 = '2026-11-23';

    const sale1Res = await fetch(`${baseUrl}/api/sales/transactions`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({
        productId: prod1.id,
        quantity: 2,
        paymentMethod: 'QRIS',
        soldDate: day2,
        soldTime: '14:10',
        notes: 'Tamu VIP'
      })
    });
    assert.equal(sale1Res.status, 201);
    const sale1 = await sale1Res.json();
    createdSaleIds.push(sale1.id);
    assert.equal(sale1.total_amount, 80000);

    const sale2Res = await fetch(`${baseUrl}/api/sales/transactions`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({
        productId: prod2.id,
        quantity: 3,
        paymentMethod: 'Tunai',
        soldDate: day2,
        soldTime: '15:00'
      })
    });
    assert.equal(sale2Res.status, 201);
    const sale2 = await sale2Res.json();
    createdSaleIds.push(sale2.id);
    assert.equal(sale2.total_amount, 54000);

    const sale3Res = await fetch(`${baseUrl}/api/sales/transactions`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({
        productName: 'Gantungan Kunci Custom',
        category: 'Aksesoris',
        unit: 'pcs',
        unitPrice: 25000,
        quantity: 4,
        paymentMethod: 'Transfer',
        soldDate: day1,
        soldTime: '19:30',
        saveToCatalog: true,
        notes: '=SUM(1+1) Formula Safe Check'
      })
    });
    assert.equal(sale3Res.status, 201);
    const sale3 = await sale3Res.json();
    createdSaleIds.push(sale3.id);
    assert.ok(sale3.product_id, 'saveToCatalog creates catalog entry automatically');
    createdProductIds.push(sale3.product_id);

    // Delete product requires PIN 1318 and preserves historical sold snapshot
    const delProdNoPin = await fetch(`${baseUrl}/api/sales/products/${prod2.id}`, {
      method: 'DELETE',
      headers: headersB
    });
    assert.equal(delProdNoPin.status, 403);

    const delProdRes = await fetch(`${baseUrl}/api/sales/products/${prod2.id}`, {
      method: 'DELETE',
      headers: headersB,
      body: JSON.stringify({ pin: '1318' })
    });
    assert.equal(delProdRes.status, 200);

    // Verify editing catalog price today (e.g. 20k -> 15k) NEVER alters yesterday's sales snapshot
    const histProd = await (await fetch(`${baseUrl}/api/sales/products`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ name: 'Foto Kilat 4R', category: 'Cetak', price: 20000, unit: 'lembar' })
    })).json();
    const day0 = '2026-11-21';
    await fetch(`${baseUrl}/api/sales/transactions`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ productId: histProd.id, quantity: 1, soldDate: day0, soldTime: '10:00' })
    });
    const histPatch = await fetch(`${baseUrl}/api/sales/products/${histProd.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({ pin: '1318', price: 15000 })
    });
    assert.equal(histPatch.status, 200);
    const day0Rep = await (await fetch(`${baseUrl}/api/sales/report?date=${day0}`, { headers: headersB })).json();
    assert.equal(day0Rep.summary.totalRevenue, 20000, 'Yesterday sales price remains 20,000 after catalog edit to 15,000');

    // 4. Daily report for day2
    const repDay2Res = await fetch(`${baseUrl}/api/sales/report?date=${day2}`, { headers: headersB });
    assert.equal(repDay2Res.status, 200);
    const repDay2 = await repDay2Res.json();
    assert.equal(repDay2.summary.totalRevenue, 134000);
    assert.equal(repDay2.summary.totalItemsSold, 5);
    assert.equal(repDay2.summary.totalTransactions, 2);
    assert.equal(repDay2.summary.byPaymentMethod.QRIS.totalRevenue, 80000);
    assert.equal(repDay2.summary.byPaymentMethod.Tunai.totalRevenue, 54000);
    assert.equal(repDay2.itemsSold.length, 2);
    assert.equal(repDay2.itemsSold[0].productName, 'Es Kopi Susu Booth');
    assert.equal(repDay2.itemsSold[0].totalQty, 3);
    assert.equal(repDay2.itemsSold[1].productName, 'Frame Akrilik 4R');
    assert.equal(repDay2.itemsSold[1].totalQty, 2);

    // 5. Range report across day1..day2 -> verifies dailyBreakdown & itemsSummary
    const repRangeRes = await fetch(`${baseUrl}/api/sales/report?startDate=${day1}&endDate=${day2}`, { headers: headersB });
    assert.equal(repRangeRes.status, 200);
    const repRange = await repRangeRes.json();
    assert.equal(repRange.summary.totalRevenue, 234000);
    assert.equal(repRange.summary.totalItemsSold, 9);
    assert.equal(repRange.dailyBreakdown.length, 2);
    assert.equal(repRange.dailyBreakdown[0].date, day2);
    assert.match(repRange.dailyBreakdown[0].itemsSummary, /Es Kopi Susu Booth \(3\)/);
    assert.match(repRange.dailyBreakdown[0].itemsSummary, /Frame Akrilik 4R \(2\)/);
    assert.equal(repRange.dailyBreakdown[1].date, day1);
    assert.equal(repRange.dailyBreakdown[1].totalRevenue, 100000);

    // 6. Tenant A cannot see Tenant B's custom sales
    const repARes = await fetch(`${baseUrl}/api/sales/report?date=all`, { headers: headersA });
    const repA = await repARes.json();
    assert.ok(!repA.transactions.some(t => t.tenant_id === otherTenantId));

    // 7. CSV export escapes spreadsheet formula prefixes cleanly
    const csvRes = await fetch(`${baseUrl}/api/sales/report/export?date=all`, { headers: headersB });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
    const csvText = await csvRes.text();
    assert.match(csvText, /"Frame Akrilik 4R"/);
    assert.match(csvText, /"Es Kopi Susu Booth"/);
    assert.match(csvText, /"'=SUM\(1\+1\) Formula Safe Check"/);

    // 8. Verify PIN 1318 requirement for BOTH Editing and Deleting sales
    const verifyBadPin = await fetch(`${baseUrl}/api/sales/verify-pin`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ pin: '0000' })
    });
    assert.equal(verifyBadPin.status, 403);

    const verifyGoodPin = await fetch(`${baseUrl}/api/sales/verify-pin`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ pin: '1318' })
    });
    assert.equal(verifyGoodPin.status, 200);
    assert.equal((await verifyGoodPin.json()).valid, true);

    // Edit sale blocked without PIN or with wrong PIN
    const editNoPin = await fetch(`${baseUrl}/api/sales/transactions/${sale1.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({ quantity: 5 })
    });
    assert.equal(editNoPin.status, 403);

    const editBadPin = await fetch(`${baseUrl}/api/sales/transactions/${sale1.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({ pin: '1234', quantity: 5 })
    });
    assert.equal(editBadPin.status, 403);

    // Cross-tenant edit blocked even with PIN 1318
    const editCross = await fetch(`${baseUrl}/api/sales/transactions/${sale1.id}`, {
      method: 'PATCH',
      headers: headersA,
      body: JSON.stringify({ pin: '1318', quantity: 9 })
    });
    assert.equal(editCross.status, 404);

    // Edit sale succeeds with PIN 1318 & recalculates total_amount
    const editOk = await fetch(`${baseUrl}/api/sales/transactions/${sale1.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({
        pin: '1318',
        quantity: 3,
        unitPrice: 45000,
        paymentMethod: 'Transfer',
        notes: 'Diedit Owner'
      })
    });
    assert.equal(editOk.status, 200);
    const updatedSale1 = await editOk.json();
    assert.equal(updatedSale1.quantity, 3);
    assert.equal(updatedSale1.unit_price, 45000);
    assert.equal(updatedSale1.total_amount, 135000);
    assert.equal(updatedSale1.payment_method, 'Transfer');

    // Delete sale blocked without PIN or with wrong PIN
    const delNoPin = await fetch(`${baseUrl}/api/sales/transactions/${sale2.id}`, {
      method: 'DELETE',
      headers: headersB
    });
    assert.equal(delNoPin.status, 403);

    const delBadPin = await fetch(`${baseUrl}/api/sales/transactions/${sale2.id}`, {
      method: 'DELETE',
      headers: headersB,
      body: JSON.stringify({ pin: '9999' })
    });
    assert.equal(delBadPin.status, 403);

    // Delete succeeds with PIN 1318 and totals reflect updated sale1 (135000) without sale2
    const delTxRes = await fetch(`${baseUrl}/api/sales/transactions/${sale2.id}`, {
      method: 'DELETE',
      headers: headersB,
      body: JSON.stringify({ pin: '1318' })
    });
    assert.equal(delTxRes.status, 200);
    const repAfterDel = await (await fetch(`${baseUrl}/api/sales/report?date=${day2}`, { headers: headersB })).json();
    assert.equal(repAfterDel.summary.totalRevenue, 135000);
    assert.equal(repAfterDel.summary.totalItemsSold, 3);
    assert.equal(repAfterDel.summary.totalTransactions, 1);

    // 9. Multi-product cart checkout on day3 counts as 1 transaction/receipt while reporting each product
    const day3 = '2026-11-24';
    const cartRes = await fetch(`${baseUrl}/api/sales/transactions`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({
        paymentMethod: 'QRIS',
        soldDate: day3,
        soldTime: '11:45',
        notes: 'Pembelian Paket Keluarga',
        items: [
          { productId: prod1.id, quantity: 2 }, // 2 x 40,000 = 80,000
          { productName: 'Softcopy Bonus', category: 'Digital', unit: 'sesi', unitPrice: 15000, quantity: 1 },
          { productName: 'Air Mineral Booth', category: 'Minuman', unit: 'botol', unitPrice: 5000, quantity: 3 }
        ]
      })
    });
    assert.equal(cartRes.status, 201);
    const cartData = await cartRes.json();
    assert.ok(cartData.receiptId);
    assert.equal(cartData.itemsCount, 3);
    assert.equal(cartData.totalQuantity, 6);
    assert.equal(cartData.totalAmount, 110000);

    const day3Rep = await (await fetch(`${baseUrl}/api/sales/report?date=${day3}`, { headers: headersB })).json();
    assert.equal(day3Rep.summary.totalRevenue, 110000);
    assert.equal(day3Rep.summary.totalItemsSold, 6);
    assert.equal(day3Rep.summary.totalTransactions, 1, '3 products purchased together in 1 cart share 1 receipt/transaction');
    assert.equal(day3Rep.summary.totalLineItems, 3);
    assert.equal(day3Rep.itemsSold.length, 3);
    assert.ok(day3Rep.transactions.every(t => t.receipt_id === cartData.receiptId && t.receipt_item_count === 3));

    const csvDay3 = await (await fetch(`${baseUrl}/api/sales/report/export?date=${day3}`, { headers: headersB })).text();
    assert.match(csvDay3, /"No\. Nota"/);
    assert.match(csvDay3, new RegExp(cartData.receiptId));
  } finally {
    db.prepare('DELETE FROM tenants WHERE id = ?').run(otherTenantId);
    srv.closeAllConnections?.();
    srv.close();
  }
});
