import crypto from 'node:crypto';
import { db } from '../db/database.js';

export function logAudit(tenantId, userId, actorName, action, details = {}, ip = '127.0.0.1') {
  const auditId = 'audit_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO audit_logs (id, tenant_id, user_id, actor_name, action, details_json, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    auditId,
    tenantId || null,
    userId || null,
    actorName || 'System',
    action,
    JSON.stringify(details),
    ip
  );
  return auditId;
}

export function getAuditLogs(tenantId = null, limit = 50) {
  let query = 'SELECT * FROM audit_logs';
  const params = [];
  if (tenantId) {
    query += ' WHERE tenant_id = ?';
    params.push(tenantId);
  }
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params).map(log => ({
    ...log,
    details: JSON.parse(log.details_json || '{}')
  }));
}
