// ליבת ה-API. עצמאית מהאחסון: מקבלת "store" ומחזירה handler בתקן Web (Request -> Response).
// store: get(key) / set(key,val) / setIfNew(key,val) / delete(key) / list(prefix)

const MAX_PHOTO_CHARS = 400_000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const err = (message, status = 400) => json({ error: message }, status);

const randomId = (n = 10) => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => "abcdefghjkmnpqrstuvwxyz23456789"[x % 31]).join("");
};

// שמות מועמדים: בלי ניקוד/סימנים/רווחים כפולים, לא רגיש לאותיות, והסדר לא משנה
const nameKey = (s) =>
  String(s || "").normalize("NFKC").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(Boolean).sort().join(" ");

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// תעודת זהות: 5-9 ספרות, מרופדת באפסים ל-9. ספרת ביקורת לפי האלגוריתם הרשמי.
export function normalizeId(raw) {
  const digits = String(raw ?? "").replace(/[\s-]/g, "");
  if (!/^\d{5,9}$/.test(digits)) return null;
  return digits.padStart(9, "0");
}
export function validIdChecksum(id9) {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id9[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export function createHandler(store, { adminPassword, maxFails = 40 } = {}) {
  const password = adminPassword || "admin123";
  const usingDefaultPassword = !adminPassword;

  const getConfig = async () => ({ title: "בחירות תום כפר נוער", open: false, ...(await store.get("config")) });
  const getCandidates = async () => (await store.get("candidates")) || [];
  const getRoster = async () => (await store.get("roster")) || {};

  // תעודות הזהות לא נשמרות במפורש: רק HMAC עם מפתח אקראי + 3 ספרות אחרונות לתצוגה בדשבורד
  let secret = null;
  async function getSecret() {
    if (secret) return secret;
    let s = await store.get("secret");
    if (!s) {
      await store.setIfNew("secret", hex(crypto.getRandomValues(new Uint8Array(32)).buffer));
      s = await store.get("secret");
    }
    return (secret = s);
  }
  async function idHash(id9) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(await getSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id9))).slice(0, 32);
  }

  async function counts() {
    const out = {};
    for (const k of await store.list("ballot/")) {
      const id = k.split("/")[1];
      out[id] = (out[id] || 0) + 1;
    }
    return out;
  }
  const usedSet = async () => new Set((await store.list("used/")).map((k) => k.split("/")[1]));

  // הגנה בסיסית מניחושי תעודות זהות: מספר מוגבל של כשלונות ל-IP בחלון זמן
  const failKey = (ip) => `rl/${ip}/${Math.floor(Date.now() / FAIL_WINDOW_MS)}`;
  const isBlocked = async (ip) => ((await store.get(failKey(ip))) || 0) >= maxFails;
  const noteFail = async (ip) => store.set(failKey(ip), ((await store.get(failKey(ip))) || 0) + 1);

  // מפרש שורות "שם, ת.ז." (או "ת.ז., שם"). מחזיר רשומות תקינות ושורות שנדחו.
  function parseStudents(text) {
    const ok = [], bad = [];
    for (const line of String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const parts = line.split(/[,\t;]/).map((s) => s.trim()).filter(Boolean);
      const idTok = parts.find((p) => /^[\d\s-]{5,}$/.test(p));
      const name = parts.filter((p) => p !== idTok).join(" ").replace(/\s+/g, " ").slice(0, 60);
      const id9 = normalizeId(idTok);
      if (!name || !id9) { bad.push({ line, reason: !name ? "חסר שם" : "תעודת זהות לא תקינה" }); continue; }
      if (!validIdChecksum(id9)) { bad.push({ line, reason: "ספרת ביקורת שגויה (טעות הקלדה?)" }); continue; }
      ok.push({ name, id9 });
    }
    return { ok, bad };
  }

  return async function handler(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, "") || "/";
    const method = req.method;
    const ip = (req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "local")
      .split(",")[0].trim().replace(/[^a-zA-Z0-9.:]/g, "_");
    let body = {};
    if (method !== "GET" && method !== "DELETE") {
      try { body = await req.json(); } catch { body = {}; }
    }

    try {
      // ---------- ציבורי: אתר התלמידים ----------
      if (method === "GET" && path === "/state") {
        const [config, candidates] = await Promise.all([getConfig(), getCandidates()]);
        return json({ title: config.title, open: config.open, candidates });
      }

      // בדיקה מוקדמת של תעודת הזהות (לפני בחירת מועמד). לא חושפת שם של אף תלמיד.
      if (method === "POST" && path === "/check") {
        if (await isBlocked(ip)) return err("יותר מדי ניסיונות שגויים. נסו שוב בעוד כמה דקות.", 429);
        const id9 = normalizeId(body.id);
        if (!id9) return err("נא להקליד תעודת זהות (עד 9 ספרות).");
        const h = await idHash(id9);
        const roster = await getRoster();
        if (!roster[h]) {
          await noteFail(ip);
          return err("תעודת הזהות לא נמצאת ברשימת המצביעים. פנו למורה.", 404);
        }
        return json({ ok: true, voted: (await store.get(`used/${h}`)) !== null });
      }

      if (method === "POST" && path === "/vote") {
        if (await isBlocked(ip)) return err("יותר מדי ניסיונות שגויים. נסו שוב בעוד כמה דקות.", 429);
        const id9 = normalizeId(body.id);
        if (!id9) return err("נא להקליד תעודת זהות (עד 9 ספרות).");
        const [config, candidates, roster] = await Promise.all([getConfig(), getCandidates(), getRoster()]);
        if (!config.open) return err("ההצבעה סגורה כרגע.", 403);
        const h = await idHash(id9);
        if (!roster[h]) { await noteFail(ip); return err("תעודת הזהות לא נמצאת ברשימת המצביעים.", 404); }
        if (!candidates.some((c) => c.id === body.candidateId)) return err("מועמד לא קיים.", 400);
        // כתיבה אטומית - רק הראשונה מצליחה, אי אפשר להצביע פעמיים גם בלחיצות מקבילות
        const first = await store.setIfNew(`used/${h}`, { at: Date.now() });
        if (!first) return err("כבר הצבעת. אפשר להצביע רק פעם אחת.", 409);
        try {
          // פתק ההצבעה נפרד מהזהות - המורים לא יכולים לדעת מי הצביע למי
          await store.set(`ballot/${body.candidateId}/${randomId()}`, 1);
        } catch (e) {
          await store.delete(`used/${h}`);
          throw e;
        }
        return json({ ok: true });
      }

      // ---------- מנהל ----------
      if (path.startsWith("/admin")) {
        if (req.headers.get("x-admin-password") !== password) return err("סיסמה שגויה", 401);
        const sub = path.slice("/admin".length) || "/";

        if (method === "POST" && sub === "/login") return json({ ok: true, usingDefaultPassword });

        if (method === "GET" && sub === "/data") {
          const [config, candidates, roster, tally, used] = await Promise.all([getConfig(), getCandidates(), getRoster(), counts(), usedSet()]);
          const totalVotes = candidates.reduce((sum, c) => sum + (tally[c.id] || 0), 0);
          return json({
            config,
            candidates: candidates.map((c) => ({ ...c, votes: tally[c.id] || 0 })),
            registered: Object.keys(roster).length,
            voted: Object.keys(roster).filter((h) => used.has(h)).length,
            totalVotes,
            usingDefaultPassword,
          });
        }

        // רשימת המצביעים: שם, 3 ספרות אחרונות, והאם הצביע (בלי המועמד שנבחר)
        if (method === "GET" && sub === "/students") {
          const [roster, used] = await Promise.all([getRoster(), usedSet()]);
          const students = Object.entries(roster)
            .map(([id, s]) => ({ id, name: s.name, last3: s.last3, voted: used.has(id) }))
            .sort((a, b) => a.name.localeCompare(b.name, "he"));
          return json({ students });
        }

        // הוספת תלמידים: {name, idNumber} לתלמיד בודד, או {text} לרשימה (שורה לתלמיד)
        if (method === "POST" && sub === "/students") {
          const text = body.text ?? `${body.name || ""}, ${body.idNumber || ""}`;
          const { ok, bad } = parseStudents(text);
          if (ok.length > 3000) return err("יותר מדי תלמידים בבת אחת (מקסימום 3000)");
          const roster = await getRoster();
          let added = 0;
          const duplicates = [];
          for (const { name, id9 } of ok) {
            const h = await idHash(id9);
            if (roster[h]) { duplicates.push(`${name} (${roster[h].name})`); continue; }
            roster[h] = { name, last3: id9.slice(-3) };
            added++;
          }
          if (added) await store.set("roster", roster);
          return json({ added, duplicates, invalid: bad });
        }

        // הסרת תלמיד מהרשימה. אם כבר הצביע, הקול נשאר והוא לא יוכל להצביע שוב גם אם יוסף מחדש.
        const stuMatch = sub.match(/^\/students\/([a-f0-9]+)$/);
        if (stuMatch && method === "DELETE") {
          const roster = await getRoster();
          delete roster[stuMatch[1]];
          await store.set("roster", roster);
          return json({ ok: true });
        }

        if (method === "PUT" && sub === "/config") {
          const cur = await getConfig();
          const next = {
            title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : cur.title,
            open: typeof body.open === "boolean" ? body.open : cur.open,
          };
          await store.set("config", next);
          return json(next);
        }

        if (method === "POST" && sub === "/candidates") {
          const name = String(body.name || "").trim().slice(0, 80);
          if (!name) return err("חסר שם מועמד");
          if (body.photo && (!String(body.photo).startsWith("data:image/") || body.photo.length > MAX_PHOTO_CHARS))
            return err("התמונה לא תקינה או גדולה מדי");
          const candidates = await getCandidates();
          if (candidates.some((x) => nameKey(x.name) === nameKey(name))) return err("המועמד הזה כבר קיים ברשימה.", 409);
          const c = { id: randomId(8), name, photo: body.photo || "" };
          candidates.push(c);
          await store.set("candidates", candidates);
          return json(c);
        }

        const candMatch = sub.match(/^\/candidates\/([a-z0-9]+)$/);
        if (candMatch && method === "PUT") {
          const candidates = await getCandidates();
          const c = candidates.find((x) => x.id === candMatch[1]);
          if (!c) return err("מועמד לא נמצא", 404);
          if (typeof body.name === "string" && body.name.trim()) {
            const name = body.name.trim().slice(0, 80);
            if (candidates.some((x) => x.id !== c.id && nameKey(x.name) === nameKey(name))) return err("מועמד בשם הזה כבר קיים.", 409);
            c.name = name;
          }
          if (typeof body.photo === "string") {
            if (body.photo && (!body.photo.startsWith("data:image/") || body.photo.length > MAX_PHOTO_CHARS))
              return err("התמונה לא תקינה או גדולה מדי");
            c.photo = body.photo;
          }
          await store.set("candidates", candidates);
          return json(c);
        }
        if (candMatch && method === "DELETE") {
          const candidates = (await getCandidates()).filter((x) => x.id !== candMatch[1]);
          await store.set("candidates", candidates);
          const ballots = await store.list(`ballot/${candMatch[1]}/`);
          await inChunks(ballots, 50, (k) => store.delete(k));
          return json({ ok: true });
        }

        // איפוס קולות: מוחק פתקים וסימוני "הצביע". הרשימה והמועמדים נשארים.
        if (method === "POST" && sub === "/reset-votes") {
          const keys = [...(await store.list("ballot/")), ...(await store.list("used/")), ...(await store.list("rl/"))];
          await inChunks(keys, 50, (k) => store.delete(k));
          return json({ ok: true, deleted: keys.length });
        }
      }

      return err("לא נמצא", 404);
    } catch (e) {
      console.error(e);
      return err("שגיאת שרת", 500);
    }
  };
}
