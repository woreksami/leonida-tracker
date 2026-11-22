"use strict";
// Leonida Port Tracker: reads the public Leonida repo from the visitor's browser and turns it into estimates.
// Unauthenticated GitHub limits: search 10/min, core 60/h per visitor IP. The schedule below stays under both.

const REPO = "ItsNotRexed/Leonida";
const API = "https://api.github.com";
const EXE_AT = Date.parse("2026-11-23T17:00:00Z"); // Mon 23 Nov, 12:00 noon Eastern (UTC-5)
const H = 3600e3, MIN = 60e3;
const DEV_WINDOW_H = [24, 48, 72];                 // developers' estimate: 1 to 3 days after the exe arrives
const PACE_CAP = [0.8, 1.25];

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isoMin = (t) => new Date(Math.floor(t / MIN) * MIN).toISOString().replace(/\.\d+Z$/, "Z");

const S = {
  d3d: null, rt5: "unknown", rt5Pr: null, coordIssue: null,
  merged24: null, mergedPrev24: null, d3d48: null, d3d24: null,
  repo: null, recent: [], lastOk: 0, backoffUntil: 0, boot: null, d3dEta: null,
};

/* ---------- persistence (per-visitor convenience only) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("lpt:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lpt:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/* ---------- GitHub access ---------- */
async function gh(path, params) {
  if (Date.now() < S.backoffUntil) throw new Error("backoff");
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url, { cache: "no-cache", headers: { Accept: "application/vnd.github+json" } });
  if (r.status === 403 || r.status === 429) {
    const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000;
    S.backoffUntil = reset > Date.now() ? reset + 2000 : Date.now() + 5 * MIN;
    throw new Error("rate");
  }
  if (!r.ok) throw new Error("http " + r.status);
  S.lastOk = Date.now();
  return r.json();
}
const search = (q, extra) => gh("/search/issues", { q: `repo:${REPO} ${q}`, per_page: 1, ...extra });

