(() => {
"use strict";
const TZ = "America/Chicago";
const VIEWS = ["card", "board", "results", "duel", "about"];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const odds = p => (p > 0 ? "+" : "") + p;
const signed = (v, d = 1) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
const lineTxt = v => (v === 0 ? "PK" : (v > 0 ? "+" : "") + v);
const units = u => (u > 0 ? "+" : u < 0 ? "−" : "") + Math.abs(u).toFixed(2) + "u";
const pp = x => signed(x, 1) + " pp";
const pct = x => signed(x, 1) + "%";
const kick = iso => iso ? new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " CT" : "";
const stamp = iso => iso ? new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " CT" : "";
const payout = o => (o > 0 ? o / 100 : 100 / -o);
const ALIAS = { LAR: "LA", LA: "LA", WSH: "WAS", WAS: "WAS", JAX: "JAC", JAC: "JAC" };
const key = (a, h) => `${ALIAS[a] || a}@${ALIAS[h] || h}`;

let S = null, LIVE = null, LIVE_ERR = "";

function seasonStats(app) {
  const ps = (S.picks || []).filter(p => p.app === app && p.status !== "withdrawn");
  const g = ps.filter(p => ["won", "lost", "push"].includes(p.status));
  const w = g.filter(p => p.status === "won").length, l = g.filter(p => p.status === "lost").length, pu = g.filter(p => p.status === "push").length;
  const net = g.reduce((a, p) => a + (p.unitsResult || 0), 0), risked = g.reduce((a, p) => a + (p.units || 0), 0);
  const c = ps.filter(p => typeof p.clv === "number");
  return { ps, g, w, l, pu, net, risked, roi: risked ? 100 * net / risked : null,
    clv: c.length ? c.reduce((a, p) => a + p.clv, 0) / c.length : null,
    beat: c.length ? 100 * c.filter(p => p.beatClose).length / c.length : null, open: ps.filter(p => p.status === "open").length };
}
const rec = s => `${s.w}-${s.l}${s.pu ? "-" + s.pu : ""}`;

function livePrice(p) {
  if (!LIVE) return null;
  const g = LIVE.get(key(p.away, p.home));
  if (!g) return null;
  if (g.status !== "scheduled") return { locked: true, g };
  if (p.market === "spread") {
    if (g.spreadHome === undefined) return null;
    return p.side === "home" ? { num: g.spreadHome, price: g.spreadHomePrice, g } : { num: -g.spreadHome, price: g.spreadAwayPrice, g };
  }
  if (g.total === undefined) return null;
  return { num: g.total, price: p.side === "over" ? g.overPrice : g.underPrice, g };
}

function playableText(p) {
  const r = p.playable?.rows || [];
  if (!r.length) return "";
  const fmt = row => `${p.market === "spread" ? lineTxt(row.number) : (p.side === "over" ? "o" : "u") + row.number} at ${odds(row.minOdds)}`;
  return r.slice(0, 2).map(fmt).join(" · ");
}

function liveVerdict(p) {
  const lp = livePrice(p);
  if (!lp) return LIVE_ERR ? { cls: "muted", txt: "Live line unavailable" } : { cls: "muted", txt: "Checking line" };
  if (lp.locked) {
    const g = lp.g;
    if (g.status === "complete") return { cls: "muted", txt: "Final" };
    return { cls: "live", txt: `Live${typeof g.awayPts === "number" ? ` · ${p.away} ${g.awayPts}-${g.homePts} ${p.home}` : ""}` };
  }
  const now = `${p.market === "spread" ? lineTxt(lp.num) : lp.num} (${odds(lp.price)})`;
  const pl = p.playable;
  if (!pl || !pl.rows?.length) return { cls: "muted", txt: "Now " + now };
  const hi = pl.betterIsHigher, top = pl.rows[0].number;
  if (hi ? lp.num > top : lp.num < top) return { cls: "good", txt: "Better number now · " + now };
  const row = pl.rows.find(r => r.number === lp.num);
  if (!row) return { cls: "bad", txt: "Line moved past it · " + now };
  return payout(lp.price) + 1e-9 >= payout(row.minOdds) ? { cls: "good", txt: "Still good · " + now } : { cls: "bad", txt: "Price gone · " + now };
}

function ticket(p) {
  const done = ["won", "lost", "push"].includes(p.status);
  const v = done ? null : liveVerdict(p);
  const result = done ? `<span class="chip ${p.status}">${p.status}</span>` : "";
  const why = [
    p.case && `<div><h4>Why</h4><p>${esc(p.case)}</p></div>`,
    p.caseAgainst && `<div><h4>Case against</h4><p>${esc(p.caseAgainst)}</p></div>`,
    p.cancelIf && `<div><h4>Cancel if</h4><p>${esc(p.cancelIf)}</p></div>`,
    p.sources?.length && `<p class="sources">Sources: ${p.sources.map(s => /^https?:/.test(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(new URL(s).hostname.replace(/^www\./, ""))}</a>` : esc(s)).join(" · ")}</p>`,
  ].filter(Boolean).join("");
  return `<article class="ticket ${done ? p.status : ""}">
    <div class="ticket-top">
      <div class="sel">${esc(p.selection)}</div>
      <div class="price">${odds(p.price)}</div>
      <div class="matchup"><span>${esc(p.away)} @ ${esc(p.home)}</span><span>${kick(p.kickoff)}</span>${result}</div>
    </div>
    <div class="facts">
      <div class="fact"><span>Stake</span><b>${p.units}u</b></div>
      <div class="fact"><span>Edge</span><b>${typeof p.ev === "number" ? pct(p.ev * 100) + " EV" : "—"}</b></div>
      <div class="fact"><span>${done ? "CLV" : "Good to"}</span><b>${done ? (typeof p.clv === "number" ? pp(p.clv) : "—") : (esc(playableText(p)) || "—")}</b></div>
    </div>
    ${done ? `<div class="live-row"><span>${esc(p.finalScore || "")}</span><span class="num">${typeof p.unitsResult === "number" ? units(p.unitsResult) : ""}${typeof p.closeNumber !== "undefined" ? ` · closed ${p.market === "spread" ? lineTxt(p.closeNumber) : p.closeNumber} (${odds(p.closePrice)})` : ""}</span></div>`
      : `<div class="live-row"><span>Live line</span><span class="chip ${v.cls}"><span class="dot"></span>${esc(v.txt)}</span></div>`}
    ${why ? `<details class="why"><summary>Coach's reasoning</summary><div class="why-body">${why}</div></details>` : ""}
  </article>`;
}

function renderCard() {
  const wk = S.currentWeek, wd = (S.weeks || {})[String(wk)] || {};
  const mine = (S.picks || []).filter(p => p.app === "claude" && p.week === wk).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const pending = (wd.assessments || []).filter(a => a.status === "pending").length;
  const passed = (wd.assessments || []).filter(a => a.status === "pass").length;
  $("view-card").innerHTML = `
    ${wd.coachNote ? `<div class="note-card"><span class="eyebrow">From Coach</span><p>${esc(wd.coachNote)}</p></div>` : ""}
    <div class="section-head"><h2 id="t-card">Week ${wk} card</h2><span class="eyebrow">${mine.length} of 4 max</span></div>
    ${mine.length ? mine.map(ticket).join("") : `<div class="empty">No plays yet this week. Coach only plays when the number clears the bar after research.</div>`}
    <p class="pending-note">${pending ? `${pending} games still in research; the Sunday and Monday card is set Saturday morning after Friday's final injury reports and checked again Sunday at 10:40 AM CT. ` : ""}${passed ? `${passed} games passed so far. See Board for why.` : ""}</p>
    <p class="fine">Paper picks for research and entertainment, not betting advice. If you bet, bet only what you can afford to lose. Help: 1-800-GAMBLER.</p>`;
}

function renderBoard() {
  const wk = S.currentWeek, wd = (S.weeks || {})[String(wk)] || {};
  const rows = (wd.assessments || []).map(a => {
    const m = a.market || {}, r = a.research || {}, lg = LIVE?.get(key(a.away, a.home));
    const liveSp = lg && lg.spreadHome !== undefined ? lg.spreadHome : m.spreadHome, liveTot = lg && lg.total !== undefined ? lg.total : m.total;
    const label = a.status === "play" ? (a.play?.selection || "Play") : a.status === "pending" ? "Researching" : "Pass";
    const cls = a.status === "play" ? "good" : a.status === "pending" ? "muted" : "muted";
    return `<details class="game ${a.status}">
      <summary>
        <div class="g-teams">${esc(a.away)} @ ${esc(a.home)}<small>${kick(a.kickoff)}${a.neutral ? " · neutral site" : ""}</small></div>
        <span class="chip ${cls}">${esc(label)}</span>
        <div class="g-lines">
          <div class="g-line"><span>${esc(a.home)} spread</span><b>${liveSp !== undefined ? lineTxt(liveSp) : "—"} <span class="coach">· Coach ${a.modelLineHome !== undefined ? lineTxt(a.modelLineHome) : "—"}</span></b></div>
          <div class="g-line"><span>Total</span><b>${liveTot ?? "—"} <span class="coach">· Coach ${a.modelTotal ?? "—"}</span></b></div>
        </div>
      </summary>
      <div class="g-body">
        ${a.status === "play" && a.play ? `<p><b>${esc(a.play.selection)} ${odds(a.play.price)}</b> · wins ${(a.play.pWin * 100).toFixed(1)}%${a.play.pPush ? `, pushes ${(a.play.pPush * 100).toFixed(1)}%` : ""} · ${pct(a.play.ev * 100)} EV</p>` : ""}
        ${a.passReason && a.status !== "play" ? `<p>${esc(a.passReason)}</p>` : ""}
        <dl class="kv">
          <dt>Published market</dt><dd class="num">${m.spreadHome !== undefined ? `${esc(a.home)} ${lineTxt(m.spreadHome)} (${odds(m.spreadHomePrice)}/${odds(m.spreadAwayPrice)}) · ${m.total} (${odds(m.overPrice)}/${odds(m.underPrice)})` : "—"}</dd>
          <dt>Coach's ratings</dt><dd class="num">${a.modelLineHome !== undefined ? `${esc(a.home)} ${lineTxt(a.modelLineHome)} · total ${a.modelTotal}` : "—"}</dd>
          <dt>Priced at</dt><dd class="num">${a.finalLineHome !== undefined ? `${esc(a.home)} ${lineTxt(a.finalLineHome)} · total ${a.finalTotal}` : "—"}</dd>
          ${r.qbs ? `<dt>QBs</dt><dd>${esc(r.qbs)}</dd>` : ""}
          ${r.note ? `<dt>Research</dt><dd>${esc(r.note)}</dd>` : ""}
        </dl>
      </div>
    </details>`;
  }).join("");
  $("view-board").innerHTML = `<div class="section-head"><h2>Week ${wk} board</h2><span class="eyebrow">${LIVE ? "Live lines" : "Published lines"}</span></div>
    <p class="fine">Every game: the market line next to Coach's number. "Priced at" is what Coach actually uses after leaning back toward the market. Tap a game for the reasoning.</p>
    <div class="games">${rows || `<div class="empty">This week's board posts Tuesday morning.</div>`}</div>`;
}

function renderResults() {
  const s = seasonStats("claude");
  const byWeek = {};
  for (const p of s.g) (byWeek[p.week] ||= []).push(p);
  const weekRows = Object.keys(byWeek).sort((a, b) => b - a).map(w => {
    const ps = byWeek[w], ww = ps.filter(p => p.status === "won").length, ll = ps.filter(p => p.status === "lost").length, pu = ps.filter(p => p.status === "push").length;
    const net = ps.reduce((a, p) => a + (p.unitsResult || 0), 0), c = ps.filter(p => typeof p.clv === "number");
    return `<tr><td>Week ${w}</td><td class="num">${ww}-${ll}${pu ? "-" + pu : ""}</td><td class="r num">${units(net)}</td><td class="r num">${c.length ? pp(c.reduce((a, p) => a + p.clv, 0) / c.length) : "—"}</td></tr>`;
  }).join("");
  const hist = s.ps.slice().sort((a, b) => b.kickoff.localeCompare(a.kickoff)).map(p => `<tr>
    <td>W${p.week}</td><td>${esc(p.selection)}</td><td class="r num">${odds(p.price)}</td>
    <td class="r num">${typeof p.closeNumber !== "undefined" ? (p.market === "spread" ? lineTxt(p.closeNumber) : p.closeNumber) + " (" + odds(p.closePrice) + ")" : "—"}</td>
    <td class="r num">${typeof p.clv === "number" ? pp(p.clv) : "—"}</td><td><span class="chip ${p.status}">${p.status}</span></td>
    <td class="r num">${typeof p.unitsResult === "number" ? units(p.unitsResult) : "—"}</td></tr>`).join("");
  $("view-results").innerHTML = `<div class="section-head"><h2>Season results</h2><span class="eyebrow">Since Week 7</span></div>
    <div class="tiles">
      <div class="tile"><span>Record</span><b class="num">${rec(s)}</b><small>${s.open} open</small></div>
      <div class="tile"><span>Units</span><b class="num">${s.g.length ? units(s.net) : "—"}</b><small>1u flat</small></div>
      <div class="tile"><span>Avg CLV</span><b class="num">${s.clv === null ? "—" : pp(s.clv)}</b><small>vs closing line</small></div>
      <div class="tile"><span>Beat close</span><b class="num">${s.beat === null ? "—" : s.beat.toFixed(0) + "%"}</b><small>${s.roi === null ? "ROI —" : "ROI " + pct(s.roi)}</small></div>
    </div>
    <p class="fine">Watch CLV before the record. Beating the closing line is the earliest real sign of an edge; a record needs hundreds of picks to mean much.</p>
    ${weekRows ? `<div class="tablewrap"><table><thead><tr><th>Week</th><th>Record</th><th class="r">Units</th><th class="r">Avg CLV</th></tr></thead><tbody>${weekRows}</tbody></table></div>` : ""}
    <div class="tablewrap"><table><thead><tr><th>Wk</th><th>Pick</th><th class="r">Price</th><th class="r">Close</th><th class="r">CLV</th><th>Result</th><th class="r">Net</th></tr></thead>
    <tbody>${hist || `<tr><td colspan="7">No picks yet.</td></tr>`}</tbody></table></div>`;
}

function renderDuel() {
  const a = seasonStats("claude"), b = seasonStats("sharpai"), wk = S.currentWeek;
  const side = (cls, name, s) => `<div class="${cls}"><h3>${name}</h3><div class="rec num">${rec(s)}</div><dl>
    <dt>Units</dt><dd>${s.g.length ? units(s.net) : "—"}</dd><dt>ROI</dt><dd>${s.roi === null ? "—" : pct(s.roi)}</dd>
    <dt>Avg CLV</dt><dd>${s.clv === null ? "—" : pp(s.clv)}</dd><dt>Beat close</dt><dd>${s.beat === null ? "—" : s.beat.toFixed(0) + "%"}</dd>
    <dt>Open</dt><dd>${s.open}</dd></dl></div>`;
  const theirs = (S.picks || []).filter(p => p.app === "sharpai" && p.week === wk && p.status !== "withdrawn");
  $("view-duel").innerHTML = `<div class="section-head"><h2>Coach vs SharpAI</h2><span class="eyebrow">Same lines, same grading</span></div>
    <div class="duel">${side("coach", "Coach", a)}${side("sharp", "SharpAI", b)}</div>
    <div class="section-head"><h2>SharpAI's Week ${wk} picks</h2></div>
    <div class="mini">${theirs.length ? theirs.map(p => `<div class="mini-row"><div><b>${esc(p.selection)}</b> <span class="num">${odds(p.price)} · ${p.units}u</span><br><span class="fine">${esc(p.away)} @ ${esc(p.home)} · ${kick(p.kickoff)}</span></div><span class="chip ${p.status}">${p.status}</span></div>`).join("") : `<div class="empty">No official SharpAI picks recorded yet this week.</div>`}</div>
    <p class="fine">SharpAI picks are copied from its public card${S.sharpaiCheckedAt ? " (last checked " + stamp(S.sharpaiCheckedAt) + ")" : ""} and frozen at first sight. Both apps are graded at their own published number and price against Action Network book 15 closing lines. SharpAI stakes 0.5 to 1.5u and Coach bets 1u flat, so compare ROI and CLV rather than raw units.</p>`;
}

function renderAbout() {
  $("view-about").innerHTML = `<div class="prose">
    <h3>How Coach picks</h3>
    <ul>
      <li><b>Power ratings.</b> Every team is rated from Action Network closing lines and final scores, last season plus this one, weighted toward recent weeks. Blowouts are capped so garbage time doesn't move the needle.</li>
      <li><b>Research first.</b> Before a game can be played, Coach confirms both starting quarterbacks, the injury report and the weather, and every adjustment cites a source. No research, no play.</li>
      <li><b>Respect the market.</b> Coach keeps only 40% of any disagreement with the betting line. The market is usually right; the edge is in the gap that survives.</li>
      <li><b>Key numbers.</b> Win, push and loss chances come from how 907 NFL games actually finished, so 3 and 7 carry their real weight. That's why "Good to" can drop sharply off a 3.</li>
      <li><b>Totals need a reason.</b> Ratings alone showed no edge on totals in testing, so a total only plays with a real football reason like wind or injuries.</li>
      <li><b>The bar.</b> At least +2% expected value at the actual price, one play per game, four a week at most, 1 unit flat.</li>
      <li><b>Sanity check.</b> If Coach's number is more than 6.5 off the spread or 8 off the total with no news to explain it, the game is passed as "model error likely."</li>
    </ul>
    <h3>Reading a ticket</h3>
    <ul>
      <li><b>Good to</b> is the worst number and price where the play still clears the bar. If your book is worse than that, pass.</li>
      <li><b>Live line</b> checks Action Network's current consensus every time you open the app.</li>
      <li><b>CLV</b> is how many percentage points of win probability the pick beat the closing line by. Zero means it matched the close.</li>
    </ul>
    <h3>Schedule</h3>
    <p>Thursday 4:45 PM CT for Thursday night. Saturday 9:45 AM CT for the Sunday and Monday card. Sunday 10:40 AM CT inactives check. Tuesday 8:45 AM CT grading and next week's board.</p>
    <p class="fine">Coach's Card is a paper-picks research project. Nothing here is betting advice. If you bet, bet only what you can afford to lose. Problem gambling help: 1-800-GAMBLER.</p>
  </div>`;
}

function renderAll() {
  if (!S) return;
  $("weekLabel").textContent = `${S.season || 2026} NFL · Week ${S.currentWeek} · Paper picks`;
  $("updated").textContent = S.updatedAt ? "Updated " + stamp(S.updatedAt) : "";
  renderCard(); renderBoard(); renderResults(); renderDuel(); renderAbout();
}

function show(view) {
  const v = VIEWS.includes(view) ? view : "card";
  for (const n of VIEWS) $("view-" + n).hidden = n !== v;
  document.querySelectorAll(".tabbar a").forEach(a => a.dataset.view === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
}
document.querySelectorAll(".tabbar a").forEach(a => a.addEventListener("click", e => {
  e.preventDefault(); show(a.dataset.view); history.replaceState(null, "", "#" + a.dataset.view); window.scrollTo(0, 0);
}));
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

// Live lines: Action Network consensus (book 15) read straight from the browser; the /api/lines
// function is a fallback for hosts that provide it.
function parseAN(d) {
  return (d.games || []).map(g => {
    const ab = {}; for (const t of g.teams || []) ab[t.id] = t.abbr;
    const m = g.markets?.["15"]?.event || {}, row = { away: ab[g.away_team_id], home: ab[g.home_team_id], start: g.start_time, status: g.status };
    for (const o of m.spread || []) { if (o.side === "home") { row.spreadHome = o.value; row.spreadHomePrice = o.odds; } else row.spreadAwayPrice = o.odds; }
    for (const o of m.total || []) { row.total = o.value; row[o.side === "over" ? "overPrice" : "underPrice"] = o.odds; }
    const b = g.boxscore; if (b && typeof b.total_home_points === "number") { row.homePts = b.total_home_points; row.awayPts = b.total_away_points; }
    return row;
  });
}
async function loadLive() {
  let games = null;
  try {
    const r = await fetch(`https://api.actionnetwork.com/web/v2/scoreboard/publicbetting/nfl?week=${S.currentWeek}`, { cache: "no-store", signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error("status " + r.status);
    games = parseAN(await r.json());
  } catch (_) {
    try {
      const r = await fetch(`api/lines?week=${S.currentWeek}`, { cache: "no-store" });
      const d = await r.json();
      if (r.ok) games = d.games;
    } catch (_) {}
  }
  if (games) { LIVE = new Map(games.map(g => [key(g.away, g.home), g])); LIVE_ERR = ""; }
  else LIVE_ERR = "unavailable";
  renderAll();
}

async function boot() {
  show(location.hash.slice(1));
  $("view-card").innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
  try {
    const r = await fetch("data/state.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("status " + r.status);
    S = await r.json();
  } catch (e) {
    $("view-card").innerHTML = `<div class="banner">Coach's card couldn't load. Check your connection and pull to refresh.</div>`;
    return;
  }
  renderAll();
  loadLive();
  setInterval(() => { if (document.visibilityState === "visible") loadLive(); }, 120000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadLive(); });
}
boot();
if ("serviceWorker" in navigator) {
  // When a new version of the app installs, reload once so the phone shows it right away.
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => r.update()).catch(() => {}));
}
})();
