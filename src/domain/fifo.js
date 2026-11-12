import { DomainError, requirePositiveInt } from './errors.js';
import { classifyExpiry } from './expiry.js';

// FIFO/FEFO: যে ব্যাচের মেয়াদ আগে শেষ হবে সেটি আগে বিক্রি হয়। মেয়াদ-না-থাকা ব্যাচ সবার শেষে।
// মেয়াদোত্তীর্ণ ব্যাচ থেকে কখনো বিক্রি হয় না।
// batches: [{ id, expiryDate: 'YYYY-MM-DD' | null, qtyRemaining, receivedAt? }]
// ফেরত: [{ batchId, qty }] — মোট qty পিস
export function allocateFifo(batches, qtyNeeded, today) {
  requirePositiveInt(qtyNeeded, 'পরিমাণ');

  const usable = batches
    .filter((b) => b.qtyRemaining > 0 && classifyExpiry(b.expiryDate ?? null, today) !== 'expired')
    .slice()
    .sort((a, b) => {
      if (a.expiryDate && b.expiryDate && a.expiryDate !== b.expiryDate) {
        return a.expiryDate < b.expiryDate ? -1 : 1;
      }
      if (a.expiryDate && !b.expiryDate) return -1;
      if (!a.expiryDate && b.expiryDate) return 1;
      return String(a.receivedAt ?? '').localeCompare(String(b.receivedAt ?? ''));
    });

  const available = usable.reduce((s, b) => s + b.qtyRemaining, 0);
  if (available < qtyNeeded) {
    throw new DomainError('insufficient_stock', `স্টকে মাত্র ${available} পিস আছে`, { available, requested: qtyNeeded });
  }

  const out = [];
  let left = qtyNeeded;
  for (const b of usable) {
    if (left === 0) break;
    const take = Math.min(left, b.qtyRemaining);
    out.push({ batchId: b.id, qty: take });
    left -= take;
  }
  return out;
}