/* ---------- parsing ---------- */
const ID_RE = /\b(D3D|SHADER|RT|TEST|ASSET|BUILD|FUZZ|PROC|DOC|PERF)-\d+/i;
function areaOf(title) {
  const m = title.match(ID_RE);
  if (m) return m[1].toLowerCase();
  if (/d3d12|vulkan|dxgi|descriptor|fence|swapchain/i.test(title)) return "d3d";
  if (/shader|spir-?v|rdna|translat|v_[a-z]/i.test(title)) return "shader";
  if (/runtime|shim|loader|gdk/i.test(title)) return "rt";
  if (/^test|test\(|tests?:/i.test(title)) return "test";
  if (/docs?[/:(]/i.test(title)) return "doc";
  return "misc";
}

function parseD3D(body) {
  const at = body.indexOf("### Who builds what");
  if (at < 0) return null;
  const out = { done: 0, review: 0, claimed: 0, open: 0 };
  for (const line of body.slice(at).split("\n").slice(1)) {
    if (/^###/.test(line)) break;
    if (!/^\|\s*D3D-\d+/.test(line)) continue;
    const c = line.split("|").map((s) => s.trim());
    const owner = c[3] || "", pr = c[4] || "";
    let merged = false, openPr = false;
    for (const m of pr.matchAll(/#\d+\s*(merged|closed|draft|on main)?/gi)) {
      const k = (m[1] || "").toLowerCase();
      if (k === "merged" || k === "on main") merged = true;
      else if (k !== "closed") openPr = true;
    }
    if (merged && !openPr) out.done++;
    else if (openPr) out.review++;
    else if (owner && owner !== "—" && owner !== "-") out.claimed++;
    else out.open++;
  }
  out.total = out.done + out.review + out.claimed + out.open;
  return out.total ? out : null;
}

function rt5From(body) {
  const blocked = body.split("\n").find((l) => /Blocked, not up for grabs/i.test(l)) || "";
  if (/\bRT-5\b(?!\d)/.test(blocked)) return "blocked";
  if (/\bRT-5\b(?!\d)/.test(body)) return "claimed";
  return "unknown";
}

/* ---------- live log ---------- */
let log = store.get("log", []);
function note(e, fresh = true) {
  if (log.some((x) => x.key === e.key)) return;
  log.unshift({ ...e, fresh });
  log.sort((a, b) => b.t - a.t);
  log = log.slice(0, 120);
  store.set("log", log.map(({ fresh, ...x }) => x));
  renderLog();
}

/* ---------- jobs ---------- */
const jobs = [
  { every: 1, run: async () => {
      const r = await search(`is:pr is:merged merged:>=${isoMin(Date.now() - 6 * H)}`, { per_page: 30, sort: "updated", order: "desc" });
      const items = r.items.filter((i) => i.closed_at).sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));
      const first = !S.recent.length && !log.length;
      for (const i of items.slice().reverse()) {
        note({ key: "pr" + i.number, t: Date.parse(i.closed_at), area: areaOf(i.title), text: i.title, href: i.html_url, num: i.number, who: i.user?.login }, !first);
      }
      S.recent = items;
  } },
  { every: 1, run: async () => { S.merged24 = (await search(`is:pr is:merged merged:>=${isoMin(Date.now() - 24 * H)}`)).total_count; } },
  { every: 10, run: async () => { S.mergedPrev24 = (await search(`is:pr is:merged merged:${isoMin(Date.now() - 48 * H)}..${isoMin(Date.now() - 24 * H)}`)).total_count; } },
  { every: 5, run: async () => { S.d3d48 = (await search(`is:pr is:merged D3D in:title merged:>=${isoMin(Date.now() - 48 * H)}`)).total_count; } },
  { every: 5, run: async () => { S.d3d24 = (await search(`is:pr is:merged D3D in:title merged:>=${isoMin(Date.now() - 24 * H)}`)).total_count; } },
  { every: 5, run: async () => {
      const r = await search(`is:pr is:merged "RT-5" in:title`, { per_page: 20 });
      const hit = r.items.find((i) => /\bRT-5\b(?!\d)/.test(i.title));
      if (hit && !S.rt5Pr) {
        S.rt5Pr = hit;
        note({ key: "boot", t: Date.parse(hit.closed_at), area: "mile", text: `The game boots: #${hit.number} merged`, href: hit.html_url });
      }
  } },
  { every: 10, run: async () => {
      const r = await search(`is:issue is:open "Coordinating who works on what" in:title`, { per_page: 1, sort: "created", order: "desc" });
      if (r.items[0]) S.coordIssue = r.items[0].number;
  } },
  { every: 3, run: async () => { const b = (await gh(`/repos/${REPO}/issues/313`)).body || ""; S.d3d = parseD3D(b) || S.d3d; } },
  { every: 3, run: async () => {
      if (!S.coordIssue) return;
      const next = rt5From((await gh(`/repos/${REPO}/issues/${S.coordIssue}`)).body || "");
      if (S.rt5 !== "unknown" && next !== S.rt5 && next === "claimed")
        note({ key: "rt5claimed", t: Date.now(), area: "mile", text: "Boot work started: RT-5 has been claimed on the coordination board" });
      S.rt5 = next;
  } },
  { every: 10, run: async () => { S.repo = await gh(`/repos/${REPO}`); } },
];

let minute = 0;
async function poll() {
  for (const j of jobs) {
    if (j.lastOk && minute % j.every !== 0) continue; // a job that hasn't succeeded yet retries every minute
    try { await j.run(); j.lastOk = Date.now(); } catch (e) { /* keep last values; the status bar says why */ }
  }
  minute++;
  estimate();
  renderAll();
}

/* ---------- estimates ---------- */
function estimate() {
  const now = Date.now();
  // first boot
  let pace = 1;
  if (S.merged24 != null && S.mergedPrev24) pace = clamp(S.merged24 / S.mergedPrev24, ...PACE_CAP);
  const [lo, mid, hi] = DEV_WINDOW_H.map((h) => EXE_AT + (h * H) / pace);
  const boot = { pace, lo, mid, hi, late: false, done: !!S.rt5Pr };
  if (!boot.done && now > hi) { boot.late = true; boot.mid = now + 6 * H; boot.hi = now + 24 * H; }
  const prev = store.get("bootMid", null);
  if (prev && Math.abs(prev - boot.mid) >= 30 * MIN && !boot.done && !boot.late) {
    note({ key: "eta" + Math.round(boot.mid / MIN), t: now, area: "eta",
      text: `First boot estimate moved ${dur(Math.abs(prev - boot.mid))} ${boot.mid < prev ? "earlier" : "later"} (work pace ${pace.toFixed(2)}×)` });
  }
  store.set("bootMid", boot.mid);
  S.boot = boot;

  // graphics layer
  if (S.d3d && S.d3d48 != null) {
    const left = S.d3d.total - S.d3d.done;
    const r48 = S.d3d48 / 48, r24 = (S.d3d24 ?? S.d3d48 / 2) / 24;
    if (r48 > 0) {
      const a = now + (left / r48) * H, b = r24 > 0 ? now + (left / r24) * H : a;
      const e = { left, r48, r24, mid: a, lo: Math.min(a, b), hi: Math.max(a, b) };
      const p = store.get("d3dMid", null);
      if (p && Math.abs(p - e.mid) >= 6 * H) note({ key: "d3d" + Math.round(e.mid / H), t: now, area: "eta",
        text: `Graphics layer estimate moved ${dur(Math.abs(p - e.mid))} ${e.mid < p ? "earlier" : "later"} (${left} items left)` });
      store.set("d3dMid", e.mid);
      S.d3dEta = e;
    } else S.d3dEta = { left, none: true };
  }
}

/* ---------- formatting ---------- */
function dur(ms) {
  const m = Math.round(ms / MIN), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}
function clock(ms) {
  if (ms <= 0) return "Now";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), p = (n) => String(n).padStart(2, "0");
  return `${d ? d + "d " : ""}${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}
const when = (t, withDay = true) => new Date(t).toLocaleString(undefined, withDay
  ? { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }
  : { hour: "numeric", minute: "2-digit" });
const ago = (t) => { const m = Math.round((Date.now() - t) / MIN); return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/* ---------- rendering ---------- */
function renderClocks() {
  const now = Date.now();
  $("exe-count").textContent = now >= EXE_AT ? "Arrived" : clock(EXE_AT - now);
  $("exe-when").textContent = `Mon 23 Nov · 12:00 noon ET · ${when(EXE_AT)} your time`;
  $("sign-exe").classList.toggle("done", now >= EXE_AT);

  const b = S.boot;
  if (b) {
    const sign = $("sign-boot");
    sign.classList.toggle("done", b.done);
    sign.classList.toggle("late", b.late);
    if (b.done) {
      $("boot-count").textContent = "Booted";
      $("boot-window").textContent = `#${S.rt5Pr.number} merged ${when(Date.parse(S.rt5Pr.closed_at))}`;
    } else {
      $("boot-count").textContent = "~" + clock(b.mid - now);
      const phase = now < EXE_AT ? "Waiting for the exe." : S.rt5 === "claimed" ? "Boot work underway." : "Exe is in; waiting for boot work to be claimed.";
      $("boot-window").textContent = b.late
        ? `Past the 1–3 day window. Rolling estimate until RT-5 merges.`
        : `Likely ${when(b.lo)} – ${when(b.hi)}. ${phase}`;
    }
  }
  const e = S.d3dEta;
  if (e) {
    if (e.none) { $("d3d-count").textContent = "No pace yet"; $("d3d-sub").textContent = `${e.left} items left, none merged in 48 h`; }
    else {
      $("d3d-count").textContent = "~" + clock(e.mid - now);
      $("d3d-sub").textContent = `${e.left} of ${S.d3d.total} items left · ${when(e.lo, false) === when(e.hi, false) ? when(e.mid) : when(e.lo) + " – " + when(e.hi)}`;
    }
  }
  const st = $("status-text"), pu = $("pulse");
  if (Date.now() < S.backoffUntil) { st.textContent = `GitHub rate limit · retry ${when(S.backoffUntil, false)}`; pu.className = "pulse warn"; }
  else if (S.lastOk) { const a = ago(S.lastOk); st.textContent = `Live · checked ${a === "now" ? "just now" : a + " ago"} · every minute`; pu.className = "pulse on"; }
}

