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
  assert.match(adminJs, /function loadSalesDashboard\(/);
  assert.match(adminJs, /function submitSalesProduct\(/);
  assert.match(adminJs, /function submitSalesTransaction\(/);
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

    // Edit price on product 1
    const patchRes = await fetch(`${baseUrl}/api/sales/products/${prod1.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({ price: 40000 })
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).price, 40000);

    // Tenant A cannot edit or delete Tenant B product
    const crossPatch = await fetch(`${baseUrl}/api/sales/products/${prod1.id}`, {
      method: 'PATCH',
      headers: headersA,
      body: JSON.stringify({ price: 100 })
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

    // Verify catalog deletion preserves historical sold snapshot
    const delProdRes = await fetch(`${baseUrl}/api/sales/products/${prod2.id}`, {
      method: 'DELETE',
      headers: headersB
    });
    assert.equal(delProdRes.status, 200);

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

    // 8. Delete one transaction and verify totals update
    const delTxRes = await fetch(`${baseUrl}/api/sales/transactions/${sale2.id}`, {
      method: 'DELETE',
      headers: headersB
    });
    assert.equal(delTxRes.status, 200);
    const repAfterDel = await (await fetch(`${baseUrl}/api/sales/report?date=${day2}`, { headers: headersB })).json();
    assert.equal(repAfterDel.summary.totalRevenue, 80000);
    assert.equal(repAfterDel.summary.totalItemsSold, 2);
  } finally {
    db.prepare('DELETE FROM tenants WHERE id = ?').run(otherTenantId);
    srv.closeAllConnections?.();
    srv.close();
  }
});
