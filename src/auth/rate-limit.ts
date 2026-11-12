// লগইনে ভুল পাসওয়ার্ড বারবার দেওয়া ঠেকাতে: key (ফোন) প্রতি window এর মধ্যে সর্বোচ্চ max বার ব্যর্থ হতে পারে।
// মেমরিতে থাকে — Edge Function এর প্রতিটি instance এর নিজস্ব; তাই এটি "সম্পূর্ণ" সুরক্ষা নয়, প্রাথমিক বাধা।
// পরে ডাটাবেস টেবিলে সরানো হবে (PRD এ নোট করা)।
export interface FailureLimiter {
  isBlocked(key: string): boolean
  fail(key: string): void
  reset(key: string): void
}

export function createFailureLimiter(
  opts: { max?: number; windowMs?: number; now?: () => number } = {},
): FailureLimiter {
  const { max = 5, windowMs = 15 * 60_000, now = () => Date.now() } = opts
  const hits = new Map<string, number[]>()

  function recent(key: string): number[] {
    const cutoff = now() - windowMs
    const list = (hits.get(key) ?? []).filter((t) => t > cutoff)
    if (list.length) hits.set(key, list)
    else hits.delete(key)
    return list
  }

  return {
    isBlocked: (key) => recent(key).length >= max,
    fail(key) {
      const list = recent(key)
      list.push(now())
      hits.set(key, list)
    },
    reset: (key) => void hits.delete(key),
  }
}
