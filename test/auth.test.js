import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { signToken, verifyToken } from '../src/auth/token.js';
import { createFailureLimiter } from '../src/http/rate-limit.js';

const SECRET = 'x'.repeat(40);

test('পাসওয়ার্ড হ্যাশ ও যাচাই', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.notEqual(h, await hashPassword('correct horse')); // আলাদা salt
  await assert.rejects(hashPassword('short'), (e) => e.code === 'weak_password');
});

test('টোকেন: সই, মেয়াদ, ছেঁড়াফাঁড়া', () => {
  const now = 1_800_000_000_000;
  const t = signToken({ sub: 'u1', sid: 's1', role: 'owner' }, SECRET, { ttlSeconds: 60, now });
  assert.equal(verifyToken(t, SECRET, { now: now + 30_000 }).sub, 'u1');
  assert.equal(verifyToken(t, SECRET, { now: now + 61_000 }), null); // মেয়াদ শেষ
  assert.equal(verifyToken(t, 'y'.repeat(40), { now }), null); // ভুল সিক্রেট

  const [h, p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'u1', sid: 'OTHER', role: 'owner', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken(`${h}.${forged}.${s}`, SECRET, { now }), null); // payload বদলানো
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(verifyToken(`${none}.${p}.`, SECRET, { now }), null); // alg=none আক্রমণ
  assert.equal(verifyToken('abc', SECRET), null);
  assert.throws(() => signToken({}, 'short'), /৩২/);
});

test('লগইন ব্যর্থতার সীমা', () => {
  let t = 0;
  const l = createFailureLimiter({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) l.fail('k');
  assert.equal(l.isBlocked('k'), true);
  assert.equal(l.isBlocked('other'), false);
  t = 1500;
  assert.equal(l.isBlocked('k'), false); // সময় পেরোলে খুলে যায়
  l.fail('k'); l.reset('k');
  assert.equal(l.isBlocked('k'), false);
});
