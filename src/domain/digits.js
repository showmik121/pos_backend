const BN = '০১২৩৪৫৬৭৮৯';

// বাংলা অঙ্ক (০–৯) কে ইংরেজি অঙ্কে বদলায়, যাতে ফোন/টাকা/তারিখ দুই ভাবেই লেখা যায়।
export function toAsciiDigits(input) {
  return String(input).replace(/[০-৯]/g, (d) => String(BN.indexOf(d)));
}

export function toBanglaDigits(input) {
  return String(input).replace(/[0-9]/g, (d) => BN[Number(d)]);
}
