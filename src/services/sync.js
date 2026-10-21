import crypto from 'node:crypto';
import { db } from '../db/database.js';

export function queueSyncJob(tenantId, deviceId, eventId, jobType, payload, idempotencyKey) {
  const existing = db.prepare('SELECT * FROM sync_jobs WHERE idempotency_key = ?').get(idempotencyKey);
  if (existing) {
    return { success: true, message: 'Job already queued or reconciled', jobId: existing.id, state: existing.state };
  }

  const jobId = 'sync_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO sync_jobs (id, tenant_id, device_id, event_id, job_type, payload_json, state, attempts, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, ?)
  `).run(
    jobId,
    tenantId,
    deviceId,
    eventId,
    jobType,
    JSON.stringify(payload),
    idempotencyKey
  );

  return { success: true, jobId, state: 'completed' };
}

export function processBatchSync(tenantId, deviceId, eventId, items = []) {
  const results = [];
  db.exec('BEGIN TRANSACTION');
  try {
    for (const item of items) {
      const { jobType, payload, idempotencyKey } = item;
      const res = queueSyncJob(tenantId, deviceId, eventId, jobType, payload, idempotencyKey);
      results.push(res);
    }
    db.exec('COMMIT');
    return { processedCount: results.length, items: results };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
