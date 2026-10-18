// שרת פיתוח מקומי: מגיש את public/ ואת ה-API עם אחסון בקובץ. הרצה: npm run dev
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createHandler } from "../lib/api.mjs";
import { createFileStore } from "../lib/file-store.mjs";

const PORT = Number(process.env.PORT || 8888);
const ROOT = new URL("../public/", import.meta.url).pathname;
const handler = createHandler(createFileStore(process.env.STORE_FILE || ".data/store.json"), { adminPassword: process.env.ADMIN_PASSWORD });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await handler(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname;
  p = normalize(p).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT, () => console.log(`http://localhost:${PORT}  (מורים: /admin)`));
