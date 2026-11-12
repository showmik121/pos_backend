import { createHmac, timingSafeEqual } from 'node:crypto';

// HS256 JWT — বাইরের লাইব্রেরি ছাড়া। অ্যালগরিদম সবসময় HS256 ধরা হয় (header এর alg বিশ্বাস করা হয় না)।
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const HEADER = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest();
}

export function assertSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('JWT_SECRET কমপক্ষে ৩২ অক্ষরের হতে হবে');
  }
}

export function signToken(claims, secret, { ttlSeconds = 43_200, now = Date.now() } = {}) {
  assertSecret(secret);
  const iat = Math.floor(now / 1000);
  const payload = b64u(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds }));
  const data = `${HEADER}.${payload}`;
  return `${data}.${b64u(sign(data, secret))}`;
}

// ঠিক থাকলে claims ফেরত দেয়, নইলে null।
export function verifyToken(token, secret, { now = Date.now() } = {}) {
  assertSecret(secret);
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(now / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
