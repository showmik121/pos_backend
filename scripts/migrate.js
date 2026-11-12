// db/migrations/*.sql ফাইলগুলো নামের ক্রমে একবার করে চালায়। কোনটা চলেছে তা schema_migrations এ থাকে।
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATE_DATABASE_URL বা DATABASE_URL সেট করুন');

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`চালাচ্ছি: ${f}`);
    await client.query(await readFile(path.join(dir, f), 'utf8')); // ফাইলের ভেতরে BEGIN/COMMIT আছে
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  }
  console.log('মাইগ্রেশন শেষ');
} finally {
  await client.end();
}
