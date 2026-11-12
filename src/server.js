import http from 'node:http';
import { createApp } from './http/app.js';
import { createPgRepo } from './repo/pg.js';

const { DATABASE_URL, JWT_SECRET, PORT = '3000', CORS_ORIGIN = '', TOKEN_TTL_SECONDS = '43200' } = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL সেট করা নেই');

const repo = createPgRepo({ connectionString: DATABASE_URL });
const app = createApp({
  repo,
  jwtSecret: JWT_SECRET,
  ttlSeconds: Number(TOKEN_TTL_SECONDS),
  corsOrigins: CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
});

const server = http.createServer(app);
server.listen(Number(PORT), () => console.log(`pos_backend চলছে: http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => repo.close().finally(() => process.exit(0)));
  });
}
