// ליבת ה-API. עצמאית מהאחסון: מקבלת "store" ומחזירה handler בתקן Web (Request -> Response).
// store: get(key) / set(key,val) / setIfNew(key,val) / delete(key) / list(prefix)

const MAX_PHOTO_CHARS = 400_000;

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

// מנרמלים שם כדי לתפוס כפילויות: בלי ניקוד/סימנים/רווחים כפולים, לא רגיש לאותיות,
// והסדר לא משנה ("דנה כהן" = "כהן דנה")
const nameWords = (s) =>
  String(s || "").normalize("NFKC").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const nameKey = (s) => nameWords(s).sort().join(" ");
const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 40);
const hashKey = async (s) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
};

async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export function createHandler(store, { adminPassword } = {}) {
  const password = adminPassword || "admin123";
  const usingDefaultPassword = !adminPassword;

  const getConfig = async () => ({ title: "בחירות מועצת התלמידים", open: false, ...(await store.get("config")) });
  const getCandidates = async () => (await store.get("candidates")) || [];

  async function counts() {
    const keys = await store.list("ballot/");
    const out = {};
    for (const k of keys) {
      const id = k.split("/")[1];
      out[id] = (out[id] || 0) + 1;
    }
    return out;
  }

  const votedCount = async () => (await store.list("used/")).length;

  return async function handler(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, "") || "/";
    const method = req.method;
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

      // האם השם כבר הצביע (בדיקה מוקדמת, לפני שבוחרים מועמד)
      if (method === "POST" && path === "/check") {
        const name = cleanName(body.name);
        if (nameWords(name).length < 2) return err("נא לכתוב שם פרטי ושם משפחה.");
        const used = (await store.get(`used/${await hashKey(nameKey(name))}`)) !== null;
        return json({ name, voted: used });
      }

      if (method === "POST" && path === "/vote") {
        const name = cleanName(body.name);
        if (nameWords(name).length < 2) return err("נא לכתוב שם פרטי ושם משפחה.");
        const [config, candidates] = await Promise.all([getConfig(), getCandidates()]);
        if (!config.open) return err("ההצבעה סגורה כרגע.", 403);
        if (!candidates.some((c) => c.id === body.candidateId)) return err("מועמד לא קיים.", 400);
        // כתיבה אטומית - רק הראשונה מצליחה, אי אפשר להצביע פעמיים גם בלחיצות מקבילות
        const hash = await hashKey(nameKey(name));
        const first = await store.setIfNew(`used/${hash}`, { name, at: Date.now() });
        if (!first) return err("השם הזה כבר הצביע. אפשר להצביע רק פעם אחת.", 409);
        try {
          // פתק ההצבעה נפרד מהשם - המורים לא יכולים לדעת מי הצביע למי
          await store.set(`ballot/${body.candidateId}/${randomId()}`, 1);
        } catch (e) {
          await store.delete(`used/${hash}`);
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
          const [config, candidates, tally, voted] = await Promise.all([getConfig(), getCandidates(), counts(), votedCount()]);
          const totalVotes = candidates.reduce((sum, c) => sum + (tally[c.id] || 0), 0);
          return json({
            config,
            candidates: candidates.map((c) => ({ ...c, votes: tally[c.id] || 0 })),
            voted,
            totalVotes,
            usingDefaultPassword,
          });
        }

        // רשימת מי הצביע (שמות בלבד, בלי המועמד שבחרו)
        if (method === "GET" && sub === "/voters") {
          const keys = await store.list("used/");
          const out = [];
          await inChunks(keys, 50, async (k) => {
            const v = await store.get(k);
            if (v) out.push({ id: k.split("/")[1], name: v.name, at: v.at });
          });
          out.sort((x, y) => y.at - x.at);
          return json({ voters: out });
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

        // שחרור שם: מאפשר לתלמיד להצביע שוב (למשל כשנחסם בטעות בגלל שם זהה לתלמיד אחר).
        // הקול שכבר נספר נשאר, כי הוא לא קשור לשם.
        const voterMatch = sub.match(/^\/voters\/([a-f0-9]+)$/);
        if (voterMatch && method === "DELETE") {
          await store.delete(`used/${voterMatch[1]}`);
          return json({ ok: true });
        }

        if (method === "POST" && sub === "/reset-votes") {
          const keys = [...(await store.list("ballot/")), ...(await store.list("used/"))];
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
