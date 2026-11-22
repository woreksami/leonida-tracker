"use strict";
// Leonida Port Tracker: reads the public Leonida repo from the visitor's browser and turns it into estimates.
// Unauthenticated GitHub limits per visitor IP: search 10/min, core 60/h. The schedule below stays under both
// (worst minute: 7 searches; core about 50 an hour).

const REPO = "ItsNotRexed/Leonida";
const API = "https://api.github.com";
const EXE_AT = Date.parse("2026-11-23T17:00:00Z"); // Mon 23 Nov, 12:00 noon Eastern (UTC-5)
const H = 3600e3, MIN = 60e3, DAY = 24 * H;
const DEV_WINDOW_H = [24, 48, 72];                 // developers' estimate: 1 to 3 days after the exe arrives
const PACE_CAP = [0.8, 1.25];
const FIELD = [
  ["ivall/xcl", "XCL", "Compatibility layer"],
  ["omonkeyz/xbox-emulator", "xbox-emulator", "Compatibility runtime"],
  ["realdody/americas-recomp", "americas-recomp", "Relinker and shader recompiler"],
  ["Freminet/ScarlettX", "ScarlettX", "HLE emulator"],
  ["brcly/TuxBox", "TuxBox", "Compatibility layer"],
];

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isoMin = (t) => new Date(Math.floor(t / MIN) * MIN).toISOString().replace(/\.\d+Z$/, "Z");

const S = {
  d3d: null, rt5: "unknown", rt5Pr: null, coordIssue: null, status: null,
  merged24: null, mergedPrev24: null, d3d48: null, d3d24: null,
  repo: null, field: {}, readmeCommits: [], milestones: [],
  lastOk: 0, backoffUntil: 0, boot: null, d3dEta: null,
};

