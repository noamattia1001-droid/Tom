const $ = (id) => document.getElementById(id);
let state = { open: false, candidates: [], title: "" };
let session = null; // { name }
let picked = null;

const views = ["loginView", "voteView", "doneView", "closedView"];
function show(id) { views.forEach((v) => $(v).classList.toggle("hidden", v !== id)); }

async function api(path, opts) {
  const r = await fetch("/api" + path, { headers: { "content-type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "שגיאה");
  return data;
}

function renderCands() {
  const box = $("cands");
  box.innerHTML = "";
  for (const c of state.candidates) {
    const b = document.createElement("button");
    b.className = "cand";
    b.type = "button";
    const media = c.photo
      ? Object.assign(document.createElement("img"), { src: c.photo, alt: c.name })
      : Object.assign(document.createElement("div"), { className: "noimg", textContent: "👤" });
    const nm = Object.assign(document.createElement("div"), { className: "nm", textContent: c.name });
    b.append(media, nm);
    b.onclick = () => openConfirm(c);
    box.append(b);
  }
  if (!state.candidates.length) box.innerHTML = '<p class="muted">עוד לא נוספו מועמדים.</p>';
}

async function refresh() {
  try {
    const s = await api("/state");
    const sig = JSON.stringify(s);
    if (sig === refresh.last) return;
    refresh.last = sig;
    state = s;
    $("title").textContent = s.title;
    document.title = s.title;
    if (session && !$("voteView").classList.contains("hidden")) {
      if (!s.open) show("closedView"); else renderCands();
    }
  } catch { /* רשת נפלה רגע - ננסה שוב בסבב הבא */ }
}

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("loginErr").textContent = "";
  await refresh();
  try {
    const r = await api("/check", { method: "POST", body: JSON.stringify({ name: $("name").value }) });
    session = { name: r.name };
    $("who").textContent = r.name;
    if (r.voted) { $("doneTitle").textContent = "כבר הצבעת"; $("doneText").textContent = "השם הזה כבר הצביע, אפשר להצביע רק פעם אחת. תודה!"; session = null; return show("doneView"); }
    if (!state.open) return show("closedView");
    renderCands();
    show("voteView");
  } catch (x) { $("loginErr").textContent = x.message; }
};

function openConfirm(c) {
  picked = c;
  $("cName").textContent = c.name;
  const img = $("cImg");
  img.style.display = c.photo ? "block" : "none";
  img.src = c.photo || "";
  $("voteErr").textContent = "";
  $("confirm").classList.remove("hidden");
}
$("no").onclick = () => $("confirm").classList.add("hidden");
$("yes").onclick = async () => {
  $("yes").disabled = true;
  try {
    await api("/vote", { method: "POST", body: JSON.stringify({ name: session.name, candidateId: picked.id }) });
    $("confirm").classList.add("hidden");
    show("doneView");
    session = null;
  } catch (x) { $("voteErr").textContent = x.message; }
  $("yes").disabled = false;
};

refresh();
setInterval(refresh, 8000); // מועמדים חדשים מופיעים אוטומטית
