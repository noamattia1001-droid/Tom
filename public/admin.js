const $ = (id) => document.getElementById(id);
const PALETTE = ["#15803d", "#22c55e", "#0f766e", "#65a30d", "#166534", "#2dd4bf", "#4d7c0f", "#059669", "#84cc16", "#047857"];
let pw = sessionStorage.getItem("adminPw") || "";
let data = null;
let voters = [];
let timer = null;

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  if (props.style && typeof props.style === "object") { e.removeAttribute("style"); Object.assign(e.style, props.style); }
  e.append(...kids.filter((k) => k != null));
  return e;
}

async function api(path, method = "GET", body) {
  const r = await fetch("/api/admin" + path, {
    method,
    headers: { "content-type": "application/json", "x-admin-password": pw },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await r.json().catch(() => ({}));
  if (r.status === 401) { logout(); throw new Error("סיסמה שגויה"); }
  if (!r.ok) throw new Error(out.error || "שגיאה");
  return out;
}

/* ---------- כניסה ---------- */
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  pw = $("pw").value;
  try { await api("/login", "POST", {}); sessionStorage.setItem("adminPw", pw); start(); }
  catch (x) { $("loginErr").textContent = x.message; }
};
function logout() {
  pw = ""; sessionStorage.removeItem("adminPw"); clearInterval(timer);
  $("app").classList.add("hidden"); $("loginView").classList.remove("hidden");
}
$("logout").onclick = logout;

async function start() {
  $("loginView").classList.add("hidden"); $("app").classList.remove("hidden");
  await load();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) load(); }, 8000);
}

async function load() {
  try {
    [data, { voters }] = await Promise.all([api("/data"), api("/voters")]);
    render();
  } catch (x) { console.warn(x.message); }
}

/* ---------- טאבים ---------- */
$("tabs").onclick = (e) => {
  const t = e.target.closest(".tab"); if (!t) return;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === t));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== t.dataset.tab));
};

/* ---------- תצוגה ---------- */
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function avatar(c, cls = "av") {
  return c.photo ? el("img", { src: c.photo, alt: c.name }) : el("div", { className: cls, textContent: "👤" });
}

function render() {
  const { config, candidates, totalVotes } = data;
  const leader = [...candidates].sort((x, y) => y.votes - x.votes)[0];

  $("pageTitle").textContent = config.title;
  $("statusPill").textContent = config.open ? "ההצבעה פתוחה" : "ההצבעה סגורה";
  $("statusPill").className = "pill " + (config.open ? "on" : "off");
  $("updated").textContent = " · התעדכן " + new Date().toLocaleTimeString("he-IL");
  $("pwWarn").classList.toggle("hidden", !data.usingDefaultPassword);

  $("stats").replaceChildren(
    ...[
      [data.voted, "תלמידים הצביעו"],
      [candidates.length, "מועמדים"],
      [totalVotes && leader ? leader.name : "-", "מוביל כרגע"],
    ].map(([n, l]) => el("div", { className: "stat" }, el("b", { textContent: String(n), style: { fontSize: String(n).length > 8 ? "1.3rem" : "" } }), el("span", { textContent: l })))
  );

  renderBars($("bars"), candidates, totalVotes);

  $("candList").replaceChildren(
    ...candidates.map((c) => {
      const nameIn = el("input", { type: "text", value: c.name, className: "grow" });
      const file = el("input", { type: "file", accept: "image/*" });
      const save = el("button", { className: "btn small", textContent: "שמירה", onclick: async () => {
        const body = { name: nameIn.value };
        if (file.files[0]) body.photo = await resizeImage(file.files[0]);
        await api("/candidates/" + c.id, "PUT", body).catch((x) => alert(x.message)); load();
      } });
      const del = el("button", { className: "btn small danger", textContent: "מחיקה", onclick: async () => {
        if (confirm(`למחוק את ${c.name}? גם הקולות שלו יימחקו.`)) { await api("/candidates/" + c.id, "DELETE"); load(); }
      } });
      return el("div", { className: "cand-admin" }, avatar(c), nameIn, file, el("b", { textContent: c.votes + " קולות" }), save, del);
    }),
    candidates.length ? null : el("p", { className: "muted", textContent: "עוד אין מועמדים. הוסיפו למעלה." })
  );

  renderVoters();

  if (document.activeElement !== $("cfgTitle")) $("cfgTitle").value = config.title;
  $("toggleOpen").textContent = config.open ? "⏹️ סגירת ההצבעה" : "▶️ פתיחת ההצבעה";
  $("toggleOpen").className = "btn " + (config.open ? "danger" : "ok");
  $("linkStudents").textContent = $("linkStudents").href = location.origin + "/";
  $("linkAdmin").textContent = $("linkAdmin").href = location.origin + "/admin";
}

