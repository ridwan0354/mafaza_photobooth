import crypto from 'node:crypto';
import { db } from '../db/database.js';

export function recordAiConsent(tenantId, eventId, photoSessionId, consentType = 'ai_photo_processing', granted = true) {
  const consentId = 'cns_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO privacy_consents (id, tenant_id, event_id, photo_session_id, consent_type, granted)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(consentId, tenantId, eventId, photoSessionId, consentType, granted ? 1 : 0);
  return consentId;
}

export function processAiJob(tenantId, eventId, photoSessionId, feature, options = {}) {
  // If face_swap, verify consent
  if (feature === 'face_swap' && !options.hasConsent) {
    throw new Error('Persetujuan (Consent) eksplisit wajib diberikan sebelum menggunakan fitur Face Swap.');
  }

  const models = {
    bg_removal: 'Local-U2Net-v2',
    beauty_smoothing: 'Local-BilateralFace-Retouch',
    cartoon_filter: 'Cloud-AnimeStyle-SDXL',
    face_swap: 'Local-InsightFace-Protected'
  };

  const modelUsed = models[feature] || 'Local-Default-Model';
  const latency = Math.floor(180 + Math.random() * 450); // ms
  const cost = feature.includes('Cloud') ? 50 : 0; // Rp 50 per cloud call

  const recordId = 'air_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO ai_usage_records (id, tenant_id, event_id, photo_session_id, model, feature, latency_ms, cost_est, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success')
  `).run(recordId, tenantId, eventId, photoSessionId, modelUsed, feature, latency, cost);

  return {
    recordId,
    feature,
    modelUsed,
    status: 'success',
    latencyMs: latency,
    costEst: cost,
    appliedFilter: feature
  };
}

export function getAiUsageStats(tenantId) {
  return db.prepare(`
    SELECT feature, COUNT(*) as count, SUM(cost_est) as total_cost, AVG(latency_ms) as avg_latency
    FROM ai_usage_records
    WHERE tenant_id = ?
    GROUP BY feature
  `).all(tenantId);
}
