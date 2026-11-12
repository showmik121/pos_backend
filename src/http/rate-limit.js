// লগইনে ভুল পাসওয়ার্ড বারবার দেওয়া ঠেকাতে: key (ফোন) প্রতি window এর মধ্যে সর্বোচ্চ max বার ব্যর্থ হতে পারে।
// মেমরিতে থাকে — একাধিক সার্ভার চালালে Redis/ডাটাবেসে সরাতে হবে (PRD এ নোট করা)।
export function createFailureLimiter({ max = 5, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const hits = new Map(); // key -> [timestamps]

  function recent(key) {
    const cutoff = now() - windowMs;
    const list = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    isBlocked: (key) => recent(key).length >= max,
    fail(key) {
      const list = recent(key);
      list.push(now());
      hits.set(key, list);
    },
    reset: (key) => hits.delete(key),
  };
}
