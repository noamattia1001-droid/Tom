// בדיקות API: כניסה עם תעודת זהות, כפילויות, מקביליות, חשאיות, הרשאות
import assert from "node:assert/strict";
import { createHandler, normalizeId, validIdChecksum } from "../lib/api.mjs";
import { createFileStore } from "../lib/file-store.mjs";
import { rmSync, readFileSync } from "node:fs";

const FILE = ".data/test-store.json";
rmSync(FILE, { force: true });
const make = (file, opts) => {
  const h = createHandler(createFileStore(file), { adminPassword: "pw", ...opts });
  return async (method, path, body, pw, ip) => {
    const r = await h(new Request("http://x/api" + path, { method, headers: { "content-type": "application/json", ...(pw ? { "x-admin-password": pw } : {}), ...(ip ? { "x-nf-client-connection-ip": ip } : {}) }, body: body ? JSON.stringify(body) : undefined }));
    return { status: r.status, body: await r.json() };
  };
};
const call = make(FILE);
const vote = (id, candidateId) => call("POST", "/vote", { id, candidateId });

// בדיקות עזר
assert.equal(normalizeId("12345"), "000012345");
assert.equal(normalizeId("100-000-074"), "100000074");
assert.equal(normalizeId("12"), null);
assert.equal(normalizeId("abc123456"), null);
assert.ok(validIdChecksum("100000074"));
assert.ok(!validIdChecksum("100000075"));

assert.equal((await call("GET", "/admin/data")).status, 401, "ללא סיסמה נחסם");
assert.equal((await call("GET", "/admin/students", null, "bad")).status, 401);

const a = (await call("POST", "/admin/candidates", { name: "דנה כהן" }, "pw")).body;
const b = (await call("POST", "/admin/candidates", { name: "יוסי לוי" }, "pw")).body;
assert.equal((await call("POST", "/admin/candidates", { name: "  כהן   דנה " }, "pw")).status, 409, "מועמד כפול");

// הוספת תלמידים: בודד, רשימה (שני סדרי עמודות), כפילות, טעויות
let r = await call("POST", "/admin/students", { name: "אבי כהן", idNumber: "100000074" }, "pw");
assert.equal(r.body.added, 1);
r = await call("POST", "/admin/students", { text: "רוני לוי, 100000629\n100000777, מיכל אברהם\nשרית, 100000075\nבלי תעודה\n12" }, "pw");
assert.equal(r.body.added, 2, "שני תקינים נוספו");
assert.equal(r.body.invalid.length, 3, "ספרת ביקורת, חסר מספר, קצר מדי");
r = await call("POST", "/admin/students", { text: "אבי כהן שוב, 100-000-074" }, "pw");
assert.equal(r.body.added, 0);
assert.equal(r.body.duplicates.length, 1, "כפילות ת.ז. נתפסה גם עם מקפים");

assert.equal((await vote("100000074", a.id)).status, 403, "הצבעה סגורה");
await call("PUT", "/admin/config", { open: true }, "pw");

// כניסה: לא ברשימה / לא תקין / תקין. אף תשובה לא חושפת שם.
r = await call("POST", "/check", { id: "100001221" });
assert.equal(r.status, 404, "לא ברשימה");
assert.equal((await call("POST", "/check", { id: "abc" })).status, 400);
r = await call("POST", "/check", { id: "100000074" });
assert.equal(r.status, 200);
assert.equal(r.body.voted, false);
assert.ok(!JSON.stringify(r.body).includes("אבי"), "לא חושפים שם");
assert.equal((await call("POST", "/check", { id: "100-000-074" })).status, 200, "מקפים מותרים");
assert.equal((await vote("100001221", a.id)).status, 404, "לא ברשימה לא יכול להצביע");
assert.equal((await vote("100000074", "nope")).status, 400);

