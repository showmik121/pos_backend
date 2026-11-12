import { DomainError } from './errors.js';
import { toAsciiDigits } from './digits.js';

// বাংলাদেশের মোবাইল নম্বরকে 01XXXXXXXXX আকারে আনে। +880 / 880 / বাংলা অঙ্ক / স্পেস-হাইফেন সব মেনে নেয়।
export function normalizePhone(input) {
  let s = toAsciiDigits(String(input ?? '')).replace(/[\s-]/g, '');
  if (s.startsWith('+880')) s = '0' + s.slice(4);
  else if (s.startsWith('880') && s.length === 13) s = '0' + s.slice(3);
  if (!/^01[3-9]\d{8}$/.test(s)) {
    throw new DomainError('invalid_phone', 'মোবাইল নম্বর সঠিক নয় (যেমন 01712345678)');
  }
  return s;
}