function renderBars(box, candidates, totalVotes, forPdf = false) {
  const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
  const top = sorted[0]?.votes || 0;
  const rows = sorted.map((c, i) => {
    const color = PALETTE[candidates.findIndex((x) => x.id === c.id) % PALETTE.length];
    const share = pct(c.votes, totalVotes);
    return el("div", { className: "bar-row" + (top > 0 && c.votes === top ? " win" : "") },
      avatar(c),
      el("div", { className: "bar-name", textContent: c.name }),
      el("div", { className: "bar-track" }, el("div", { className: "bar-fill", style: { width: (top ? (c.votes / top) * 100 : 0) + "%", background: color } })),
      el("div", { className: "bar-num", textContent: `${c.votes} (${share}%)` })
    );
  });
  box.replaceChildren(...rows);
  if (!rows.length) box.append(el("p", { className: "muted", textContent: "הוסיפו מועמדים כדי לראות גרף." }));
}

function renderVoters() {
  const q = $("vFilter").value.trim().toLowerCase();
  const list = voters.filter((v) => !q || v.name.toLowerCase().includes(q));
  $("vCount").textContent = voters.length;
  $("vBody").replaceChildren(...list.map((v) =>
    el("tr", {},
      el("td", { textContent: v.name }),
      el("td", { textContent: new Date(v.at).toLocaleString("he-IL", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric" }) }),
      el("td", {}, el("button", { className: "btn small ghost", textContent: "שחרור", onclick: async () => {
        if (confirm(`לשחרר את "${v.name}" כך שיוכל להצביע שוב?`)) { await api("/voters/" + v.id, "DELETE"); load(); }
      } }))
    )));
}
$("vFilter").oninput = () => data && renderVoters();

/* ---------- מועמדים: הוספה + שינוי גודל תמונה בדפדפן ---------- */
function resizeImage(file, size = 480) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const c = Object.assign(document.createElement("canvas"), { width: size, height: size });
      c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(c.toDataURL("image/jpeg", 0.82));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("לא ניתן לקרוא את התמונה"));
    img.src = URL.createObjectURL(file);
  });
}

$("candForm").onsubmit = async (e) => {
  e.preventDefault();
  $("candErr").textContent = "";
  try {
    const f = $("candPhoto").files[0];
    await api("/candidates", "POST", { name: $("candName").value, photo: f ? await resizeImage(f) : "" });
    $("candForm").reset(); load();
  } catch (x) { $("candErr").textContent = x.message; }
};

$("csvVoters").onclick = () => {
  const rows = [["שם", "שעה"], ...voters.map((v) => [v.name, new Date(v.at).toLocaleString("he-IL")])];
  const csv = "\ufeff" + rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: "voters.csv" }).click();
};

/* ---------- הגדרות ---------- */
$("saveTitle").onclick = async () => { await api("/config", "PUT", { title: $("cfgTitle").value }); load(); };
$("toggleOpen").onclick = async () => { await api("/config", "PUT", { open: !data.config.open }); load(); };
$("reset").onclick = async () => {
  if (confirm("למחוק את כל הקולות? אי אפשר לבטל.") && confirm("בטוחים? כל התלמידים יוכלו להצביע מחדש.")) {
    await api("/reset-votes", "POST", {}); load();
  }
};

/* ---------- PDF ---------- */
// בונים דפי A4 מוסתרים ב-DOM (העברית נרנדרת ע"י הדפדפן, אז RTL ופונטים תקינים) ומצלמים ל-PDF.
const PAGE_W = 794, PAGE_H = 1123;

function newPage() {
  return el("div", { dir: "rtl", style: {
    width: PAGE_W + "px", height: PAGE_H + "px", padding: "48px", boxSizing: "border-box", background: "#fff",
    color: "#111827", fontFamily: "Heebo, Arial, sans-serif", position: "relative", overflow: "hidden",
  } });
}

