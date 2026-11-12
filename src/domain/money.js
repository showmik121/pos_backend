import { DomainError } from './errors.js';
import { toAsciiDigits } from './digits.js';

// টাকার হিসাব ভেতরে সবসময় পয়সা (পূর্ণসংখ্যা) তে হয়: ৳২৪০.৫০ = ২৪০৫০।
// এতে দশমিকের ভুল (০.১ + ০.২) আসে না। ডাটাবেসে numeric(12,2) টাকা হিসেবে যায়।
export function takaToPoisha(value) {
  const s = toAsciiDigits(value).replace(/[,\s]/g, '');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) {
    throw new DomainError('invalid_amount', 'টাকার অঙ্ক সঠিক নয়');
  }
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function poishaToTaka(poisha) {
  if (!Number.isSafeInteger(poisha)) {
    throw new DomainError('invalid_amount', 'টাকার অঙ্ক সঠিক নয়');
  }
  const sign = poisha < 0 ? '-' : '';
  const abs = Math.abs(poisha);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// শতাংশ (যেমন "7.5") থেকে বেসিস পয়েন্ট (৭৫০) — শতাংশ ছাড়ের হিসাবে দশমিক এড়াতে।
export function percentToBp(percent) {
  const n = Number(toAsciiDigits(percent));
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new DomainError('invalid_percent', 'শতাংশ ০ থেকে ১০০ এর মধ্যে হতে হবে');
  }
  return Math.round(n * 100);
}
