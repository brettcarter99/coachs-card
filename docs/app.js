(() => {
"use strict";
// Coach's Card lives on Netlify; send old GitHub Pages links there.
if (location.hostname.endsWith("github.io")) { location.replace("https://coachs-card.netlify.app/" + location.hash); return; }
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
// Coach picks float with the line until an hour before kickoff, then lock.
const LOCK_MIN = 60;
const lockMs = p => p.lockAt ? Date.parse(p.lockAt) : Date.parse(p.kickoff) - LOCK_MIN * 60000;
const isLocked = p => !!p.lockedAt || Date.now() >= lockMs(p);
const onCard = p => p.status !== "withdrawn" && p.status !== "off";
const isLean = p => p.tier === "lean";
const gutTxt = g => [g.spread ? `${signed(g.spread, 1)} pts to the home side` : "", g.total ? `${signed(g.total, 1)} on the total` : ""].filter(Boolean).join(", ");
const numTxt = (p, n) => p.market === "spread" ? lineTxt(n) : (p.side === "over" ? "o" : "u") + n;

let S = null, LIVE = null, LIVE_ERR = "";

// Fill plays (stored as tier "lean") count as plays. only: "bar" = plays that cleared the bar, "fill" = fill plays.
function seasonStats(app, only = null) {
  const ps = (S.picks || []).filter(p => p.app === app && onCard(p) && (!only || (only === "fill") === isLean(p)));
  const g = ps.filter(p => ["won", "lost", "push"].includes(p.status));
  const w = g.filter(p => p.status === "won").length, l = g.filter(p => p.status === "lost").length, pu = g.filter(p => p.status === "push").length;
  const net = g.reduce((a, p) => a + (p.unitsResult || 0), 0), risked = g.reduce((a, p) => a + (p.units || 0), 0);
  const c = ps.filter(p => typeof p.clv === "number"), cf = ps.filter(p => typeof p.clvFirst === "number");
  return { ps, g, w, l, pu, net, risked, roi: risked ? 100 * net / risked : null,
    clv: c.length ? c.reduce((a, p) => a + p.clv, 0) / c.length : null,
    clvFirst: cf.length ? cf.reduce((a, p) => a + p.clvFirst, 0) / cf.length : null,
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
  const floating = !isLocked(p);
  if (!row) return floating ? { cls: "warn", txt: "Line moved · Coach re-prices it next check · " + now } : { cls: "bad", txt: "Line moved past it · " + now };
  if (payout(lp.price) + 1e-9 >= payout(row.minOdds)) return { cls: "good", txt: "Still good · " + now };
  return floating ? { cls: "warn", txt: "Price moved · Coach re-prices it next check · " + now } : { cls: "bad", txt: "Price gone · " + now };
}

function ticket(p) {
  const pulled = p.status === "withdrawn";
  const done = ["won", "lost", "push"].includes(p.status);
  const v = done || pulled ? null : liveVerdict(p);
  const result = (done ? `<span class="chip ${p.status}">${p.status}</span>` : pulled ? `<span class="chip muted">Pulled</span>` : "");
  const why = [
    p.case && `<div><h4>Why</h4><p>${esc(p.case)}</p></div>`,
    p.caseAgainst && `<div><h4>Case against</h4><p>${esc(p.caseAgainst)}</p></div>`,
    p.cancelIf && `<div><h4>Cancel if</h4><p>${esc(p.cancelIf)}</p></div>`,
    p.gut && `<div><h4>Gut</h4><p>${gutTxt(p.gut)}${p.gut.why ? ": " + esc(p.gut.why) : ""}</p></div>`,
    p.sources?.length && `<p class="sources">Sources: ${p.sources.map(s => /^https?:/.test(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(new URL(s).hostname.replace(/^www\./, ""))}</a>` : esc(s)).join(" · ")}</p>`,
  ].filter(Boolean).join("");
  return `<article class="ticket ${done ? p.status : pulled ? "pulled" : ""}${isLean(p) ? " lean" : ""}">
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
    ${pulled ? `<div class="live-row"><span>Pulled ${stamp(p.withdrawnAt)}: ${esc(p.withdrawReason || "")}</span><span class="num">${p.ifPlayed?.status ? "If played: " + esc(p.ifPlayed.status) + (typeof p.ifPlayed.unitsResult === "number" ? " " + units(p.ifPlayed.unitsResult) : "") : ""}</span></div>` : done ? `<div class="live-row"><span>${esc(p.finalScore || "")}</span><span class="num">${typeof p.unitsResult === "number" ? units(p.unitsResult) : ""}${typeof p.closeNumber !== "undefined" ? ` · closed ${p.market === "spread" ? lineTxt(p.closeNumber) : p.closeNumber} (${odds(p.closePrice)})` : ""}</span></div>`
      : `<div class="live-row"><span>Live line</span><span class="chip ${v.cls}"><span class="dot"></span>${esc(v.txt)}</span></div>`}
    ${isLean(p) && !pulled ? `<div class="live-row"><span>Fill play: below the bar, played so the card has at least 3 plays.</span></div>` : ""}
    ${lockRow(p, done, pulled)}
    ${why ? `<details class="why"><summary>Coach's reasoning</summary><div class="why-body">${why}</div></details>` : ""}
  </article>`;
}

function lockRow(p, done, pulled) {
  if (pulled) return "";
  const first = typeof p.firstNumber === "number" && (p.firstNumber !== p.number || p.firstPrice !== p.price)
    ? `First posted ${numTxt(p, p.firstNumber)} (${odds(p.firstPrice)})` : "";
  if (done) return first || typeof p.clvFirst === "number" ? `<div class="live-row"><span>${first}</span><span class="num">${typeof p.clvFirst === "number" ? "CLV vs first " + pp(p.clvFirst) : ""}</span></div>` : "";
  const lk = isLocked(p);
  return `<div class="live-row"><span>${lk ? `Locked ${stamp(p.lockedAt || new Date(lockMs(p)).toISOString())}` : `Floats with the line until ${kick(new Date(lockMs(p)).toISOString())}`}</span><span class="num">${first}</span></div>`;
}

function offList(list) {
  if (!list.length) return "";
  return `<div class="section-head"><h2>Off the card</h2><span class="eyebrow">Below the bar right now</span></div>
    <div class="mini">${list.map(p => `<div class="mini-row"><div><b>${esc(p.selection)}</b> <span class="num">${odds(p.price)} · ${typeof p.ev === "number" ? pct(p.ev * 100) + " EV" : ""}</span><br>
      <span class="fine">${esc(p.away)} @ ${esc(p.home)} · ${kick(p.kickoff)} · ${isLocked(p) ? "stayed off at the lock, no pick on this game" : "comes back on if it clears +2% before " + kick(new Date(lockMs(p)).toISOString())}</span></div>
      <span class="chip muted">${isLocked(p) ? "No pick" : "Off"}</span></div>`).join("")}</div>
    <p class="fine">Coach's picks follow the market until an hour before kickoff. When the number moves far enough that a pick no longer clears the bar, it comes off the card; if the number comes back, so does the pick. An hour before kickoff everything locks.</p>`;
}

function renderCard() {
  const wk = S.currentWeek, wd = (S.weeks || {})[String(wk)] || {};
  const all = (S.picks || []).filter(p => p.app === "claude" && p.week === wk && !p.offWhenPulled).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const mine = all.filter(p => p.status !== "off"), off = all.filter(p => p.status === "off");
  const pending = (wd.assessments || []).filter(a => a.status === "pending").length;
  const passed = (wd.assessments || []).filter(a => a.status === "pass").length;
  $("view-card").innerHTML = `
    ${wd.coachNote ? `<div class="note-card"><span class="eyebrow">From Coach</span><p>${esc(wd.coachNote)}</p></div>` : ""}
    <div class="section-head"><h2 id="t-card">Week ${wk} card</h2><span class="eyebrow">${mine.filter(onCard).length} play${mine.filter(onCard).length === 1 ? "" : "s"} · 3 to 5 a week</span></div>
    ${mine.length ? mine.map(ticket).join("") : `<div class="empty">${off.length ? "Nothing on the card right now. The lines moved past Coach's picks; they come back on if the numbers do." : "No plays yet this week. Coach posts at least 3 plays a week once the slate is researched."}</div>`}
    ${offList(off)}
    <p class="pending-note">${pending ? `${pending} games still in research. Coach checks the slate every morning and afternoon; games with quarterback questions wait for Friday's injury designations, and Sunday inactives get a final look at 10:40 AM CT. ` : ""}${passed ? `${passed} games passed so far. See Board for why.` : ""}</p>
    <p class="fine">Paper picks for research and entertainment, not betting advice. If you bet, bet only what you can afford to lose. Help: 1-800-GAMBLER.</p>`;
}

function renderBoard() {
  const wk = S.currentWeek, wd = (S.weeks || {})[String(wk)] || {};
  const rows = (wd.assessments || []).map(a => {
    const m = a.market || {}, r = a.research || {}, lg = LIVE?.get(key(a.away, a.home));
    const liveSp = lg && lg.spreadHome !== undefined ? lg.spreadHome : m.spreadHome, liveTot = lg && lg.total !== undefined ? lg.total : m.total;
    const label = a.status === "play" || a.status === "lean" ? (a.play?.selection || "Play") : a.status === "pending" ? "Researching" : "Pass";
    const cls = a.status === "play" || a.status === "lean" ? "good" : "muted";
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
        ${(a.status === "play" || a.status === "lean") && a.play ? `<p><b>${esc(a.play.selection)} ${odds(a.play.price)}</b> · wins ${(a.play.pWin * 100).toFixed(1)}%${a.play.pPush ? `, pushes ${(a.play.pPush * 100).toFixed(1)}%` : ""} · ${pct(a.play.ev * 100)} EV · ${a.play.locked || Date.now() >= Date.parse(a.kickoff) - LOCK_MIN * 60000 ? "locked" : "floats until an hour before kickoff"}</p>` : ""}
        ${a.passReason && a.status !== "play" ? `<p>${esc(a.passReason)}</p>` : ""}
        <dl class="kv">
          <dt>Published market</dt><dd class="num">${m.spreadHome !== undefined ? `${esc(a.home)} ${lineTxt(m.spreadHome)} (${odds(m.spreadHomePrice)}/${odds(m.spreadAwayPrice)}) · ${m.total} (${odds(m.overPrice)}/${odds(m.underPrice)})` : "—"}</dd>
          <dt>Coach's ratings</dt><dd class="num">${a.modelLineHome !== undefined ? `${esc(a.home)} ${lineTxt(a.modelLineHome)} · total ${a.modelTotal}` : "—"}</dd>
          <dt>Priced at</dt><dd class="num">${a.finalLineHome !== undefined ? `${esc(a.home)} ${lineTxt(a.finalLineHome)} · total ${a.finalTotal}` : "—"}</dd>
          ${r.qbs ? `<dt>QBs</dt><dd>${esc(r.qbs)}</dd>` : ""}
          ${r.note ? `<dt>Research</dt><dd>${esc(r.note)}</dd>` : ""}
          ${a.gut ? `<dt>Gut</dt><dd>${gutTxt(a.gut)}${a.gut.why ? ": " + esc(a.gut.why) : ""}</dd>` : ""}
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
  const sb = seasonStats("claude", "bar"), sf = seasonStats("claude", "fill");
  const hist = (S.picks || []).filter(p => p.app === "claude" && !p.offWhenPulled).slice().sort((a, b) => b.kickoff.localeCompare(a.kickoff)).map(p => `<tr>
    <td>W${p.week}</td><td>${esc(p.selection)}${isLean(p) ? ` <span class="fine">fill</span>` : ""}</td><td class="r num">${odds(p.price)}</td>
    <td class="r num">${typeof p.closeNumber !== "undefined" ? (p.market === "spread" ? lineTxt(p.closeNumber) : p.closeNumber) + " (" + odds(p.closePrice) + ")" : "—"}</td>
    <td class="r num">${typeof p.clv === "number" ? pp(p.clv) : "—"}</td><td class="r num">${typeof p.clvFirst === "number" ? pp(p.clvFirst) : "—"}</td>
    <td><span class="chip ${p.status === "withdrawn" || p.status === "off" ? "muted" : p.status}">${p.status === "withdrawn" ? "pulled" : p.status === "off" ? (isLocked(p) ? "no pick" : "off") : p.status}</span></td>
    <td class="r num">${typeof p.unitsResult === "number" ? units(p.unitsResult) : "—"}</td></tr>`).join("");
  $("view-results").innerHTML = `<div class="section-head"><h2>Season results</h2><span class="eyebrow">Plays since Week 7</span></div>
    <div class="tiles">
      <div class="tile"><span>Record</span><b class="num">${rec(s)}</b><small>${s.open} open</small></div>
      <div class="tile"><span>Units</span><b class="num">${s.g.length ? units(s.net) : "—"}</b><small>1u flat</small></div>
      <div class="tile"><span>Avg CLV</span><b class="num">${s.clv === null ? "—" : pp(s.clv)}</b><small>${s.clvFirst === null ? "locked number vs close" : "vs first number " + pp(s.clvFirst)}</small></div>
      <div class="tile"><span>Beat close</span><b class="num">${s.beat === null ? "—" : s.beat.toFixed(0) + "%"}</b><small>${s.roi === null ? "ROI —" : "ROI " + pct(s.roi)}</small></div>
    </div>
    ${(() => { const pl = (S.picks || []).filter(p => p.app === "claude" && p.status === "withdrawn" && !p.offWhenPulled), g = pl.filter(p => p.ifPlayed?.status);
      if (!pl.length) return "";
      const w = g.filter(p => p.ifPlayed.status === "won").length, l = g.filter(p => p.ifPlayed.status === "lost").length, net = g.reduce((x, p) => x + (p.ifPlayed.unitsResult || 0), 0);
      return `<p class="fine">Pulled before kickoff: ${pl.length} pick${pl.length > 1 ? "s" : ""}. If they had been played: ${w}-${l}${g.length ? ", " + units(net) : ""}. Pulled picks don't count in the record above.</p>`; })()}
    ${sf.ps.length ? `<p class="fine">Split: plays that cleared the bar ${rec(sb)}${sb.g.length ? ", " + units(sb.net) : ""}${sb.clv === null ? "" : ", CLV " + pp(sb.clv)}. Fill plays (below the bar, played to reach 3) ${rec(sf)}${sf.g.length ? ", " + units(sf.net) : ""}${sf.clv === null ? "" : ", CLV " + pp(sf.clv)}${sf.open ? ", " + sf.open + " open" : ""}.</p>` : ""}
    <p class="fine">Watch CLV before the record. Beating the closing line is the earliest real sign of an edge; a record needs hundreds of picks to mean much. Picks are graded at the number they locked at, an hour before kickoff, so CLV against the close will often sit near zero. "CLV 1st" measures the number Coach first posted, which is where early-number skill shows up.</p>
    ${weekRows ? `<div class="tablewrap"><table><thead><tr><th>Week</th><th>Record</th><th class="r">Units</th><th class="r">Avg CLV</th></tr></thead><tbody>${weekRows}</tbody></table></div>` : ""}
    <div class="tablewrap"><table><thead><tr><th>Wk</th><th>Pick</th><th class="r">Price</th><th class="r">Close</th><th class="r">CLV</th><th class="r">CLV 1st</th><th>Result</th><th class="r">Net</th></tr></thead>
    <tbody>${hist || `<tr><td colspan="8">No picks yet.</td></tr>`}</tbody></table></div>`;
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
    <p class="fine">SharpAI picks are copied from its public card${S.sharpaiCheckedAt ? " (last checked " + stamp(S.sharpaiCheckedAt) + ")" : ""} and frozen at first sight. Both apps are graded against Action Network book 15 closing lines: SharpAI at its published number and price, Coach at the number and price his pick locked at an hour before kickoff. SharpAI stakes 0.5 to 1.5u and Coach bets 1u flat, so compare ROI and CLV rather than raw units. Coach's fill plays count like any play.</p>`;
}

function renderAbout() {
  $("view-about").innerHTML = `<div class="prose">
    <h3>How Coach picks</h3>
    <ul>
      <li><b>Power ratings.</b> Every team is rated from Action Network closing lines and final scores, last season plus this one, weighted toward recent weeks. Blowouts are capped so garbage time doesn't move the needle.</li>
      <li><b>Research first.</b> Before a game can be played, Coach confirms both starting quarterbacks, the injury report and the weather, and every adjustment cites a source. No research, no play.</li>
      <li><b>Lean correction.</b> Power ratings always sit a little closer to average than the market, which used to make big favorites look overpriced and nearly every play an underdog. Coach removes that built-in lean, so only real disagreement with the line counts. Totals get the same correction.</li>
      <li><b>Respect the market.</b> Coach keeps only 40% of any disagreement with the betting line. The market is usually right; the edge is in the gap that survives.</li>
      <li><b>Key numbers.</b> Win, push and loss chances come from how 907 NFL games actually finished, so 3 and 7 carry their real weight. That's why "Good to" can drop sharply off a 3.</li>
      <li><b>The bar.</b> A play needs at least +2% expected value at the actual price and a cited football reason (a QB change, injuries, weather). Ratings alone showed no edge against the closing line. One pick per game, 1 unit flat.</li>
      <li><b>3 to 5 plays a week.</b> Up to 5 plays. When fewer than 3 clear the bar, Coach plays his best remaining sides on researched games to reach 3. These fill plays count in the record; Results also shows them split out so you can see how each group does. A play that clears the bar bumps a fill play.</li>
      <li><b>Gut factor.</b> After the research, Coach can add a little gut feel: up to 1 point on a spread or 1.5 on a total, always with a written reason. It can change which side he likes, but it never counts as the cited reason a play needs to clear the bar. Every pick records its gut adjustment so we can see whether it helps.</li>
      <li><b>Sanity check.</b> If Coach's number is more than 6.5 off the spread or 8 off the total with no news to explain it, the game is passed as "model error likely."</li>
    </ul>
    <h3>Reading a ticket</h3>
    <ul>
      <li><b>Good to</b> is the worst number and price where the play still clears the bar. If your book is worse than that, pass.</li>
      <li><b>Floats until / Locked</b> shows whether the pick still follows the market or is set for good.</li>
      <li><b>Live line</b> checks Action Network's current consensus every time you open the app.</li>
      <li><b>CLV</b> is how many percentage points of win probability the pick beat the closing line by. Zero means it matched the close.</li>
    </ul>
    <h3>Schedule</h3>
    <p>Coach checks the slate twice a day, around 8:45 AM and 4:45 PM CT, plus a Sunday inactives check at 10:40 AM CT. Each check refreshes the board, looks for new plays, and re-checks every open pick. Lines also refresh on their own every two hours, and every few minutes as a game nears its lock. Grading happens once the week's games are final.</p>
    <h3>Picks float, then lock</h3>
    <p>Until an hour before kickoff, a Coach pick follows the market: it moves to the current number and price for the same side and is re-priced against Coach's number. If it still clears +2% EV it stays on the card. If not, it comes off the card, and it can come back on later that week if the number comes back. An hour before kickoff the pick locks: number, price and status never change after that, and a game with no pick on the card at the lock gets no pick. Picks are graded at the locked number. Each ticket shows the number Coach first posted, and Results tracks CLV against both.</p>
    <h3>Pulled picks</h3>
    <p>If real news breaks before the lock, like a quarterback ruled out, Coach can pull a pick for the week. Pulled picks stay on the card with the reason, don't count in the record, and are still graded as "if played" so you can see whether pulling them was right.</p>
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
