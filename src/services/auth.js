import crypto from 'node:crypto';
import { db, hashPassword } from '../db/database.js';

// Simple signed session token generator without heavy dependencies
const JWT_SECRET = process.env.JWT_SECRET || 'photobooth_secure_secret_key_2026';

export function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = payload.exp || (Date.now() + 30 * 24 * 3600 * 1000);
  const data = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${signature}`;
}

export function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, data, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  if (expectedSig !== signature) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

export function loginUser(email, password) {
  const hashed = hashPassword(password);
  const user = db.prepare('SELECT id, email, full_name, role, status FROM users WHERE email = ? AND password_hash = ?').get(email, hashed);
  if (!user) {
    throw new Error('Email atau password salah');
  }
  if (user.status !== 'active') {
    throw new Error('Akun dinonaktifkan atau disuspend');
  }

  // Get tenant info if user is business admin or operator
  const membership = db.prepare('SELECT tenant_id, role as member_role, operator_pin FROM memberships WHERE user_id = ?').get(user.id);

  const token = createToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    tenantId: membership ? membership.tenant_id : null,
    operatorPin: membership ? membership.operator_pin : null
  });

  return {
    user,
    tenantId: membership ? membership.tenant_id : null,
    token
  };
}

export function authMiddleware(requiredRole = null) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.cookies && (req.cookies.pb_admin_auth || req.cookies.pb_token)) {
      token = req.cookies.pb_admin_auth || req.cookies.pb_token;
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Sesi admin belum terautentikasi. Silakan masukkan password admin terlebih dahulu.' });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Unauthorized: Sesi tidak valid atau telah kedaluwarsa. Silakan masukkan password admin kembali.' });
    }

    req.user = payload;

    if (requiredRole) {
      if (Array.isArray(requiredRole)) {
        if (!requiredRole.includes(payload.role) && payload.role !== 'super_admin') {
          return res.status(403).json({ error: 'Forbidden: Hak akses tidak memadai' });
        }
      } else if (payload.role !== requiredRole && payload.role !== 'super_admin') {
        return res.status(403).json({ error: 'Forbidden: Hak akses tidak memadai' });
      }
    }

    next();
  };
}
