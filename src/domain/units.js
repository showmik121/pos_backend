import { DomainError, requirePositiveInt } from './errors.js';

// স্টক সবসময় পিসে। কার্টনে বিক্রি/কেনা হলে pack_size দিয়ে পিসে বদলে নিতে হয়।
export function toBaseUnits({ qty, unit, packSize }) {
  requirePositiveInt(qty, 'পরিমাণ');
  if (unit === 'piece') return qty;
  if (unit === 'carton') {
    requirePositiveInt(packSize, 'কার্টনে পিসের সংখ্যা');
    if (packSize === 1) {
      throw new DomainError('no_carton', 'এই পণ্যের কার্টন সাইজ ঠিক করা নেই');
    }
    return qty * packSize;
  }
  throw new DomainError('invalid_unit', 'ইউনিট হবে piece অথবা carton');
}

// পিসের সংখ্যাকে "কার্টন + খুচরা" আকারে দেখানোর জন্য, যেমন ২৫ পিস, কার্টন ১০ → { cartons: 2, pieces: 5 }
export function splitCartons(totalPieces, packSize) {
  requirePositiveInt(packSize, 'কার্টনে পিসের সংখ্যা');
  if (!Number.isSafeInteger(totalPieces) || totalPieces < 0) {
    throw new DomainError('invalid_number', 'পিসের সংখ্যা সঠিক নয়');
  }
  return { cartons: Math.floor(totalPieces / packSize), pieces: totalPieces % packSize };
}
