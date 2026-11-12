import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DomainError } from '../domain/errors.js';

const scrypt = promisify(scryptCb);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new DomainError('weak_password', 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
  }
  if (password.length > 128) throw new DomainError('weak_password', 'পাসওয়ার্ড খুব বড়');
}

// ফরম্যাট: scrypt$N$r$p$saltB64$hashB64 — প্যারামিটার সংরক্ষিত থাকায় ভবিষ্যতে বাড়ানো যাবে।
export async function hashPassword(password) {
  validatePasswordStrength(password);
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ইউজার না পাওয়া গেলেও একই সময় খরচ করতে, যাতে সময় দেখে ফোন নম্বর আছে কিনা বোঝা না যায়।
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing');