const MARKERS = () => {
  const now = Date.now(), d = S.d3d;
  return [
    ["Your copy checked", "done", "Finds and verifies an Xbox Series 1.0.2.1 install."],
    ["Shaders unpacked", "done", "All 26,503 of the game's GPU shaders extracted and disassembled."],
    ["Shaders translated", "done", "All 26,503 converted from AMD console code to Vulkan's format, and all pass validation."],
    ["Assets readable", "done", "382,781 models plus textures and audio read with the project's own tools."],
    ["First light", "done", "A real game model drawn on a PC graphics card with its own translated shaders."],
    ["Loader and system calls", "wip", "Runs a stand-in program start to finish, controllers included. Not yet run on the real exe."],
    ["Graphics layer", "wip", d ? `${d.done} of ${d.total} tracker items merged, ${d.review} in review, ${d.claimed} claimed, ${d.open} unclaimed.` : "Direct3D 12 → Vulkan: queues, fences, copies and queries work; draws and the swapchain are still to come."],
    ["Exe reaches the developers", now >= EXE_AT ? "done" : "next", `${when(EXE_AT)} your time.`],
    ["First boot", S.rt5Pr ? "done" : now >= EXE_AT ? (S.rt5 === "claimed" ? "wip" : "next") : "todo", S.rt5Pr ? "The boot task merged." : "Recompile the exe and fix what breaks. Expected 1 to 3 days after the exe arrives."],
    ["Playable", "todo", "Story mode. No estimate until the game boots."],
  ];
};
const TAG = { done: "Done", wip: "In progress", next: "Next", todo: "Later" };

