import { DomainError, requireNonNegativeInt, requirePositiveInt } from './errors.js';

const METHODS = ['cash', 'bkash', 'nagad', 'rocket', 'card', 'other'];

// সব হিসাব পয়সায় (পূর্ণসংখ্যা)।
// items: [{ unitPrice, qty }]  discount: { type: 'amount'|'percentBp', value }  (percentBp = শতাংশ × ১০০)
export function computeSale(items, discount = { type: 'amount', value: 0 }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DomainError('empty_cart', 'বিলে কমপক্ষে একটি পণ্য লাগবে');
  }
  let subtotal = 0;
  const lines = items.map((it) => {
    requireNonNegativeInt(it.unitPrice, 'দাম');
    requirePositiveInt(it.qty, 'পরিমাণ');
    const lineTotal = it.unitPrice * it.qty;
    subtotal += lineTotal;
    return { ...it, lineTotal };
  });

  let discountAmount;
  if (discount.type === 'amount') {
    discountAmount = requireNonNegativeInt(discount.value, 'ছাড়');
  } else if (discount.type === 'percentBp') {
    requireNonNegativeInt(discount.value, 'ছাড়ের শতাংশ');
    if (discount.value > 10_000) throw new DomainError('invalid_percent', 'ছাড় ১০০% এর বেশি হতে পারে না');
    discountAmount = Math.round((subtotal * discount.value) / 10_000);
  } else {
    throw new DomainError('invalid_discount', 'ছাড়ের ধরন সঠিক নয়');
  }
  if (discountAmount > subtotal) {
    throw new DomainError('discount_too_large', 'ছাড় বিলের মোটের চেয়ে বেশি হতে পারে না');
  }
  return { lines, subtotal, discount: discountAmount, total: subtotal - discountAmount };
}

// payments: [{ method, amount }]। কম দিলে বাকি (due) হবে — তখন কাস্টমার বাধ্যতামূলক।
// বেশি দিলে অতিরিক্তটা নগদ হতে হবে (ফেরত দেওয়া হবে); অনলাইন পেমেন্ট মোটের বেশি হতে পারে না।
export function settlePayments({ total, payments, hasCustomer }) {
  requireNonNegativeInt(total, 'মোট');
  let cash = 0;
  let other = 0;
  for (const p of payments ?? []) {
    if (!METHODS.includes(p.method)) throw new DomainError('invalid_method', 'পেমেন্টের মাধ্যম সঠিক নয়');
    requirePositiveInt(p.amount, 'পেমেন্টের পরিমাণ');
    if (p.method === 'cash') cash += p.amount;
    else other += p.amount;
  }
  if (other > total) {
    throw new DomainError('overpaid_digital', 'বিকাশ/কার্ড ইত্যাদির পরিমাণ মোটের বেশি হতে পারে না');
  }
  const received = cash + other;
  const change = Math.max(0, received - total);
  if (change > cash) {
    throw new DomainError('overpaid', 'ফেরত দেওয়ার মতো নগদ নেই');
  }
  const paid = received - change;
  const due = total - paid;
  if (due > 0 && !hasCustomer) {
    throw new DomainError('customer_required', 'বাকি রাখতে কাস্টমার বেছে নিন');
  }
  return { paid, due, change };
}
