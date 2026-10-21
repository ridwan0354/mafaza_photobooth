import crypto from 'node:crypto';
import { db } from '../db/database.js';

export function getPlans() {
  return db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY price ASC').all().map(p => ({
    ...p,
    entitlements: JSON.parse(p.entitlements_json)
  }));
}

export function getTenantSubscription(tenantId) {
  const sub = db.prepare(`
    SELECT s.*, p.name as plan_name, p.billing_type, p.price, p.entitlements_json
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.tenant_id = ?
    ORDER BY s.created_at DESC LIMIT 1
  `).get(tenantId);

  if (!sub) return null;
  return {
    ...sub,
    entitlements: JSON.parse(sub.entitlements_json)
  };
}

export function createSubscriptionInvoice(tenantId, planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) throw new Error('Paket langganan tidak ditemukan');

  const subId = 'sub_' + crypto.randomBytes(8).toString('hex');
  const invId = 'inv_' + crypto.randomBytes(8).toString('hex');

  // Generate unique verification code & reference number
  const uniqueCode = Math.floor(100 + Math.random() * 899);
  const totalAmount = plan.price + uniqueCode;
  const refNumber = `INV-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${uniqueCode}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  db.prepare(`
    INSERT INTO subscriptions (id, tenant_id, plan_id, status)
    VALUES (?, ?, ?, 'pending')
  `).run(subId, tenantId, planId);

  db.prepare(`
    INSERT INTO invoices (id, tenant_id, subscription_id, amount, unique_reference, bank_account, status, due_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', datetime('now', '+3 days'))
  `).run(
    invId,
    tenantId,
    subId,
    totalAmount,
    refNumber,
    'BCA 8720192837 a/n PT Photobooth Indonesia'
  );

  return {
    subscriptionId: subId,
    invoiceId: invId,
    amount: totalAmount,
    uniqueReference: refNumber,
    bankAccount: 'BCA 8720192837 a/n PT Photobooth Indonesia',
    status: 'pending_payment'
  };
}

export function submitPaymentProof(invoiceId, userId, filePath) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) throw new Error('Invoice tidak ditemukan');

  const proofId = 'proof_' + crypto.randomBytes(8).toString('hex');

  db.prepare(`
    INSERT INTO payment_proofs (id, invoice_id, file_path, uploaded_by, review_status)
    VALUES (?, ?, ?, ?, 'submitted')
  `).run(proofId, invoiceId, filePath, userId);

  db.prepare(`
    UPDATE invoices SET status = 'under_review' WHERE id = ?
  `).run(invoiceId);

  return { proofId, status: 'submitted' };
}

export function approveInvoice(invoiceId, reviewerId) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) throw new Error('Invoice tidak ditemukan');
  if (invoice.status === 'approved') return { success: true, message: 'Sudah disetujui sebelumnya' };

  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(invoice.subscription_id);
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(sub.plan_id);

  let durationDays = 30;
  if (plan.billing_type === 'yearly') durationDays = 365;
  if (plan.billing_type === 'per_event') durationDays = 14;

  // Transaction: approve invoice, activate subscription, record audit
  db.exec('BEGIN TRANSACTION');
  try {
    db.prepare(`
      UPDATE invoices SET status = 'approved' WHERE id = ?
    `).run(invoiceId);

    db.prepare(`
      UPDATE payment_proofs SET review_status = 'approved', reviewer_id = ?, reviewed_at = datetime('now')
      WHERE invoice_id = ?
    `).run(reviewerId, invoiceId);

    db.prepare(`
      UPDATE subscriptions
      SET status = 'active',
          starts_at = datetime('now'),
          ends_at = datetime('now', '+${durationDays} days'),
          grace_until = datetime('now', '+${durationDays + 7} days')
      WHERE id = ?
    `).run(invoice.subscription_id);

    db.prepare(`
      INSERT INTO audit_logs (id, tenant_id, user_id, actor_name, action, details_json)
      VALUES (?, ?, ?, 'Super Admin', 'approve_invoice', ?)
    `).run(
      'audit_' + crypto.randomBytes(8).toString('hex'),
      invoice.tenant_id,
      reviewerId,
      JSON.stringify({ invoiceId, amount: invoice.amount, planName: plan.name })
    );

    db.exec('COMMIT');
    return { success: true, message: 'Invoice berhasil disetujui dan paket aktif!' };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function rejectInvoice(invoiceId, reviewerId, reason) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) throw new Error('Invoice tidak ditemukan');

  db.exec('BEGIN TRANSACTION');
  try {
    db.prepare(`
      UPDATE invoices SET status = 'rejected' WHERE id = ?
    `).run(invoiceId);

    db.prepare(`
      UPDATE payment_proofs SET review_status = 'rejected', reviewer_id = ?, reviewed_at = datetime('now'), reason = ?
      WHERE invoice_id = ?
    `).run(reviewerId, reason, invoiceId);

    db.exec('COMMIT');
    return { success: true, message: 'Invoice ditolak dengan alasan: ' + reason };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
