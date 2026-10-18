// בדיקות API: הצבעה אחת לקוד, מקביליות, חשאיות, הרשאות
import assert from "node:assert/strict";
import { createHandler } from "../lib/api.mjs";
import { createFileStore } from "../lib/file-store.mjs";
import { rmSync } from "node:fs";

const FILE = ".data/test-store.json";
rmSync(FILE, { force: true });
const h = createHandler(createFileStore(FILE), { adminPassword: "pw" });
const call = async (method, path, body, pw) => {
  const r = await h(new Request("http://x/api" + path, { method, headers: { "content-type": "application/json", ...(pw ? { "x-admin-password": pw } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  return { status: r.status, body: await r.json() };
};

assert.equal((await call("GET", "/admin/data")).status, 401, "ללא סיסמה נחסם");
assert.equal((await call("GET", "/admin/data", null, "bad")).status, 401);

const a = (await call("POST", "/admin/candidates", { name: "דנה" }, "pw")).body;
const b = (await call("POST", "/admin/candidates", { name: "יוסי" }, "pw")).body;
const { body: { created } } = await call("POST", "/admin/voters", { text: "אבי כהן, ז1\nרוני לוי, ז1\nמיכל, ח2" }, "pw");
assert.equal(created.length, 3);
assert.equal(new Set(created.map((c) => c.code)).size, 3, "קודים ייחודיים");

let r = await call("POST", "/vote", { code: created[0].code, candidateId: a.id });
assert.equal(r.status, 403, "הצבעה סגורה");
await call("PUT", "/admin/config", { open: true }, "pw");

assert.equal((await call("POST", "/login", { code: "ZZZZZZ" })).status, 404);
assert.equal((await call("POST", "/login", { code: created[0].code.toLowerCase() })).body.name, "אבי כהן", "קוד לא רגיש לאותיות");
assert.equal((await call("POST", "/vote", { code: created[0].code, candidateId: "nope" })).status, 400);

// 5 לחיצות מקבילות עם אותו קוד - רק אחת צריכה להיספר
const rs = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/vote", { code: created[0].code, candidateId: a.id })));
assert.equal(rs.filter((x) => x.status === 200).length, 1, "בדיוק קול אחד");
assert.equal((await call("POST", "/vote", { code: created[0].code, candidateId: b.id })).status, 409);
assert.equal((await call("POST", "/login", { code: created[0].code })).body.voted, true);

await call("POST", "/vote", { code: created[1].code, candidateId: b.id });
await call("POST", "/vote", { code: created[2].code, candidateId: b.id });

const d = (await call("GET", "/admin/data", null, "pw")).body;
assert.equal(d.totalVotes, 3);
assert.equal(d.candidates.find((c) => c.id === a.id).votes, 1);
assert.equal(d.candidates.find((c) => c.id === b.id).votes, 2);
assert.equal(d.voters.filter((v) => v.voted).length, 3);
assert.ok(!JSON.stringify(d).includes("candidateId"), "אין קישור בין תלמיד למועמד");

const pub = (await call("GET", "/state")).body;
assert.equal(pub.candidates.length, 2);
assert.ok(!("votes" in pub.candidates[0]), "תלמידים לא רואים ספירה");

await call("POST", "/admin/reset-votes", {}, "pw");
assert.equal((await call("GET", "/admin/data", null, "pw")).body.totalVotes, 0);
assert.equal((await call("POST", "/login", { code: created[0].code })).body.voted, false);
rmSync(FILE, { force: true });
console.log("✅ כל בדיקות ה-API עברו");
