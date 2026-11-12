import test from 'node:test';
import assert from 'node:assert/strict';
import { takaToPoisha, poishaToTaka, percentToBp } from '../src/domain/money.js';
import { toBaseUnits, splitCartons } from '../src/domain/units.js';
import { classifyExpiry, daysUntil } from '../src/domain/expiry.js';
import { allocateFifo } from '../src/domain/fifo.js';
import { computeSale, settlePayments } from '../src/domain/sale.js';
import { normalizePhone } from '../src/domain/phone.js';
import { DomainError } from '../src/domain/errors.js';

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof DomainError && e.code === code, `expected ${code}`);

test('টাকা ↔ পয়সা, বাংলা অঙ্কসহ', () => {
  assert.equal(takaToPoisha('240.50'), 24050);
  assert.equal(takaToPoisha('২৪০'), 24000);
  assert.equal(takaToPoisha('১,২৫০.৫'), 125050);
  assert.equal(poishaToTaka(24050), '240.50');
  assert.equal(poishaToTaka(5), '0.05');
  throwsCode(() => takaToPoisha('12.345'), 'invalid_amount');
  throwsCode(() => takaToPoisha('abc'), 'invalid_amount');
  assert.equal(percentToBp('7.5'), 750);
  throwsCode(() => percentToBp('120'), 'invalid_percent');
});

test('কার্টন → পিস', () => {
  assert.equal(toBaseUnits({ qty: 3, unit: 'carton', packSize: 10 }), 30);
  assert.equal(toBaseUnits({ qty: 4, unit: 'piece', packSize: 10 }), 4);
  throwsCode(() => toBaseUnits({ qty: 1, unit: 'carton', packSize: 1 }), 'no_carton');
  throwsCode(() => toBaseUnits({ qty: 0, unit: 'piece', packSize: 1 }), 'invalid_number');
  throwsCode(() => toBaseUnits({ qty: 1, unit: 'box', packSize: 1 }), 'invalid_unit');
  assert.deepEqual(splitCartons(25, 10), { cartons: 2, pieces: 5 });
});

test('মেয়াদের শ্রেণি', () => {
  const today = '2026-11-12';
  assert.equal(daysUntil('2026-11-22', today), 10);
  assert.equal(classifyExpiry(null, today), 'none');
  assert.equal(classifyExpiry('2026-11-11', today), 'expired');
  assert.equal(classifyExpiry('2026-11-12', today), 'expired'); // আজকের তারিখে শেষ = বিক্রি নয়
  assert.equal(classifyExpiry('2026-12-12', today), 'critical'); // ৩০ দিন
  assert.equal(classifyExpiry('2027-01-10', today), 'soon'); // ৫৯ দিন
  assert.equal(classifyExpiry('2027-06-01', today), 'ok');
  throwsCode(() => classifyExpiry('2026-02-30', today), 'invalid_date');
});

test('FIFO: আগে মেয়াদ শেষ হওয়া ব্যাচ আগে, মেয়াদোত্তীর্ণ বাদ', () => {
  const today = '2026-11-12';
  const batches = [
    { id: 'late', expiryDate: '2027-09-01', qtyRemaining: 10 },
    { id: 'none', expiryDate: null, qtyRemaining: 10 },
    { id: 'soon', expiryDate: '2027-01-15', qtyRemaining: 4 },
    { id: 'dead', expiryDate: '2026-10-01', qtyRemaining: 50 },
    { id: 'empty', expiryDate: '2026-12-01', qtyRemaining: 0 },
  ];
  assert.deepEqual(allocateFifo(batches, 6, today), [
    { batchId: 'soon', qty: 4 },
    { batchId: 'late', qty: 2 },
  ]);
  assert.deepEqual(allocateFifo(batches, 24, today).map((a) => a.batchId), ['soon', 'late', 'none']);
  try {
    allocateFifo(batches, 25, today);
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, 'insufficient_stock');
    assert.equal(e.details.available, 24); // মেয়াদোত্তীর্ণ ৫০ গোনা হয়নি
  }
});

test('বিলের হিসাব: নমুনা বিল #১০৪৩ = ৪৫৫ − ২৫ = ৪৩০', () => {
  const s = computeSale(
    [{ unitPrice: 15000, qty: 2 }, { unitPrice: 8500, qty: 1 }, { unitPrice: 2000, qty: 3 }, { unitPrice: 1000, qty: 1 }],
    { type: 'amount', value: 2500 },
  );
  assert.equal(s.subtotal, 45500);
  assert.equal(s.discount, 2500);
  assert.equal(s.total, 43000);
});

test('শতাংশ ছাড় ও সীমা', () => {
  const s = computeSale([{ unitPrice: 10050, qty: 1 }], { type: 'percentBp', value: 1000 });
  assert.equal(s.discount, 1005);
  assert.equal(s.total, 9045);
  throwsCode(() => computeSale([{ unitPrice: 100, qty: 1 }], { type: 'amount', value: 101 }), 'discount_too_large');
  throwsCode(() => computeSale([], undefined), 'empty_cart');
});

test('পেমেন্ট ভাগ: ২৫০ নগদ + ১০০ বিকাশ + ৮০ বাকি', () => {
  const r = settlePayments({
    total: 43000,
    payments: [{ method: 'cash', amount: 25000 }, { method: 'bkash', amount: 10000 }],
    hasCustomer: true,
  });
  assert.deepEqual(r, { paid: 35000, due: 8000, change: 0 });
  throwsCode(
    () => settlePayments({ total: 43000, payments: [{ method: 'cash', amount: 1000 }], hasCustomer: false }),
    'customer_required',
  );
});

test('বেশি নগদ দিলে ফেরত; বেশি বিকাশ নয়', () => {
  assert.deepEqual(
    settlePayments({ total: 43000, payments: [{ method: 'cash', amount: 50000 }], hasCustomer: false }),
    { paid: 43000, due: 0, change: 7000 },
  );
  throwsCode(
    () => settlePayments({ total: 43000, payments: [{ method: 'bkash', amount: 50000 }], hasCustomer: false }),
    'overpaid_digital',
  );
  throwsCode(
    () => settlePayments({ total: 43000, payments: [{ method: 'nope', amount: 1 }], hasCustomer: true }),
    'invalid_method',
  );
});

test('মোবাইল নম্বর স্বাভাবিকীকরণ', () => {
  assert.equal(normalizePhone('01712345678'), '01712345678');
  assert.equal(normalizePhone('+8801712345678'), '01712345678');
  assert.equal(normalizePhone('৮৮০১৭১২-৩৪৫৬৭৮'), '01712345678');
  assert.equal(normalizePhone('০১৭১২ ৩৪৫৬৭৮'), '01712345678');
  throwsCode(() => normalizePhone('01212345678'), 'invalid_phone');
  throwsCode(() => normalizePhone('1712345678'), 'invalid_phone');
});
