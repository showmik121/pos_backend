// লোকাল Node সার্ভার: `npm run dev`। একই app, শুধু Node http থেকে Request/Response এ অনুবাদ করে।
import http from "node:http"
import { Readable } from "node:stream"
import { buildAppFromEnv } from "./config.js"

try {
  process.loadEnvFile() // .env থাকলে পড়ে (Node 20.12+)
} catch {
  /* .env নেই — পরিবেশ চলকই যথেষ্ট */
}

const port = Number(process.env.API_PORT ?? 3001)
const { app, repo } = buildAppFromEnv()

const server = http.createServer(async (nodeReq, nodeRes) => {
  const url = `http://${nodeReq.headers.host ?? "localhost"}${nodeReq.url ?? "/"}`
  const hasBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD"
  const headers = new Headers()
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
    else if (v !== undefined) headers.set(k, v)
  }
  const req = new Request(url, {
    method: nodeReq.method,
    headers,
    body: hasBody ? (Readable.toWeb(nodeReq) as ReadableStream) : undefined,
    // @ts-expect-error Node এর fetch এ স্ট্রিম বডির জন্য প্রয়োজন
    duplex: "half",
  })
  const res = await app.fetch(req)
  nodeRes.writeHead(res.status, Object.fromEntries(res.headers))
  nodeRes.end(Buffer.from(await res.arrayBuffer()))
})

server.listen(port, () => console.log(`pos_backend চলছে: http://localhost:${port}/api/health`))

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => repo.close().finally(() => process.exit(0)))
  })
}