function renderMarkers() {
  const ol = $("markers"); ol.textContent = "";
  MARKERS().forEach(([name, state, text], i) => {
    const li = el("li", state);
    const mm = el("div", "mm"); mm.setAttribute("aria-hidden", "true"); mm.append(el("small", null, "MILE"), el("b", null, String(i + 1)));
    const box = el("div"); const h = el("h3"); h.append(el("span", null, name), el("span", "tag", TAG[state]));
    box.append(h, el("p", null, text)); li.append(mm, box); ol.append(li);
  });
}

function renderLog() {
  const ol = $("log"); ol.textContent = "";
  if (!log.length) { ol.append(el("li", "empty", "Waiting for the first check…")); return; }
  for (const e of log.slice(0, 60)) {
    const li = el("li", e.fresh ? "fresh" : "");
    const t = el("time", null, ago(e.t)); t.dateTime = new Date(e.t).toISOString(); t.title = new Date(e.t).toLocaleString();
    const what = el("div", "what");
    if (e.href) { const a = el("a", null, (e.num ? `#${e.num} ` : "") + e.text); a.href = e.href; a.target = "_blank"; a.rel = "noopener"; what.append(a); }
    else what.append(el("span", null, e.text));
    if (e.who) what.append(" ", el("span", "who", e.who));
    li.append(t, el("span", "area " + e.area, e.area === "mile" ? "milestone" : e.area), what);
    ol.append(li);
    e.fresh = false;
  }
}

function renderBoard() {
  const d = S.d3d; if (!d) return;
  const parts = [["done", "Merged", "var(--ok)"], ["review", "In review", "var(--sea)"], ["claimed", "Claimed, no code yet", "var(--wip)"], ["open", "Unclaimed", "var(--plain)"]];
  const bar = $("d3d-bar"); bar.textContent = "";
  const lg = $("d3d-legend"); lg.textContent = "";
  for (const [k, label, c] of parts) {
    const s = el("span"); s.style.width = (d[k] / d.total * 100) + "%"; s.style.background = c; s.title = `${label}: ${d[k]}`; bar.append(s);
    const w = el("div"); w.style.setProperty("--c", c); w.append(el("dt", null, label), el("dd", null, String(d[k]))); lg.append(w);
  }
  bar.setAttribute("aria-label", parts.map(([k, l]) => `${l} ${d[k]}`).join(", "));
}

function renderStats() {
  const r = S.repo, items = [
    [r?.stargazers_count, "Stars"], [r?.forks_count, "Forks"],
    [S.merged24, "PRs merged · last 24 h"], [S.mergedPrev24, "PRs merged · the 24 h before"],
    [S.d3d48, "Graphics PRs merged · 48 h"], [r?.open_issues_count, "Open issues and PRs"],
  ];
  const box = $("stats"); box.textContent = "";
  for (const [v, l] of items) { const d = el("div", "stat"); d.append(el("b", null, v == null ? "–" : Number(v).toLocaleString()), el("span", null, l)); box.append(d); }
}

function renderFormulas() {
  const b = S.boot;
  if (b) $("boot-formula").textContent =
    `pace = merged 24 h / merged previous 24 h = ${S.merged24 ?? "?"} / ${S.mergedPrev24 ?? "?"} → capped ${b.pace.toFixed(2)}×\n` +
    `window = exe + (24 h, 48 h, 72 h) ÷ pace\n` +
    `       = ${when(b.lo)} · ${when(b.mid)} · ${when(b.hi)}` + (b.late ? "\n(late: rolling 6 h estimate)" : "");
  const e = S.d3dEta;
  if (e && !e.none) $("d3d-formula").textContent =
    `left = ${S.d3d.total} items − ${S.d3d.done} merged = ${e.left}\n` +
    `speed = ${S.d3d48} graphics PRs / 48 h = ${(e.r48 * 24).toFixed(1)}/day (24 h: ${(e.r24 * 24).toFixed(1)}/day)\n` +
    `eta = now + left ÷ speed = ${when(e.mid)}`;
}

