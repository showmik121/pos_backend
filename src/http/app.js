import { DomainError } from '../domain/errors.js';
import { normalizePhone } from '../domain/phone.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { signToken, verifyToken, assertSecret } from '../auth/token.js';
import { createFailureLimiter } from './rate-limit.js';

const STATUS = {
  invalid_credentials: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  phone_taken: 409,
  too_many_attempts: 429,
  payload_too_large: 413,
};
const statusFor = (code) => STATUS[code] ?? 400;

const MAX_BODY = 100 * 1024;
const STORE_KINDS = ['pharmacy', 'cosmetics', 'other'];

function cleanText(value, name, { max = 120, required = true } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) throw new DomainError('invalid_input', `${name} দিন`);
    return null;
  }
  if (s.length > max) throw new DomainError('invalid_input', `${name} খুব বড়`);
  return s;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new DomainError('payload_too_large', 'অনুরোধ খুব বড়');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new DomainError('invalid_json', 'JSON সঠিক নয়');
  }
}

export function createApp({
  repo,
  jwtSecret,
  ttlSeconds = 43_200,
  corsOrigins = [],
  now = () => Date.now(),
  limiter = createFailureLimiter({ now }),
}) {
  assertSecret(jwtSecret);

  const tokenFor = (user) =>
    signToken({ sub: user.id, sid: user.storeId, role: user.role }, jwtSecret, { ttlSeconds, now: now() });

  async function authenticate(req) {
    const header = req.headers.authorization ?? '';
    const claims = header.startsWith('Bearer ') ? verifyToken(header.slice(7), jwtSecret, { now: now() }) : null;
    if (!claims) throw new DomainError('unauthorized', 'আবার লগইন করুন');
    // টোকেন বৈধ থাকলেও ইউজার নিষ্ক্রিয় করা হয়ে থাকতে পারে — তাই প্রতিবার যাচাই
    const user = await repo.getUser(claims.sid, claims.sub);
    if (!user || !user.active) throw new DomainError('unauthorized', 'আবার লগইন করুন');
    return user;
  }

  function requireOwner(user) {
    if (user.role !== 'owner') throw new DomainError('forbidden', 'এটি শুধু মালিক করতে পারবেন');
  }

  const routes = {
    'GET /health': async () => ({ status: 200, body: { ok: true } }),

    // A1: দোকান খোলা + মালিকের অ্যাকাউন্ট
    'POST /v1/auth/register-store': async (req) => {
      const b = await readJson(req);
      const storeName = cleanText(b.storeName, 'দোকানের নাম', { max: 120 });
      const ownerName = cleanText(b.ownerName, 'আপনার নাম', { max: 120 });
      const storeKind = b.storeKind ?? 'pharmacy';
      if (!STORE_KINDS.includes(storeKind)) throw new DomainError('invalid_input', 'দোকানের ধরন সঠিক নয়');
      const phone = normalizePhone(b.phone);
      const passwordHash = await hashPassword(b.password);
      const { storeId, userId } = await repo.registerStore({ storeName, storeKind, ownerName, phone, passwordHash });
      const user = { id: userId, storeId, name: ownerName, phone, role: 'owner', active: true };
      return { status: 201, body: { token: tokenFor(user), user } };
    },

    'POST /v1/auth/login': async (req) => {
      const b = await readJson(req);
      const phone = normalizePhone(b.phone);
      if (limiter.isBlocked(phone)) {
        throw new DomainError('too_many_attempts', 'অনেকবার ভুল হয়েছে, কিছুক্ষণ পরে চেষ্টা করুন');
      }
      const found = await repo.findUserByPhone(phone);
      const ok = await verifyPassword(String(b.password ?? ''), found?.passwordHash ?? DUMMY_HASH);
      if (!found || !found.active || !ok) {
        limiter.fail(phone);
        throw new DomainError('invalid_credentials', 'ফোন নম্বর বা পাসওয়ার্ড ঠিক নয়');
      }
      limiter.reset(phone);
      const { passwordHash: _omit, ...user } = found;
      return { status: 200, body: { token: tokenFor(user), user } };
    },

    'GET /v1/me': async (req) => {
      const user = await authenticate(req);
      const store = await repo.getStore(user.storeId);
      return { status: 200, body: { user, store } };
    },

    // A2: স্টাফ ব্যবস্থাপনা (শুধু মালিক)
    'GET /v1/staff': async (req) => {
      const user = await authenticate(req);
      requireOwner(user);
      return { status: 200, body: { staff: await repo.listStaff(user.storeId) } };
    },

    'POST /v1/staff': async (req) => {
      const owner = await authenticate(req);
      requireOwner(owner);
      const b = await readJson(req);
      const staff = await repo.createStaff(owner.storeId, {
        name: cleanText(b.name, 'স্টাফের নাম'),
        phone: normalizePhone(b.phone),
        passwordHash: await hashPassword(b.password),
      });
      return { status: 201, body: { user: staff } };
    },
  };

  // PATCH /v1/staff/:id  { active: boolean }
  async function patchStaff(req, id) {
    const owner = await authenticate(req);
    requireOwner(owner);
    const b = await readJson(req);
    if (typeof b.active !== 'boolean') throw new DomainError('invalid_input', 'active true/false হতে হবে');
    if (id === owner.id) throw new DomainError('invalid_input', 'নিজের অ্যাকাউন্ট বন্ধ করা যায় না');
    const updated = await repo.setUserActive(owner.storeId, id, b.active);
    if (!updated) throw new DomainError('not_found', 'স্টাফ পাওয়া যায়নি');
    return { status: 200, body: { user: updated } };
  }

  function setCors(req, res) {
    const origin = req.headers.origin;
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
  }

  return async function handler(req, res) {
    const send = (status, body) => {
      const data = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    };

    setCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
      const route = routes[`${req.method} ${path}`];
      let result;
      if (route) {
        result = await route(req);
      } else {
        const m = /^\/v1\/staff\/([0-9a-f-]{36})$/.exec(path);
        if (m && req.method === 'PATCH') result = await patchStaff(req, m[1]);
        else throw new DomainError('not_found', 'পাওয়া যায়নি');
      }
      send(result.status, result.body);
    } catch (err) {
      if (err instanceof DomainError) {
        send(statusFor(err.code), { error: { code: err.code, message: err.message, details: err.details } });
      } else {
        console.error(err);
        send(500, { error: { code: 'internal', message: 'সার্ভারে সমস্যা হয়েছে, আবার চেষ্টা করুন' } });
      }
    }
  };
}