// 5 לחיצות מקבילות עם אותה ת.ז. - רק אחת נספרת
const rs = await Promise.all(Array.from({ length: 5 }, () => vote("100000074", a.id)));
assert.equal(rs.filter((x) => x.status === 200).length, 1, "בדיוק קול אחד");
assert.equal((await vote("100-000-074", b.id)).status, 409, "גם בכתיבה אחרת של אותו מספר");
assert.equal((await call("POST", "/check", { id: "100000074" })).body.voted, true);
assert.equal((await vote("74", b.id)).status, 400, "קצר מדי");

assert.equal((await vote("100000629", b.id)).status, 200);
assert.equal((await vote("100000777", b.id)).status, 200);

let d = (await call("GET", "/admin/data", null, "pw")).body;
assert.equal(d.registered, 3);
assert.equal(d.voted, 3);
assert.equal(d.totalVotes, 3);
assert.equal(d.candidates.find((c) => c.id === a.id).votes, 1);
assert.equal(d.candidates.find((c) => c.id === b.id).votes, 2);

const st = (await call("GET", "/admin/students", null, "pw")).body.students;
assert.equal(st.length, 3);
assert.ok(st.every((x) => x.voted));
const dump = JSON.stringify(st);
assert.ok(!dump.includes(a.id) && !dump.includes(b.id), "אין קישור בין תלמיד למועמד");
for (const id of ["100000074", "100000629", "100000777"]) assert.ok(!dump.includes(id) && !dump.includes(id.slice(-6)), "בדשבורד רק 3 ספרות אחרונות");
assert.equal(st.find((x) => x.name === "אבי כהן").last3, "074");

// התעודות לא נשמרות במפורש במאגר
const raw = readFileSync(FILE, "utf8");
for (const id of ["100000074", "100000629", "100000777"]) assert.ok(!raw.includes(id), "ת.ז. לא נשמרת בגלוי: " + id);

const pub = (await call("GET", "/state")).body;
assert.ok(!("votes" in pub.candidates[0]), "תלמידים לא רואים ספירה");

// הסרת תלמיד שהצביע ושוב הוספה - לא יכול להצביע פעמיים
const avi = st.find((x) => x.name === "אבי כהן");
await call("DELETE", `/admin/students/${avi.id}`, null, "pw");
assert.equal((await vote("100000074", a.id)).status, 404, "אחרי הסרה לא יכול להצביע");
await call("POST", "/admin/students", { name: "אבי כהן", idNumber: "100000074" }, "pw");
assert.equal((await vote("100000074", a.id)).status, 409, "הוסף מחדש - עדיין נחשב שהצביע");

// הוספת תלמיד חדש אחרי שהתחילה ההצבעה
await call("POST", "/admin/students", { name: "תלמיד חדש", idNumber: "100001221" }, "pw");
assert.equal((await vote("100001221", b.id)).status, 200);

// איפוס
await call("POST", "/admin/reset-votes", {}, "pw");
d = (await call("GET", "/admin/data", null, "pw")).body;
assert.equal(d.totalVotes, 0);
assert.equal(d.voted, 0);
assert.equal(d.registered, 4, "הרשימה נשארת");
assert.equal((await vote("100000074", a.id)).status, 200, "אחרי איפוס אפשר להצביע שוב");

// הגבלת ניחושים: 5 כשלונות ל-IP ואז חסימה (גם לתעודה תקינה). IP אחר לא מושפע.
const lim = make(".data/test-limit.json", { maxFails: 5 });
await lim("POST", "/admin/students", { name: "בדיקה", idNumber: "100000074" }, "pw");
for (let i = 0; i < 5; i++) assert.equal((await lim("POST", "/check", { id: "100001221" }, null, "1.2.3.4")).status, 404);
assert.equal((await lim("POST", "/check", { id: "100000074" }, null, "1.2.3.4")).status, 429, "נחסם אחרי 5 כשלונות");
assert.equal((await lim("POST", "/check", { id: "100000074" }, null, "5.6.7.8")).status, 200, "IP אחר לא חסום");

rmSync(FILE, { force: true });
rmSync(".data/test-limit.json", { force: true });
console.log("✅ כל בדיקות ה-API עברו");
