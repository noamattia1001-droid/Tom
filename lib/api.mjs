// ליבת ה-API. עצמאית מהאחסון: מקבלת "store" ומחזירה handler בתקן Web (Request -> Response).
// store: get(key) / set(key,val) / setIfNew(key,val) / delete(key) / list(prefix)

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // בלי 0/O/1/I/L כדי למנוע בלבול
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

const genCode = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
};

const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

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
  const getVoters = async () => (await store.get("voters")) || {};

  async function counts() {
    const keys = await store.list("ballot/");
    const out = {};
    for (const k of keys) {
      const id = k.split("/")[1];
      out[id] = (out[id] || 0) + 1;
    }
    return out;
  }

  async function usedCodes() {
    return new Set((await store.list("used/")).map((k) => k.split("/")[1]));
  }

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

      if (method === "POST" && path === "/login") {
        const code = normCode(body.code);
        const voters = await getVoters();
        const voter = voters[code];
        if (!voter) return err("הקוד לא נמצא. בדקו שהקלדתם נכון.", 404);
        const used = (await store.get(`used/${code}`)) !== null;
        return json({ name: voter.name, voted: used });
      }

      if (method === "POST" && path === "/vote") {
        const code = normCode(body.code);
        const [config, candidates, voters] = await Promise.all([getConfig(), getCandidates(), getVoters()]);
        if (!config.open) return err("ההצבעה סגורה כרגע.", 403);
        if (!voters[code]) return err("קוד לא תקין.", 404);
        if (!candidates.some((c) => c.id === body.candidateId)) return err("מועמד לא קיים.", 400);
        // כתיבה אטומית - רק הראשונה מצליחה, אי אפשר להצביע פעמיים גם בלחיצות מקבילות
        const first = await store.setIfNew(`used/${code}`, { at: Date.now() });
        if (!first) return err("כבר הצבעת. אפשר להצביע רק פעם אחת.", 409);
        try {
          // פתק ההצבעה נפרד מהקוד - המורים לא יכולים לדעת מי הצביע למי
          await store.set(`ballot/${body.candidateId}/${randomId()}`, 1);
        } catch (e) {
          await store.delete(`used/${code}`);
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
          const [config, candidates, voters, tally, used] = await Promise.all([
            getConfig(), getCandidates(), getVoters(), counts(), usedCodes(),
          ]);
          const voterList = Object.entries(voters)
            .map(([code, v]) => ({ code, name: v.name, className: v.className, voted: used.has(code) }))
            .sort((a, b) => (a.className || "").localeCompare(b.className || "", "he") || a.name.localeCompare(b.name, "he"));
          const totalVotes = candidates.reduce((s, c) => s + (tally[c.id] || 0), 0);
          return json({
            config,
            candidates: candidates.map((c) => ({ ...c, votes: tally[c.id] || 0 })),
            voters: voterList,
            totalVotes,
            usingDefaultPassword,
          });
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
          if (typeof body.name === "string" && body.name.trim()) c.name = body.name.trim().slice(0, 80);
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

        if (method === "POST" && sub === "/voters") {
          // כל שורה: שם, כיתה   (הכיתה אופציונלית)
          const lines = String(body.text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          if (!lines.length) return err("לא הוזנו תלמידים");
          if (lines.length > 3000) return err("יותר מדי תלמידים בבת אחת (מקסימום 3000)");
          const voters = await getVoters();
          const created = [];
          for (const line of lines) {
            const [name, className = ""] = line.split(/[,\t;]/).map((s) => s.trim());
            if (!name) continue;
            let code;
            do { code = genCode(); } while (voters[code]);
            voters[code] = { name: name.slice(0, 80), className: className.slice(0, 40) };
            created.push({ code, name, className });
          }
          await store.set("voters", voters);
          return json({ created });
        }

        const voterMatch = sub.match(/^\/voters\/([A-Z0-9]+)$/);
        if (voterMatch && method === "DELETE") {
          const voters = await getVoters();
          delete voters[voterMatch[1]];
          await store.set("voters", voters);
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
