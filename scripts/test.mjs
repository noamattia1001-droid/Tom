// בדיקות API: הצבעה אחת לשם, כפילויות, מקביליות, חשאיות, הרשאות
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
const vote = (name, candidateId) => call("POST", "/vote", { name, candidateId });

assert.equal((await call("GET", "/admin/data")).status, 401, "ללא סיסמה נחסם");
assert.equal((await call("GET", "/admin/voters", null, "bad")).status, 401);

const a = (await call("POST", "/admin/candidates", { name: "דנה כהן" }, "pw")).body;
const b = (await call("POST", "/admin/candidates", { name: "יוסי לוי" }, "pw")).body;
assert.equal((await call("POST", "/admin/candidates", { name: "  כהן   דנה " }, "pw")).status, 409, "מועמד כפול (גם בסדר הפוך)");
assert.equal((await call("PUT", `/admin/candidates/${b.id}`, { name: "דנה כהן" }, "pw")).status, 409, "שינוי שם לשם קיים");

assert.equal((await vote("אבי כהן", a.id)).status, 403, "הצבעה סגורה");
await call("PUT", "/admin/config", { open: true }, "pw");

assert.equal((await vote("אבי", a.id)).status, 400, "חובה שם פרטי ומשפחה");
assert.equal((await vote("אבי כהן", "nope")).status, 400);
assert.equal((await call("POST", "/check", { name: "אבי כהן" })).body.voted, false);

// 5 לחיצות מקבילות עם אותו שם - רק אחת נספרת
const rs = await Promise.all(Array.from({ length: 5 }, () => vote("אבי כהן", a.id)));
assert.equal(rs.filter((x) => x.status === 200).length, 1, "בדיוק קול אחד");
assert.equal((await call("POST", "/check", { name: "אבי כהן" })).body.voted, true);

// ניסיונות עקיפה: רווחים, סדר, אותיות לועזיות, גרשיים, ניקוד
for (const dup of ["  אבי   כהן ", "כהן אבי", "אבי-כהן", "אבי כהן!!", "אָבִי כֹּהֵן"]) {
  assert.equal((await vote(dup, b.id)).status, 409, `כפילות: "${dup}"`);
}
assert.equal((await vote("Avi Cohen", a.id)).status, 200);
assert.equal((await vote("AVI  cohen", a.id)).status, 409, "לא רגיש לאותיות גדולות");

assert.equal((await vote("רוני לוי", b.id)).status, 200);
assert.equal((await vote("מיכל אברהם", b.id)).status, 200);

const d = (await call("GET", "/admin/data", null, "pw")).body;
assert.equal(d.totalVotes, 4);
assert.equal(d.voted, 4);
assert.equal(d.candidates.find((c) => c.id === a.id).votes, 2);
assert.equal(d.candidates.find((c) => c.id === b.id).votes, 2);

const v = (await call("GET", "/admin/voters", null, "pw")).body.voters;
assert.equal(v.length, 4);
assert.ok(!JSON.stringify(v).includes(a.id) && !JSON.stringify(v).includes(b.id), "אין קישור בין שם למועמד");
assert.ok(v.some((x) => x.name === "אבי כהן"));

const pub = (await call("GET", "/state")).body;
assert.equal(pub.candidates.length, 2);
assert.ok(!("votes" in pub.candidates[0]), "תלמידים לא רואים ספירה");

// שחרור שם מאפשר הצבעה חוזרת
const avi = v.find((x) => x.name === "אבי כהן");
await call("DELETE", `/admin/voters/${avi.id}`, null, "pw");
assert.equal((await vote("אבי כהן", a.id)).status, 200, "אחרי שחרור אפשר להצביע");

await call("POST", "/admin/reset-votes", {}, "pw");
const after = (await call("GET", "/admin/data", null, "pw")).body;
assert.equal(after.totalVotes, 0);
assert.equal(after.voted, 0);
rmSync(FILE, { force: true });
console.log("✅ כל בדיקות ה-API עברו");
