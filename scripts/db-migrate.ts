// db/migrations/*.sql ফাইলগুলো নামের ক্রমে একবার করে চালায়। কোনটা চলেছে তা schema_migrations এ থাকে।
// অবশ্যই DATABASE_URL_UNPOOLED (Session pooler, পোর্ট 5432) বা Direct connection দিয়ে চালান — `postgres` রোল দিয়ে।
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

try {
  process.loadEnvFile()
} catch {
  /* .env নেই */
}

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.MIGRATE_DATABASE_URL
if (!url) {
  console.error("DATABASE_URL_UNPOOLED সেট করুন (.env ফাইলে, Session pooler এর স্ট্রিং)")
  process.exit(1)
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations")
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r: { name: string }) => r.name))

  // pos_app এর পাসওয়ার্ড migration ফাইলে রাখা হয় না; এখানে env থেকে বসানো হয়।
  const appPassword = process.env.POS_APP_PASSWORD

  for (const f of files) {
    if (done.has(f)) continue
    console.log(`চালাচ্ছি: ${f}`)
    await sql.unsafe(await readFile(path.join(dir, f), "utf8")) // ফাইলের ভেতরে BEGIN/COMMIT আছে
    await sql`INSERT INTO schema_migrations (name) VALUES (${f})`
  }

  if (appPassword) {
    if (appPassword.length < 16) throw new Error("POS_APP_PASSWORD কমপক্ষে ১৬ অক্ষরের হতে হবে")
    // ALTER ROLE ... PASSWORD এ প্যারামিটার চলে না; literal হিসেবে নিরাপদে কোট করা হলো
    const quoted = "'" + appPassword.replace(/'/g, "''") + "'"
    await sql.unsafe(`ALTER ROLE pos_app WITH LOGIN PASSWORD ${quoted}`)
    console.log("pos_app এর পাসওয়ার্ড বসানো হয়েছে")
  } else {
    console.log("সতর্কতা: POS_APP_PASSWORD সেট নেই — pos_app দিয়ে লগইন করতে পাসওয়ার্ড বসাতে হবে")
  }
  console.log("মাইগ্রেশন শেষ")
} finally {
  await sql.end({ timeout: 5 })
}