/* ---------- per-visitor convenience storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("lpt:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lpt:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/* ---------- GitHub access ---------- */
const backoff = { core: 0, search: 0 };
async function gh(path, params) {
  const res = path.startsWith("/search") ? "search" : "core";
  if (Date.now() < backoff[res]) throw new Error("backoff");
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url, { cache: "no-cache", headers: { Accept: "application/vnd.github+json" } });
  if (r.status === 403 || r.status === 429) {
    const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000;
    backoff[res] = reset > Date.now() ? reset + 2000 : Date.now() + 5 * MIN;
    S.backoffUntil = Math.max(backoff.core, backoff.search);
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
  if (/shader|spir-?v|rdna|translat|\bv_[a-z]/i.test(title)) return "shader";
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

// README "Project status" table: ✅ = 1, ⚠️ or ? = ½, ❌ = 0. The "Booting…" row is the boot signal, not groundwork.
function parseStatus(md) {
  const at = md.indexOf("## Project status");
  if (at < 0) return null;
  const rows = new Map();
  let boot = null, inTable = false;
  for (const line of md.slice(at).split("\n").slice(1)) {
    if (/^\|/.test(line)) inTable = true; else if (inTable) break; else continue;
    const c = line.split("|").map((s) => s.trim());
    const name = c[1] || "", st = c[2] || "";
    if (!name || name === "What" || /^-+$/.test(name)) continue;
    const v = st.startsWith("✅") ? 1 : st.startsWith("❌") ? 0 : (st.startsWith("⚠") || st.startsWith("?")) ? 0.5 : null;
    if (v == null) continue;
    if (/boot/i.test(name)) boot = v; else rows.set(name, v);
  }
  if (!rows.size) return null;
  const vals = [...rows.values()];
  return { ground: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length,
    done: vals.filter((v) => v === 1).length, part: vals.filter((v) => v === 0.5).length, boot };
}

function rt5From(body) {
  const blocked = body.split("\n").find((l) => /Blocked, not up for grabs/i.test(l)) || "";
  if (/\bRT-5\b(?!\d)/.test(blocked)) return "blocked";
  if (/\bRT-5\b(?!\d)/.test(body)) return "claimed";
  return "unknown";
}

// A README-changing commit. Merge commits here carry only "Merge pull request #N from user", so the PR title is
// looked up once and kept (titles of merged PRs don't change).
const prTitles = store.get("prTitles", {});
function readmeNews(c) {
  const first = c.commit.message.split("\n")[0].trim();
  const n = (first.match(/#(\d+)/) || [])[1];
  const revert = /^Revert /.test(first);
  const by = (first.match(/ from ([\w.-]+)/) || [])[1];
  const title = n && prTitles[n] ? prTitles[n] : n ? `pull request #${n}` : first;
  return {
    key: "readme" + c.sha, n, t: Date.parse(c.commit.committer?.date || c.commit.author.date),
    kind: revert ? "Reverted" : "Status page",
    title: revert ? `Status page change undone: ${title}` : `Status page updated: ${title}`,
    detail: revert ? `The maintainer reverted #${n} on the README, the project's own status page.`
      : `${by ? by + "'s" : "A"} change to the README, the project's own status page, was merged.`,
    href: n ? `https://github.com/${REPO}/pull/${n}` : c.html_url, src: n ? `PR #${n}` : "commit " + c.sha.slice(0, 7),
  };
}
async function fillTitles(raw) {
  for (const c of raw.slice(0, 8)) {
    const n = (c.commit.message.split("\n")[0].match(/#(\d+)/) || [])[1];
    if (!n || prTitles[n]) continue;
    try { prTitles[n] = (await gh(`/repos/${REPO}/pulls/${n}`)).title; } catch { break; }
  }
  store.set("prTitles", prTitles);
}
// Key merges: the project's own milestone names and boot work. Test-only and docs-only changes don't count.
const MILESTONE_RE = /\bM\d(\.\d)?\b|milestone|first[- ]light|first[- ](draw|frame|boot)|\bboot(s|ed|ing)?\b/i;
const isKeyMerge = (t) => MILESTONE_RE.test(t) && !/^(test|tests|docs?|ci|chore)\b/i.test(t.trim());

/* ---------- live log ---------- */
let log = store.get("log", []);
let filter = "all";
function note(e, fresh = true) {
  if (log.some((x) => x.key === e.key)) return;
  log.unshift({ ...e, fresh });
  log.sort((a, b) => b.t - a.t);
  log = log.slice(0, 150);
  store.set("log", log.map(({ fresh, ...x }) => x));
  renderLog(); renderFilters();
}
const events = store.get("events", []);
function event(e) { if (events.some((x) => x.key === e.key)) return; events.unshift(e); store.set("events", events.slice(0, 30)); }

/* ---------- jobs ---------- */
const jobs = [
  { every: 1, run: async () => {
      const r = await search(`is:pr is:merged merged:>=${isoMin(Date.now() - 6 * H)}`, { per_page: 40, sort: "updated", order: "desc" });
      const items = r.items.filter((i) => i.closed_at).sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at));
      const first = !log.length;
      for (const i of items) note({ key: "pr" + i.number, t: Date.parse(i.closed_at), area: areaOf(i.title), text: i.title, href: i.html_url, num: i.number, who: i.user?.login }, !first);
  } },
  { every: 1, run: async () => { S.merged24 = (await search(`is:pr is:merged merged:>=${isoMin(Date.now() - DAY)}`)).total_count; } },
  { every: 10, off: 3, run: async () => { S.mergedPrev24 = (await search(`is:pr is:merged merged:${isoMin(Date.now() - 2 * DAY)}..${isoMin(Date.now() - DAY)}`)).total_count; } },
  { every: 5, off: 1, run: async () => { S.d3d48 = (await search(`is:pr is:merged D3D in:title merged:>=${isoMin(Date.now() - 2 * DAY)}`)).total_count; } },
  { every: 5, off: 2, run: async () => { S.d3d24 = (await search(`is:pr is:merged D3D in:title merged:>=${isoMin(Date.now() - DAY)}`)).total_count; } },
  { every: 5, off: 3, run: async () => {
      const r = await search(`is:pr is:merged "RT-5" in:title`, { per_page: 20 });
      const hit = r.items.find((i) => /\bRT-5\b(?!\d)/.test(i.title));
      if (hit && !S.rt5Pr) { S.rt5Pr = hit; event({ key: "boot", t: Date.parse(hit.closed_at), kind: "Milestone", title: "The game boots: the boot task's pull request merged", detail: hit.title, href: hit.html_url, src: "PR #" + hit.number }); }
  } },
  { every: 10, off: 6, run: async () => {
      const r = await search(`is:pr is:merged merged:>=${isoMin(Date.now() - 14 * DAY)} milestone OR boot OR "first light" OR "first frame"`, { per_page: 30, sort: "updated", order: "desc" });
      S.milestones = r.items.filter((i) => isKeyMerge(i.title));
  } },
  { every: 10, off: 8, run: async () => {
      const r = await search(`is:issue is:open "Coordinating who works on what" in:title`, { per_page: 1, sort: "created", order: "desc" });
      if (r.items[0]) S.coordIssue = r.items[0].number;
  } },
  { every: 5, off: 0, run: async () => { const b = (await gh(`/repos/${REPO}/issues/313`)).body || ""; S.d3d = parseD3D(b) || S.d3d; } },
  { every: 5, off: 2, run: async () => {
      if (!S.coordIssue) throw new Error("no issue yet");
      const next = rt5From((await gh(`/repos/${REPO}/issues/${S.coordIssue}`)).body || "");
      if (next === "claimed") event({ key: "rt5claimed", t: Date.now(), kind: "Boot task", title: "Boot work started: the boot task (RT-5) was claimed", detail: "It left the coordination board's blocked list.", href: `https://github.com/${REPO}/issues/${S.coordIssue}`, src: "issue #" + S.coordIssue });
      S.rt5 = next;
  } },
  { every: 15, off: 4, run: async () => { S.repo = await gh(`/repos/${REPO}`); } },
  { every: 10, off: 5, run: async () => {
      const r = await gh(`/repos/${REPO}/readme`);
      const bytes = Uint8Array.from(atob(r.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0));
      S.status = parseStatus(new TextDecoder().decode(bytes)) || S.status;
  } },
  { every: 10, off: 7, run: async () => {
      const raw = await gh(`/repos/${REPO}/commits`, { path: "README.md", per_page: 12 });
      await fillTitles(raw);
      S.readmeCommits = raw.map(readmeNews);
  } },
  ...FIELD.map(([repo], i) => ({ every: 30, off: 9 + i * 4, run: async () => { S.field[repo] = await gh(`/repos/${repo}`); } })),
];

// Results and run times are cached per visitor, so a reload reuses data that is still fresh instead of
// spending GitHub's per-IP allowance again. A job that hasn't succeeded retries on the next minute.
const KEEP = ["d3d", "rt5", "rt5Pr", "coordIssue", "status", "merged24", "mergedPrev24", "d3d48", "d3d24", "repo", "field", "readmeCommits", "milestones"];
jobs.forEach((j, i) => { j.id = "j" + i; });
const cache = store.get("cache", { runs: {}, data: {} });
for (const k of KEEP) if (cache.data[k] !== undefined) S[k] = cache.data[k];
const slim = (r) => r && { description: r.description, stargazers_count: r.stargazers_count, forks_count: r.forks_count, open_issues_count: r.open_issues_count, pushed_at: r.pushed_at, license: r.license && { spdx_id: r.license.spdx_id } };
async function poll() {
  const now = Date.now();
  for (const j of jobs) {
    const last = cache.runs[j.id] || 0;
    if (now - last < j.every * MIN - 5e3) continue;
    try { await j.run(); cache.runs[j.id] = Date.now(); } catch { /* keep last values */ }
  }
  S.repo = slim(S.repo);
  for (const k of Object.keys(S.field)) S.field[k] = slim(S.field[k]);
  S.milestones = S.milestones.map((i) => ({ number: i.number, title: i.title, closed_at: i.closed_at, html_url: i.html_url, user: i.user && { login: i.user.login } }));
  for (const k of KEEP) cache.data[k] = S[k];
  store.set("cache", cache);
  estimate();
  renderAll();
}

/* ---------- estimates ---------- */
function estimate() {
  const now = Date.now();
  let pace = 1;
  if (S.merged24 != null && S.mergedPrev24) pace = clamp(S.merged24 / S.mergedPrev24, ...PACE_CAP);
  const [lo, mid, hi] = DEV_WINDOW_H.map((h) => EXE_AT + (h * H) / pace);
  const boot = { pace, lo, mid, hi, late: false, done: !!S.rt5Pr || S.status?.boot === 1 };
  if (!boot.done && now > hi) { boot.late = true; boot.mid = now + 6 * H; boot.hi = now + DAY; }
  const prev = store.get("bootMid", null);
  if (prev && Math.abs(prev - boot.mid) >= 30 * MIN && !boot.done && !boot.late) {
    note({ key: "eta" + Math.round(boot.mid / MIN), t: now, area: "eta",
      text: `First boot estimate moved ${dur(Math.abs(prev - boot.mid))} ${boot.mid < prev ? "earlier" : "later"} (pace ${pace.toFixed(2)}×)` });
  }
  store.set("bootMid", boot.mid);
  S.boot = boot;

  if (S.d3d && S.d3d48 != null) {
    const left = S.d3d.total - S.d3d.done;
    const r48 = S.d3d48 / 48, r24 = (S.d3d24 ?? S.d3d48 / 2) / 24;
    if (r48 > 0) {
      const a = now + (left / r48) * H, b = r24 > 0 ? now + (left / r24) * H : a;
      S.d3dEta = { left, r48, r24, mid: a, lo: Math.min(a, b), hi: Math.max(a, b) };
    } else S.d3dEta = { left, none: true };
  }
  if (now >= EXE_AT) event({ key: "exe", t: EXE_AT, kind: "Milestone", title: "The tester's exe arrived", detail: "The developers' 1 to 3 day estimate for booting starts now.", src: "schedule" });
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
const dayOf = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const ago = (t) => { const m = Math.round((Date.now() - t) / MIN); return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const link = (href, text, cls) => { const a = el("a", cls, text); a.href = href; a.target = "_blank"; a.rel = "noopener"; return a; };
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.4 11.2 3.2 8l1.1-1.1 2.1 2.1 5.3-5.3L12.8 4.8z"/></svg>';

/* ---------- rendering ---------- */
function phase() {
  const now = Date.now(), b = S.boot;
  if (b?.done) return ["Booted", "The game's own code is running on PC through Leonida. Next up: the first frame and the main menu."];
  if (now < EXE_AT) return ["Waiting for the exe", "Everything that can be done without the game's executable is in place. A tester's own copy reaches the developers on Monday at noon ET; booting is expected 1 to 3 days after that."];
  if (S.rt5 === "claimed") return ["Recompiling", "The exe is in and boot work has been claimed. The developers expect booting within 1 to 3 days of the exe arriving."];
  return ["Exe is in", "The exe has reached the developers. The boot task opens up next; booting is expected 1 to 3 days after the exe arrived."];
}

function renderClocks() {
  const now = Date.now();
  const [ph, lede] = phase();
  if ($("phase").textContent !== ph) $("phase").textContent = ph;
  if ($("phase-lede").textContent !== lede) $("phase-lede").textContent = lede;

  $("exe-count").textContent = now >= EXE_AT ? "Arrived" : clock(EXE_AT - now);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("exe-when").textContent = tz === "America/New_York" ? "Monday 23 Nov, 12:00 noon ET" : `Monday 23 Nov, 12:00 noon ET (${when(EXE_AT)} your time)`;
  $("c-exe").classList.toggle("done", now >= EXE_AT);

  const b = S.boot;
  if (b) {
    $("c-boot").classList.toggle("done", b.done);
    $("c-boot").classList.toggle("late", b.late);
    if (b.done) {
      $("boot-count").textContent = "Booted";
      $("boot-window").textContent = S.rt5Pr ? `#${S.rt5Pr.number} merged ${when(Date.parse(S.rt5Pr.closed_at))}` : "Marked booting in Leonida's status table.";
    } else {
      $("boot-count").textContent = "~" + clock(b.mid - now);
      $("boot-window").textContent = b.late ? "Past the 1–3 day window. Rolling estimate until the boot task merges." : `Likely ${when(b.lo)} – ${when(b.hi)}`;
    }
  }
  const e = S.d3dEta;
  if (e) {
    if (e.none) { $("d3d-count").textContent = "No pace yet"; $("d3d-sub").textContent = `${e.left} items open, none merged in 48 h`; }
    else {
      $("d3d-count").textContent = "~" + clock(e.mid - now);
      $("d3d-sub").textContent = `${e.left} of ${S.d3d.total} items open · ${when(e.lo)} – ${when(e.hi)}`;
    }
  }
}

const RUNGS = [
  ["Groundwork", "Tools, shader translation, assets, loader and graphics layer"],
  ["Exe runs", "The game's own code starts on PC"],
  ["First frame", "The game draws its first picture"],
  ["Main menu", "Menus render and respond"],
  ["In-game", "Story mode loads and plays"],
  ["30 FPS", "Playable speed on common PCs"],
  ["Stable", "Long sessions without crashes"],
];
function renderLadder() {
  const st = S.status, ol = $("ladder-list"); ol.textContent = "";
  const top = st?.boot === 1 ? 4 : (st?.boot === 0.5 || S.rt5Pr) ? 1 : 0;
  RUNGS.forEach(([name, desc], i) => {
    const fill = i < top ? 1 : i === top ? (i === 0 ? (st ? st.ground : 0) : 0.5) : 0;
    const li = el("li", i < top ? "reached" : i === top ? "current" : "future");
    li.style.setProperty("--fill", fill * 100 + "%");
    const head = el("div"); head.append(el("div", "rn", "RUNG " + (i + 1)), el("h3", null, name));
    const foot = el("div"); foot.append(el("div", "pct", i < top ? "✓" : i === top ? (i === 0 && st ? Math.round(st.ground * 100) + "%" : "Now") : "—"), el("div", "desc", desc));
    li.append(el("div", "fill"), head, foot); ol.append(li);
  });
  $("ladder-note").textContent = st
    ? `Leonida is on rung ${top + 1}. Groundwork is ${Math.round(st.ground * 100)}%: ${st.done} of ${st.n} parts in its status table are done and ${st.part} partly done.`
    : "Reading Leonida's status table…";
}

let newsShown = 6;
function renderNews() {
  const items = [...events, ...S.readmeCommits,
    ...S.milestones.map((i) => ({ key: "ms" + i.number, t: Date.parse(i.closed_at), kind: /boot/i.test(i.title) ? "Boot work" : "Milestone", title: i.title, detail: `Merged into main${i.user ? `, written by ${i.user.login}` : ""}.`, href: i.html_url, src: "PR #" + i.number }))];
  const seen = new Set(), list = items.filter((x) => !seen.has(x.key) && seen.add(x.key)).sort((a, b) => b.t - a.t);
  const ol = $("news-list"); ol.textContent = "";
  if (!list.length) { ol.append(el("li", "empty", Date.now() < S.backoffUntil ? `GitHub is limiting requests from your network; news loads again at ${when(S.backoffUntil, false)}.` : S.lastOk ? "No verified news in the last two weeks yet." : "Loading verified news…")); $("news-more").hidden = true; return; }
  for (const n of list.slice(0, newsShown)) {
    const li = el("li");
    const t = el("time", null, dayOf(n.t) + " · " + when(n.t, false)); t.dateTime = new Date(n.t).toISOString();
    const body = el("div"); const h = el("h3"); h.append(el("span", "kind", n.kind));
    h.append(n.href ? link(n.href, n.title) : document.createTextNode(n.title));
    body.append(h); if (n.detail) body.append(el("p", null, n.detail));
    const src = n.href ? link(n.href, "", "src") : el("span", "src"); src.innerHTML = CHECK; src.append(" " + n.src);
    src.title = "Verified: opens the source on GitHub";
    li.append(t, body, src); ol.append(li);
  }
  $("news-more").hidden = list.length <= newsShown;
}
$("news-more").addEventListener("click", () => { newsShown += 8; renderNews(); });

const AREAS = [["all", "All"], ["d3d", "Graphics"], ["shader", "Shaders"], ["rt", "Runtime"], ["test", "Tests"], ["eta", "Estimates"]];
function renderFilters() {
  const box = $("filters"); box.textContent = "";
  for (const [k, label] of AREAS) {
    const n = k === "all" ? log.length : log.filter((e) => e.area === k).length;
    const b = el("button", null, label); b.type = "button"; b.setAttribute("aria-pressed", String(filter === k));
    b.append(el("span", null, String(n)));
    b.addEventListener("click", () => { filter = k; renderFilters(); renderLog(); });
    box.append(b);
  }
}
function renderLog() {
  const ol = $("log"); ol.textContent = "";
  const rows = log.filter((e) => filter === "all" || e.area === filter);
  if (!rows.length) { ol.append(el("li", "empty", log.length ? "Nothing in this area in the last six hours." : "Waiting for the first check…")); return; }
  for (const e of rows.slice(0, 80)) {
    const li = el("li", e.fresh ? "fresh" : "");
    const t = el("time", null, ago(e.t)); t.dateTime = new Date(e.t).toISOString(); t.title = new Date(e.t).toLocaleString();
    const what = el("div", "what");
    if (e.href) { const a = link(e.href, ""); if (e.num) a.append(el("span", "num", "#" + e.num)); a.append(e.text); what.append(a); }
    else what.append(el("span", null, e.text));
    if (e.who) what.append(el("span", "who", e.who));
    li.append(t, el("span", "area " + e.area, e.area === "eta" ? "estimate" : e.area), what);
    ol.append(li);
    e.fresh = false;
  }
}

function renderBoard() {
  const d = S.d3d; if (!d) return;
  const parts = [["done", "Merged", "var(--ok)"], ["review", "In review", "var(--sea)"], ["claimed", "Claimed", "var(--warn)"], ["open", "Unclaimed", "var(--mute)"]];
  const bar = $("d3d-bar"); bar.textContent = ""; const lg = $("d3d-legend"); lg.textContent = "";
  for (const [k, label, c] of parts) {
    const s = el("span"); s.style.width = (d[k] / d.total * 100) + "%"; s.style.background = c; s.title = `${label}: ${d[k]}`; bar.append(s);
    const w = el("div"); w.style.setProperty("--c", c); w.append(el("dt", null, label), el("dd", null, String(d[k]))); lg.append(w);
  }
  bar.setAttribute("aria-label", parts.map(([k, l]) => `${l} ${d[k]}`).join(", "));
}

function renderStats() {
  const r = S.repo, items = [
    [r?.stargazers_count, "Stars"], [r?.forks_count, "Forks"],
    [S.merged24, "PRs merged, last 24 h"], [S.mergedPrev24, "PRs merged, the day before"],
    [S.d3d48, "Graphics PRs merged, 48 h"], [r?.open_issues_count, "Open issues and PRs"],
  ];
  const box = $("stats"); box.textContent = "";
  for (const [v, l] of items) { const d = el("div"); d.append(el("dt", null, l), el("dd", null, v == null ? "–" : Number(v).toLocaleString())); box.append(d); }
}

function renderField() {
  const ol = $("field-list"); ol.textContent = "";
  const rows = [[REPO, "Leonida", "Static recompilation · GTA VI only", S.repo, true],
    ...FIELD.map(([repo, name, kind]) => [repo, name, kind, S.field[repo], false])];
  rows.sort((a, b) => (b[3]?.stargazers_count || 0) - (a[3]?.stargazers_count || 0));
  for (const [repo, name, kind, r, us] of rows) {
    const li = el("li", us ? "us" : "");
    const h = el("h3"); h.append(link(`https://github.com/${repo}`, name));
    li.append(el("span", "chip", us ? "This tracker follows it" : kind), h, el("span", "repo", repo));
    li.append(el("p", null, r?.description || (r ? "No description on GitHub." : "Loading…")));
    const meta = el("div", "meta");
    if (r) {
      const s = el("span"); s.append(el("b", null, Number(r.stargazers_count).toLocaleString()), " stars"); meta.append(s);
      const p = el("span"); p.append("pushed ", el("b", null, ago(Date.parse(r.pushed_at)) + " ago")); meta.append(p);
      if (r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION") meta.append(el("span", null, r.license.spdx_id));
    }
    li.append(meta); ol.append(li);
  }
}

function renderFormulas() {
  const b = S.boot;
  if (b) $("boot-formula").textContent =
    `pace   = merged 24 h ÷ merged previous 24 h\n       = ${S.merged24 ?? "?"} ÷ ${S.mergedPrev24 ?? "?"} → capped ${b.pace.toFixed(2)}×\n` +
    `window = exe + (24, 48, 72 h) ÷ pace\n       = ${when(b.lo)}\n         ${when(b.mid)}\n         ${when(b.hi)}` + (b.late ? "\n(late: rolling 6 h estimate)" : "");
  const e = S.d3dEta;
  if (e && !e.none) $("d3d-formula").textContent =
    `open  = ${S.d3d.total} items − ${S.d3d.done} merged = ${e.left}\n` +
    `speed = ${S.d3d48} PRs ÷ 48 h = ${(e.r48 * 24).toFixed(1)}/day\n        (24 h: ${(e.r24 * 24).toFixed(1)}/day)\n` +
    `eta   = now + open ÷ speed\n      = ${when(e.mid)}`;
  const st = S.status;
  if (st) $("ladder-formula").textContent =
    `groundwork = (done + ½ × partly) ÷ rows\n           = (${st.done} + ½ × ${st.part}) ÷ ${st.n}\n           = ${Math.round(st.ground * 100)}%\n` +
    `boot row   = ${st.boot === 1 ? "✅" : st.boot === 0.5 ? "⚠️" : "❌"}`;
}

function renderStatusLine() {
  const t = $("here");
  if (Date.now() < S.backoffUntil) t.title = `GitHub rate limit reached; data resumes at ${when(S.backoffUntil, false)}`;
}

function renderAll() { renderClocks(); renderLadder(); renderNews(); renderFilters(); renderLog(); renderBoard(); renderStats(); renderField(); renderFormulas(); renderStatusLine(); }

/* ---------- people here now (public MQTT brokers, retained heartbeats) ---------- */
// Each visitor keeps a retained timestamp on its own random topic; the broker clears it when the tab goes away
// (last will), and stale ones are ignored. Two brokers, counted together by visitor id.
// shortcut: public brokers, so the count can be faked; move to Supabase presence if that matters.
function presence() {
  const label = (n, l) => { $("here-n").textContent = n; $("here-l").textContent = l; };
  if (!window.mqtt) { label("–", "count blocked"); return; }
  const base = "leonida-tracker/v1/presence/";
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 16);
  const STALE = 75e3, seen = new Map(), clients = [];
  const anyUp = () => clients.some((c) => c.connected);
  const show = () => {
    const now = Date.now(); let n = 0;
    for (const [k, ts] of seen) { if (now - ts < STALE) n++; else if (now - ts > 10 * MIN) seen.delete(k); }
    if (anyUp()) label(Math.max(1, n).toLocaleString(), n > 1 ? "watching now" : "watching (just you)");
  };
  for (const url of ["wss://broker.emqx.io:8084/mqtt", "wss://test.mosquitto.org:8081/mqtt"]) {
    let c;
    try {
      c = mqtt.connect(url, { clientId: "lpt_" + id + "_" + clients.length, clean: true, keepalive: 30, reconnectPeriod: 30e3, connectTimeout: 10e3,
        will: { topic: base + id, payload: "", retain: true, qos: 1 } });
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
  setTimeout(() => { if (!anyUp()) label("–", "count unreachable"); }, 15e3);
  setInterval(() => { seen.set(id, Date.now()); show(); }, 30e3);
  addEventListener("pagehide", () => { for (const c of clients) try { c.publish(base + id, "", { retain: true, qos: 0 }); c.end(true); } catch { /* closing */ } });
}

/* ---------- hero picture: assets/hero.jpg if the site has one, else the drawn scene ---------- */
function heroArt() {
  const img = $("hero-img");
  img.addEventListener("error", () => img.remove());
  fetch("assets/hero-credit.txt", { cache: "no-cache" }).then((r) => r.ok ? r.text() : "").then((t) => { $("hero-credit").textContent = t.trim().slice(0, 200); }).catch(() => {});
}

function scene() {
  const c = $("scene"), x = c.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, Hh = 0;
  function size() { const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); W = r.width; Hh = r.height; c.width = W * dpr; c.height = Hh * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0); }
  function palm(px, base, h, lean, t) {
    x.strokeStyle = x.fillStyle = "#090616"; x.lineCap = "round"; x.lineWidth = Math.max(4, h * 0.035);
    const tx = px + lean, ty = base - h;
    x.beginPath(); x.moveTo(px, base); x.quadraticCurveTo(px + lean * 0.15, base - h * 0.5, tx, ty); x.stroke();
    const sway = still ? 0 : Math.sin(t / 1500 + px) * 0.04;
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + (i - 4) * 0.45 + sway, len = h * (0.34 + (i % 2) * 0.07);
      const ex = tx + Math.cos(a) * len * 1.3, ey = ty + Math.sin(a) * len * 0.5 + len * 0.42;
      x.beginPath(); x.moveTo(tx, ty);
      x.quadraticCurveTo(tx + Math.cos(a) * len * 0.65, ty + Math.sin(a) * len * 0.85 - len * 0.12, ex, ey);
      x.quadraticCurveTo(tx + Math.cos(a) * len * 0.55, ty + Math.sin(a) * len * 0.55, tx, ty + 3);
      x.fill();
    }
  }
  function draw(t) {
    const hz = Hh * 0.6;
    const g = x.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, "#120e2a"); g.addColorStop(0.4, "#3f1d62"); g.addColorStop(0.74, "#c2416f"); g.addColorStop(1, "#ff9a55");
    x.fillStyle = g; x.fillRect(0, 0, W, hz);
    const sr = Math.min(W * 0.17, Hh * 0.28), sx = W * 0.7, sy = hz - sr * 0.06;
    x.save(); x.beginPath(); x.rect(0, 0, W, hz); x.clip();
    const sg = x.createLinearGradient(0, sy - sr, 0, sy + sr); sg.addColorStop(0, "#ffe6a6"); sg.addColorStop(0.55, "#ff8f5e"); sg.addColorStop(1, "#ff4f9a");
    x.fillStyle = sg; x.beginPath(); x.arc(sx, sy, sr, 0, Math.PI * 2); x.fill();
    x.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 6; i++) x.fillRect(sx - sr, sy - sr * 0.1 + i * sr * 0.16, sr * 2, 2 + i * 1.8);
    x.restore();
    let seed = 11; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    x.fillStyle = "#231238";
    for (let bx = W * 0.3; bx < W * 0.95;) { const bw = 12 + rnd() * 26, bh = 10 + rnd() * Hh * 0.17; x.fillRect(bx, hz - bh, bw, bh); bx += bw + 3; }
    x.fillStyle = "rgba(255, 210, 150, .55)";
    seed = 5; for (let i = 0; i < 160; i++) { const px = W * 0.3 + rnd() * W * 0.65, py = hz - rnd() * Hh * 0.15; x.fillRect(px, py, 1.5, 1.5); }
    const sea = x.createLinearGradient(0, hz, 0, Hh); sea.addColorStop(0, "#3a1b57"); sea.addColorStop(1, "#0c0a1c");
    x.fillStyle = sea; x.fillRect(0, hz, W, Hh - hz);
    for (let i = 0; i < 28; i++) {
      const y = hz + 3 + i * i * 0.5; if (y > Hh) break;
      const w = sr * (1 - i * 0.03) * (1 + (still ? 0 : 0.1 * Math.sin(t / 650 + i * 1.7)));
      if (w <= 0) break;
      x.fillStyle = `rgba(255, ${160 - i * 3}, 110, ${0.45 - i * 0.015})`; x.fillRect(sx - w / 2, y, w, 1.4 + i * 0.1);
    }
    const cy = hz + (Hh - hz) * 0.3;
    x.fillStyle = "#110b21"; x.fillRect(0, cy, W, 5);
    for (let lx = 14; lx < W; lx += 64) {
      x.fillStyle = "#110b21"; x.fillRect(lx, cy - 18, 2, 18);
      x.fillStyle = "rgba(255, 196, 120, .9)"; x.fillRect(lx - 2, cy - 20, 6, 3);
      x.fillStyle = "rgba(255, 196, 120, .1)"; x.fillRect(lx - 1, cy + 5, 4, 20);
    }
    palm(W * 0.97, Hh + 8, Hh * 0.7, -W * 0.06, t);
    palm(W * 0.89, Hh + 24, Hh * 0.48, -W * 0.04, t);
    palm(W * 0.52, Hh + 30, Hh * 0.36, W * 0.02, t);
  }
  let last = 0;
  function loop(t) { if (t - last > 50) { draw(t); last = t; } requestAnimationFrame(loop); }
  size(); addEventListener("resize", () => { size(); draw(performance.now()); });
  if (still) draw(0); else requestAnimationFrame(loop);
}

/* ---------- page chrome: solid top bar after the hero, current section in the nav ---------- */
function chrome() {
  const top = document.querySelector(".top");
  const onScroll = () => top.classList.toggle("solid", scrollY > 40);
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
  const links = [...document.querySelectorAll(".nav a")];
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) for (const a of links) a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id);
  }, { rootMargin: "-45% 0px -50% 0px" });
  for (const a of links) { const s = document.querySelector(a.getAttribute("href")); if (s) io.observe(s); }
}

/* ---------- start ---------- */
chrome();
heroArt();
scene();
presence();
estimate();
renderAll();
setInterval(renderClocks, 1000);
setInterval(() => { for (const t of $("log").querySelectorAll("time")) { const d = Date.parse(t.dateTime); if (d) t.textContent = ago(d); } }, 30e3);
poll();
setInterval(poll, MIN);