function renderAll() { renderClocks(); renderMarkers(); renderBoard(); renderStats(); renderFormulas(); renderLog(); }

/* ---------- scene: dusk over a causeway, drawn in code ---------- */
function scene() {
  const c = $("scene"), x = c.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, Hh = 0;
  function size() { const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); W = r.width; Hh = r.height; c.width = W * dpr; c.height = Hh * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0); }
  function palm(px, base, h, lean, t) {
    x.strokeStyle = x.fillStyle = "#0a0716"; x.lineCap = "round"; x.lineWidth = Math.max(4, h * 0.04);
    const tx = px + lean, ty = base - h;
    x.beginPath(); x.moveTo(px, base); x.quadraticCurveTo(px + lean * 0.15, base - h * 0.5, tx, ty); x.stroke();
    const sway = still ? 0 : Math.sin(t / 1400 + px) * 0.04;
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (i - 3.5) * 0.5 + sway, len = h * (0.36 + (i % 2) * 0.07);
      const ex = tx + Math.cos(a) * len * 1.3, ey = ty + Math.sin(a) * len * 0.5 + len * 0.42;
      x.beginPath(); x.moveTo(tx, ty);
      x.quadraticCurveTo(tx + Math.cos(a) * len * 0.65, ty + Math.sin(a) * len * 0.85 - len * 0.12, ex, ey);
      x.quadraticCurveTo(tx + Math.cos(a) * len * 0.55, ty + Math.sin(a) * len * 0.55, tx, ty + 3);
      x.fill();
    }
  }
  function draw(t) {
    const hz = Hh * 0.62;
    const g = x.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, "#140f2a"); g.addColorStop(0.42, "#47205f"); g.addColorStop(0.75, "#c9446f"); g.addColorStop(1, "#ff9a57");
    x.fillStyle = g; x.fillRect(0, 0, W, hz);
    const sr = Math.min(W * 0.2, Hh * 0.3), sx = W * 0.74, sy = hz - sr * 0.08;
    x.save(); x.beginPath(); x.rect(0, 0, W, hz); x.clip();
    const sg = x.createLinearGradient(0, sy - sr, 0, sy + sr); sg.addColorStop(0, "#ffe3a3"); sg.addColorStop(0.55, "#ff8f5e"); sg.addColorStop(1, "#ff5a7a");
    x.fillStyle = sg; x.beginPath(); x.arc(sx, sy, sr, 0, Math.PI * 2); x.fill();
    x.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 6; i++) x.fillRect(sx - sr, sy - sr * 0.1 + i * sr * 0.16, sr * 2, 2 + i * 1.8);
    x.restore();
    // distant skyline
    x.fillStyle = "#24133a"; let seed = 11; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let bx = W * 0.02; bx < W * 0.5;) { const bw = 10 + rnd() * 22, bh = 8 + rnd() * Hh * 0.13; x.fillRect(bx, hz - bh, bw, bh); bx += bw + 3; }
    // sea and sun glitter
    const sea = x.createLinearGradient(0, hz, 0, Hh); sea.addColorStop(0, "#3b1c58"); sea.addColorStop(1, "#0f0c1d");
    x.fillStyle = sea; x.fillRect(0, hz, W, Hh - hz);
    for (let i = 0; i < 26; i++) {
      const y = hz + 3 + i * i * 0.5; if (y > Hh) break;
      const w = sr * (1 - i * 0.03) * (1 + (still ? 0 : 0.1 * Math.sin(t / 650 + i * 1.7)));
      if (w <= 0) break;
      x.fillStyle = `rgba(255, ${160 - i * 3}, 110, ${0.45 - i * 0.015})`; x.fillRect(sx - w / 2, y, w, 1.4 + i * 0.1);
    }
    // causeway with lamps
    const cy = hz + (Hh - hz) * 0.34;
    x.fillStyle = "#120c22"; x.fillRect(0, cy, W, 6);
    for (let lx = 14; lx < W; lx += 58) {
      x.fillRect(lx, cy - 20, 2, 20);
      x.fillStyle = "rgba(255, 196, 120, .9)"; x.fillRect(lx - 2, cy - 22, 6, 3);
      x.fillStyle = "rgba(255, 196, 120, .12)"; x.fillRect(lx - 1, cy + 6, 4, 18);
      x.fillStyle = "#120c22";
    }
    palm(W * 0.04, Hh + 8, Hh * 0.72, W * 0.06, t);
    palm(W * 0.97, Hh + 8, Hh * 0.66, -W * 0.06, t);
    palm(W * 0.9, Hh + 24, Hh * 0.46, -W * 0.04, t);
    // keep text readable
    const v = x.createLinearGradient(0, 0, W, 0); v.addColorStop(0, "rgba(15,12,29,.82)"); v.addColorStop(.55, "rgba(15,12,29,.35)"); v.addColorStop(1, "rgba(15,12,29,.05)");
    x.fillStyle = v; x.fillRect(0, 0, W, Hh);
    const b = x.createLinearGradient(0, Hh * 0.55, 0, Hh); b.addColorStop(0, "rgba(15,12,29,0)"); b.addColorStop(1, "rgba(15,12,29,.92)");
    x.fillStyle = b; x.fillRect(0, Hh * 0.55, W, Hh * 0.45);
  }
  let last = 0;
  function loop(t) { if (t - last > 50) { draw(t); last = t; } requestAnimationFrame(loop); }
  size(); addEventListener("resize", () => { size(); draw(performance.now()); });
  if (still) draw(0); else requestAnimationFrame(loop);
}

