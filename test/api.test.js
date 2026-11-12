import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/http/app.js';
import { createMemoryRepo } from '../src/repo/memory.js';

const SECRET = 'k'.repeat(40);

async function start(opts = {}) {
  const app = createApp({ repo: createMemoryRepo(), jwtSecret: SECRET, corsOrigins: ['http://app.test'], ...opts });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token, headers } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  return { call, close: () => server.close() };
}

const owner = { storeName: 'রহমান ফার্মেসি', storeKind: 'pharmacy', ownerName: 'আব্দুর রহমান', phone: '০১৭১২৩৪৫৬৭৮', password: 'password123' };

test('দোকান খোলা → লগইন → /me', async () => {
  const { call, close } = await start();
  try {
    const reg = await call('POST', '/v1/auth/register-store', { body: owner });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.user.role, 'owner');
    assert.equal(reg.json.user.phone, '01712345678'); // বাংলা অঙ্ক স্বাভাবিক হয়েছে
    assert.equal(reg.json.user.passwordHash, undefined);

    const login = await call('POST', '/v1/auth/login', { body: { phone: '+8801712345678', password: 'password123' } });
    assert.equal(login.status, 200);

    const me = await call('GET', '/v1/me', { token: login.json.token });
    assert.equal(me.status, 200);
    assert.equal(me.json.store.name, 'রহমান ফার্মেসি');
    assert.equal(me.json.user.id, reg.json.user.id);
  } finally { close(); }
});

test('একই নম্বরে দ্বিতীয় দোকান নয়; ভুল ইনপুট ৪০০', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('POST', '/v1/auth/register-store', { body: owner })).status, 201);
    assert.equal((await call('POST', '/v1/auth/register-store', { body: owner })).json.error.code, 'phone_taken');
    const bad = await call('POST', '/v1/auth/register-store', { body: { ...owner, phone: '123', password: 'password123' } });
    assert.equal(bad.status, 400);
    assert.equal((await call('POST', '/v1/auth/register-store', { body: { ...owner, phone: '01811111111', password: 'short' } })).json.error.code, 'weak_password');
    assert.equal((await call('POST', '/v1/auth/register-store', { body: '{oops' })).json.error.code, 'invalid_json');
  } finally { close(); }
});

test('ভুল পাসওয়ার্ড একই বার্তা; ৫ বারের পর আটকে যায়', async () => {
  const { call, close } = await start();
  try {
    await call('POST', '/v1/auth/register-store', { body: owner });
    const wrong = await call('POST', '/v1/auth/login', { body: { phone: owner.phone, password: 'nope-nope' } });
    const unknown = await call('POST', '/v1/auth/login', { body: { phone: '01999999999', password: 'nope-nope' } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json.error.message, unknown.json.error.message); // নম্বর আছে কিনা বোঝা যায় না
    for (let i = 0; i < 4; i++) await call('POST', '/v1/auth/login', { body: { phone: owner.phone, password: 'nope-nope' } });
    const blocked = await call('POST', '/v1/auth/login', { body: { phone: owner.phone, password: 'password123' } });
    assert.equal(blocked.status, 429); // সঠিক পাসওয়ার্ড দিলেও এই মুহূর্তে আটকানো
  } finally { close(); }
});

test('অটেনটিকেশন ছাড়া ৪০১, ভুয়া টোকেনে ৪০১', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('GET', '/v1/me')).status, 401);
    assert.equal((await call('GET', '/v1/me', { token: 'a.b.c' })).status, 401);
    assert.equal((await call('GET', '/nope')).status, 404);
  } finally { close(); }
});

test('স্টাফ: মালিক বানায়, স্টাফ পারে না, বন্ধ করলে টোকেনও অচল, দোকান আলাদা', async () => {
  const { call, close } = await start();
  try {
    const o = (await call('POST', '/v1/auth/register-store', { body: owner })).json;
    const created = await call('POST', '/v1/staff', {
      token: o.token, body: { name: 'করিম', phone: '01811111111', password: 'staffpass1' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.user.role, 'staff');

    const s = (await call('POST', '/v1/auth/login', { body: { phone: '01811111111', password: 'staffpass1' } })).json;
    assert.equal(s.user.storeId, o.user.storeId);
    assert.equal((await call('GET', '/v1/staff', { token: s.token })).status, 403);
    assert.equal((await call('POST', '/v1/staff', { token: s.token, body: { name: 'x', phone: '01911111111', password: 'staffpass2' } })).status, 403);

    const list = await call('GET', '/v1/staff', { token: o.token });
    assert.equal(list.json.staff.length, 2);

    // অন্য দোকানের মালিক এই স্টাফকে দেখতে/বন্ধ করতে পারে না
    const other = (await call('POST', '/v1/auth/register-store', { body: { ...owner, phone: '01611111111', storeName: 'অন্য দোকান' } })).json;
    assert.equal((await call('GET', '/v1/staff', { token: other.token })).json.staff.length, 1);
    assert.equal((await call('PATCH', `/v1/staff/${created.json.user.id}`, { token: other.token, body: { active: false } })).status, 404);

    // নিজেকে বন্ধ করা যায় না
    assert.equal((await call('PATCH', `/v1/staff/${o.user.id}`, { token: o.token, body: { active: false } })).status, 400);

    // বন্ধ করলে পুরনো টোকেন ও লগইন দুটোই অচল
    assert.equal((await call('PATCH', `/v1/staff/${created.json.user.id}`, { token: o.token, body: { active: false } })).status, 200);
    assert.equal((await call('GET', '/v1/me', { token: s.token })).status, 401);
    assert.equal((await call('POST', '/v1/auth/login', { body: { phone: '01811111111', password: 'staffpass1' } })).status, 401);
  } finally { close(); }
});

test('CORS: শুধু অনুমোদিত origin', async () => {
  const { call, close } = await start();
  try {
    const ok = await call('OPTIONS', '/v1/me', { headers: { origin: 'http://app.test' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://app.test');
    const bad = await call('GET', '/health', { headers: { origin: 'http://evil.test' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  } finally { close(); }
});
