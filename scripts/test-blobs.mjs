// בדיקת אינטגרציה: המתאם האמיתי מול שרת Netlify Blobs מקומי (אותו API כמו בענן)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore } from "@netlify/blobs";
import { BlobsServer } from "@netlify/blobs/server";
import { createHandler } from "../lib/api.mjs";
import { createBlobsStore } from "../lib/netlify-store.mjs";

const dir = mkdtempSync(join(tmpdir(), "blobs-"));
const token = "t";
const server = new BlobsServer({ directory: dir, port: 8791, token });
await server.start();
const blobs = getStore({ name: "elections", consistency: "strong", edgeURL: "http://localhost:8791", uncachedEdgeURL: "http://localhost:8791", token, siteID: "test" });
const h = createHandler(createBlobsStore(blobs), { adminPassword: "pw" });
const call = async (method, path, body, pw) => {
  const r = await h(new Request("http://x/api" + path, { method, headers: { "content-type": "application/json", ...(pw ? { "x-admin-password": pw } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  return { status: r.status, body: await r.json() };
};

try {
  const store = createBlobsStore(blobs);
  assert.equal(await store.setIfNew("k", 1), true);
  assert.equal(await store.setIfNew("k", 2), false, "onlyIfNew אמיתי");
  assert.equal(await store.get("k"), 1);
  assert.equal(await store.get("missing"), null);
  await store.set("p/a", 1); await store.set("p/b", 1);
  assert.deepEqual((await store.list("p/")).sort(), ["p/a", "p/b"]);
  await store.delete("p/a");
  assert.deepEqual(await store.list("p/"), ["p/b"]);

  const a = (await call("POST", "/admin/candidates", { name: "דנה כהן" }, "pw")).body;
  const b = (await call("POST", "/admin/candidates", { name: "יוסי לוי" }, "pw")).body;
  await call("PUT", "/admin/config", { open: true }, "pw");
  let r = await call("POST", "/admin/students", { text: "אבי כהן, 100000074\nרוני לוי, 100000629\nמיכל, 100000777" }, "pw");
  assert.equal(r.body.added, 3);

  assert.equal((await call("POST", "/check", { id: "100000074" })).status, 200, "כניסה עם ת.ז. עובדת");
  assert.equal((await call("POST", "/check", { id: "100001221" })).status, 404);
  // אטומיות תחת עומס מקבילי נבדקת ב-test.mjs (אחסון מסודר). שרת ה-Blobs המקומי עצמו לא אטומי
  // (בודק ואז כותב), ולכן כאן בודקים רק את ההתנהגות הרציפה מול ה-API האמיתי של הספרייה.
  assert.equal((await call("POST", "/vote", { id: "100000074", candidateId: a.id })).status, 200);
  assert.equal((await call("POST", "/vote", { id: "100000074", candidateId: b.id })).status, 409, "הצבעה שנייה נדחית");
  assert.equal((await call("POST", "/vote", { id: "100000629", candidateId: b.id })).status, 200);
  assert.equal((await call("POST", "/vote", { id: "100000629", candidateId: b.id })).status, 409);

  const d = (await call("GET", "/admin/data", null, "pw")).body;
  assert.equal(d.registered, 3);
  assert.equal(d.voted, 2);
  assert.equal(d.totalVotes, 2);
  const st = (await call("GET", "/admin/students", null, "pw")).body.students;
  assert.equal(st.filter((x) => x.voted).length, 2);
  await call("POST", "/admin/reset-votes", {}, "pw");
  assert.equal((await call("GET", "/admin/data", null, "pw")).body.totalVotes, 0);
  // קובץ הכניסה האמיתי של Netlify, עם הקשר סביבה כמו בענן (NETLIFY_BLOBS_CONTEXT) מול אותו שרת
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: "http://localhost:8791", uncachedEdgeURL: "http://localhost:8791", token, siteID: "fn-test" })).toString("base64");
  process.env.ADMIN_PASSWORD = "fnpw";
  const fn = (await import("../netlify/functions/api.mjs")).default;
  const cfg = (await import("../netlify/functions/api.mjs")).config;
  assert.equal(cfg.path, "/api/*");
  const fcall = async (method, path, body, pw) => {
    const r = await fn(new Request("https://tom-school.netlify.app/api" + path, { method, headers: { "content-type": "application/json", ...(pw ? { "x-admin-password": pw } : {}), "x-nf-client-connection-ip": "9.9.9.9" }, body: body ? JSON.stringify(body) : undefined }));
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await fcall("GET", "/admin/data", null, "wrong")).status, 401, "סיסמה מ-ADMIN_PASSWORD");
  const c1 = (await fcall("POST", "/admin/candidates", { name: "מועמד א" }, "fnpw")).body;
  await fcall("PUT", "/admin/config", { open: true }, "fnpw");
  assert.equal((await fcall("POST", "/admin/students", { name: "תלמיד", idNumber: "100000074" }, "fnpw")).body.added, 1);
  assert.equal((await fcall("POST", "/check", { id: "100000074" })).status, 200, "כניסה עם ת.ז. דרך פונקציית Netlify");
  assert.equal((await fcall("POST", "/vote", { id: "100000074", candidateId: c1.id })).status, 200);
  assert.equal((await fcall("POST", "/vote", { id: "100000074", candidateId: c1.id })).status, 409);
  assert.equal((await fcall("GET", "/admin/data", null, "fnpw")).body.totalVotes, 1);
  console.log("✅ בדיקת Netlify Blobs עברה (כולל פונקציית Netlify האמיתית)");
} finally {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