/* ---------- people here now (public MQTT broker, retained heartbeats) ---------- */
// Each visitor keeps a retained timestamp on its own random topic; the broker clears it when the tab goes away
// (last will), and stale ones are ignored. shortcut: public broker, so the count can be faked; move to Supabase presence if that matters.
// Two brokers, counted together by visitor id, so one blocked or down server doesn't hide the count.
function presence() {
  const label = (n, l) => {
    $("here-n").textContent = n; $("here-l").textContent = l;
    $("watch-n").textContent = n; $("watch-l").textContent = l === "here now" ? (n === "1" ? "watching live (just you)" : "watching live with you") : l;
  };
  if (!window.mqtt) { label("–", "live count blocked"); return; }
  const base = "leonida-tracker/v1/presence/";
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 16);
  const STALE = 75e3, seen = new Map();
  const brokers = ["wss://broker.emqx.io:8084/mqtt", "wss://broker.hivemq.com:8884/mqtt"];
  const clients = [];
  const anyUp = () => clients.some((c) => c.connected);
  const show = () => {
    const now = Date.now(); let n = 0;
    for (const [k, ts] of seen) { if (now - ts < STALE) n++; else if (now - ts > 10 * MIN) seen.delete(k); }
    if (anyUp()) label(Math.max(1, n).toLocaleString(), "here now");
  };
  for (const url of brokers) {
    let c;
    try {
      c = mqtt.connect(url, {
        clientId: "lpt_" + id + "_" + clients.length, clean: true, keepalive: 30, reconnectPeriod: 30e3, connectTimeout: 10e3,
        will: { topic: base + id, payload: "", retain: true, qos: 1 },
      });
    } catch { continue; }
    const beat = () => c.connected && c.publish(base + id, String(Date.now()), { retain: true, qos: 1 });
    c.on("connect", () => { c.subscribe(base + "+", { qos: 0 }); seen.set(id, Date.now()); beat(); show(); });
    c.on("message", (topic, payload) => {
      const k = topic.slice(base.length), s = payload.toString();
      if (!/^[a-z0-9]{1,32}$/i.test(k)) return;
      if (!s) seen.delete(k);
      else if (/^\d{10,14}$/.test(s)) seen.set(k, Math.max(seen.get(k) || 0, Math.min(Number(s), Date.now())));
      show();
    });
    c.on("error", () => { /* reconnects on its own */ });
    setInterval(beat, 30e3);
    clients.push(c);
  }
  setTimeout(() => { if (!anyUp()) label("–", "live count unreachable"); }, 15e3);
  setInterval(() => { seen.set(id, Date.now()); show(); }, 30e3);
  addEventListener("pagehide", () => { for (const c of clients) try { c.publish(base + id, "", { retain: true, qos: 0 }); c.end(true); } catch { /* closing */ } });
}

/* ---------- start ---------- */
presence();
scene();
estimate();
renderAll();
setInterval(renderClocks, 1000);
setInterval(() => { for (const t of $("log").querySelectorAll("time")) { const d = Date.parse(t.dateTime); if (d) t.textContent = ago(d); } }, 30e3);
poll();
setInterval(poll, MIN);
