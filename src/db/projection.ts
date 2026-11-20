// সিংক ইভেন্ট-লগ → সার্ভারের টেবিল (পণ্য, ব্যাচ, কাস্টমার, বিল, খাতা)। pg-projection.ts বাস্তবায়ন।
export interface IncomingEvent {
  id: string
  kind: string
  /** ক্লায়েন্টের সময় (ISO) */
  at: string
  payload: Record<string, unknown>
}

export interface ProjectionSummary {
  /** টেবিলে বসেছে (বা পুরনো ঘড়ির কারণে আগের মানই থেকেছে) */
  applied: number
  /** নির্ভরতা (পণ্য/ব্যাচ/বিল/কাস্টমার) এখনো আসেনি; পরের দফায় আবার চেষ্টা */
  deferred: number
  /** যাচাইয়ে টেকেনি বা প্রজেক্ট হয় না (অচেনা ধরন, settings); লগে আছে */
  ignored: number
  /** আগেই প্রজেক্ট হয়েছিল */
  duplicate: number
  /** অপ্রত্যাশিত ডাটাবেস ত্রুটি; আর নিজে নিজে চেষ্টা হয় না (projection_events-এ কারণ) */
  failed: number
}

export interface ProjectionRepo {
  /**
   * নতুন ইভেন্ট + আগে অপেক্ষায় থাকা (deferred) ইভেন্ট চালায়। একই ইভেন্ট বারবার দিলে বা ক্রম বদলালে ফল একই।
   * দোকান-ভিত্তিক লক নেয়: একই দোকানে দুটি প্রজেকশন সমান্তরালে চলে না।
   */
  project(storeId: string, events: readonly IncomingEvent[]): Promise<ProjectionSummary>
}