async function pagesToPdf(pages, filename) {
  const stage = $("pdfStage");
  stage.replaceChildren(...pages);
  await document.fonts.ready;
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  for (let i = 0; i < pages.length; i++) {
    const canvas = await html2canvas(pages[i], { scale: 2, backgroundColor: "#ffffff", useCORS: true });
    if (i) pdf.addPage();
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 210, 297);
  }
  stage.replaceChildren();
  pdf.save(filename);
}

$("pdfReport").onclick = async (ev) => {
  const btn = ev.currentTarget; btn.disabled = true;
  try {
    await load();
    const { config, candidates, totalVotes } = data;
    const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
    const tied = sorted.length > 1 && sorted[0].votes === sorted[1].votes;
    const page = newPage();
    const stat = (n, l) => el("div", { style: { flex: "1", background: "#f3faf5", border: "1px solid #d9ebdf", borderRadius: "14px", padding: "14px 16px" } },
      el("div", { textContent: String(n), style: { fontSize: "28px", fontWeight: "800" } }),
      el("div", { textContent: l, style: { color: "#6b7491", fontSize: "14px" } }));

    page.append(
      el("div", { textContent: "תום כפר נוער · דוח תוצאות הבחירות", style: { color: "#15803d", fontWeight: "700", fontSize: "16px" } }),
      el("h1", { textContent: config.title, style: { fontSize: "34px", margin: "4px 0 2px", color: "#15803d" } }),
      el("div", { textContent: "תאריך הפקה: " + new Date().toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" }), style: { color: "#6b7491", marginBottom: "20px" } }),
      el("div", { style: { display: "flex", gap: "12px", marginBottom: "22px" } },
        stat(data.voted, "תלמידים הצביעו"), stat(candidates.length, "מועמדים"), stat(totalVotes, "קולות שנספרו")),
    );
    if (sorted.length && totalVotes > 0) {
      page.append(el("div", { style: { background: "#e7f6ec", border: "2px solid #15803d", borderRadius: "16px", padding: "14px 18px", marginBottom: "22px", fontSize: "20px", fontWeight: "800" } },
        tied ? "🤝 תיקו בין המובילים (" + sorted.filter((c) => c.votes === sorted[0].votes).map((c) => c.name).join(", ") + ")"
             : `🏆 המנצח/ת: ${sorted[0].name} עם ${sorted[0].votes} קולות (${pct(sorted[0].votes, totalVotes)}%)`));
    }
    const bars = el("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } });
    page.append(el("h2", { textContent: "כמה קולות קיבל כל מועמד", style: { fontSize: "20px", marginBottom: "12px" } }), bars);
    // בדוח משתמשים בצבעים קבועים ובמסגרת לבנה, בלי תלות בערכת נושא כהה
    const top = sorted[0]?.votes || 0;
    for (const c of sorted) {
      const color = PALETTE[candidates.findIndex((x) => x.id === c.id) % PALETTE.length];
      const face = c.photo
        ? el("img", { src: c.photo, style: { width: "52px", height: "52px", borderRadius: "50%", objectFit: "cover" } })
        : el("div", { textContent: "👤", style: { width: "52px", height: "52px", borderRadius: "50%", background: "#e5e7eb", textAlign: "center", lineHeight: "52px" } });
      bars.append(el("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
        face,
        el("div", { textContent: c.name, style: { width: "150px", fontWeight: "800", fontSize: "16px" } }),
        el("div", { style: { flex: "1", background: "#e5e7eb", borderRadius: "10px", height: "28px", overflow: "hidden" } },
          el("div", { style: { width: (top ? (c.votes / top) * 100 : 0) + "%", height: "100%", background: color, borderRadius: "10px" } })),
        el("div", { textContent: `${c.votes} (${pct(c.votes, totalVotes)}%)`, style: { width: "90px", fontWeight: "800", direction: "ltr", textAlign: "left" } })));
    }
    page.append(el("div", { textContent: "ההצבעה הייתה חשאית: כל תלמיד הצביע פעם אחת (זיהוי לפי שם, עם בדיקת כפילויות), והמערכת אינה שומרת קשר בין התלמיד לבחירתו.",
      style: { position: "absolute", bottom: "36px", right: "48px", left: "48px", color: "#6b7491", fontSize: "13px", borderTop: "1px solid #e5e7eb", paddingTop: "10px" } }));
    await pagesToPdf([page], "election-results.pdf");
  } catch (x) { alert("שגיאה ביצירת PDF: " + x.message); }
  btn.disabled = false;
};

if (pw) api("/login", "POST", {}).then(start).catch(() => {});
