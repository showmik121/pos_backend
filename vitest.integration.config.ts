import { defineConfig } from "vitest/config"

// আসল PostgreSQL লাগে: INTEGRATION_DATABASE_URL (pos_app রোলের URL) সেট করে চালান।
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
