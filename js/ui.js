// Shared rendering: game canvas, results card, progress view. Used by the app and the preview page.
import { GAMES, STANCES } from './games.js';

const esc = x => String(x ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const probe = typeof document !== 'undefined' ? Object.assign(document.createElement('i'), { hidden: true }) : null;
const cache = {};
export function css(v) {
  if (!cache[v]) { if (!probe.isConnected) document.body.appendChild(probe); probe.style.color = `var(${v})`; probe.hidden = false; cache[v] = getComputedStyle(probe).color; probe.hidden = true; }
  return cache[v];
}
if (typeof matchMedia !== 'undefined') matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { for (const k in cache) delete cache[k]; });

// ------------------------------------------------------------ the game canvas
// Time runs right-to-left: upcoming targets scroll in from the right, "now" is the dot.
const PAST = 6, FUTURE = 3.5;
export function drawGame(cv, game, opts = {}) {
  const cx = cv.getContext('2d'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, W, H);
  const top = 70, bot = H - 12, xNow = W * 0.66, sx = (W - 8) / (PAST + FUTURE);
  const Y = v => bot - (bot - top) * Math.max(-0.05, Math.min(v, 1.25)) / 1.25;
  const X = tau => xNow + (tau - game.t) * sx;
  // grid
  cx.font = '11px Inter,system-ui,sans-serif'; cx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach(g => { cx.strokeStyle = css('--line'); cx.beginPath(); cx.moveTo(0, Y(g)); cx.lineTo(W, Y(g)); cx.stroke(); cx.fillStyle = css('--mut'); cx.fillText(g * 100 + '%', 4, Y(g) - 3); });
  // target band (past + upcoming)
  cx.fillStyle = css('--zone'); cx.strokeStyle = css('--hot'); cx.lineWidth = 2;
  const step = 0.04;
  for (let tau = Math.max(0, game.t - PAST); tau < game.t + FUTURE; tau += step) {
    const b = game.bandAt(tau); if (!b) continue;
    const hi = b.hi === Infinity ? 1.25 : b.hi, x0 = X(tau), w = step * sx + 0.6;
    cx.globalAlpha = tau > game.t ? 0.9 : 0.45;
    cx.fillStyle = b.kind === 'relax' || b.kind === 'ready' ? css('--calm') : css('--zone');
    cx.fillRect(x0, Y(hi), w, Y(b.lo) - Y(hi));
    if (b.kind === 'squeeze') { cx.fillStyle = css('--hot'); cx.fillRect(x0, Y(b.lo) - 1, w, 2); if (b.hi !== Infinity) cx.fillRect(x0, Y(b.hi) - 1, w, 2); }
  }
  cx.globalAlpha = 1;
  // now line
  cx.strokeStyle = css('--mut'); cx.setLineDash([3, 4]); cx.beginPath(); cx.moveTo(xNow, top - 8); cx.lineTo(xNow, bot); cx.stroke(); cx.setLineDash([]);
  // trace
  const pts = game.tl ? game.tl.all : game.samples;
  cx.strokeStyle = css('--plum'); cx.lineWidth = 3; cx.lineJoin = 'round'; cx.beginPath();
  let first = true;
  for (let i = Math.max(0, pts.length - 400); i < pts.length; i++) { const p = pts[i]; if (p.t < game.t - PAST) continue; const x = X(p.t), y = Y(p.v); first ? cx.moveTo(x, y) : cx.lineTo(x, y); first = false; }
  cx.stroke();
  const v = pts.length ? pts[pts.length - 1].v : 0, view = game.view();
  cx.fillStyle = view.inside ? css('--hot') : css('--plum'); cx.beginPath(); cx.arc(xNow, Y(v), 9, 0, 7); cx.fill();
  drawHud(cx, W, H, Y, view, game, top, opts);
  return view;
}

function drawHud(cx, W, H, Y, view, game, top, opts = {}) {
  const h = view.hud || {};
  cx.textAlign = 'center';
  const ring = () => {
    if (!view.reps) return;
    const rx = W - 36, ry = 34, rr = 22;
    cx.lineWidth = 6; cx.strokeStyle = css('--line'); cx.beginPath(); cx.arc(rx, ry, rr, 0, 7); cx.stroke();
    cx.strokeStyle = view.kind === 'squeeze' ? css('--hot') : css('--ok'); cx.beginPath(); cx.arc(rx, ry, rr, -Math.PI / 2, -Math.PI / 2 + Math.max(0, Math.min(1, view.frac)) * Math.PI * 2); cx.stroke();
    cx.fillStyle = css('--ink'); cx.font = '600 12px Inter,sans-serif'; cx.fillText(`${view.rep ?? 0}/${view.reps}`, rx, ry + 4);
  };
  if (h.kind === 'ring') ring();
  if (h.ref != null) {
    cx.strokeStyle = css('--plum'); cx.lineWidth = 1.5; cx.setLineDash([2, 4]); cx.beginPath(); cx.moveTo(0, Y(h.ref)); cx.lineTo(W, Y(h.ref)); cx.stroke(); cx.setLineDash([]);
    cx.fillStyle = css('--plum'); cx.font = '600 11px Inter,sans-serif'; cx.textAlign = 'left'; cx.fillText('your still hold', 34, Y(h.ref) - 4);
  }
  if (h.kind === 'bell') {
    // high-striker: a tower on the right; the puck flies to your best; the bell is your record
    const x = W - 30, y0 = Y(0), yR = Y(h.record || 1), yB = Y(h.best);
    cx.strokeStyle = css('--line'); cx.lineWidth = 10; cx.lineCap = 'round'; cx.beginPath(); cx.moveTo(x, y0); cx.lineTo(x, Y(1.2)); cx.stroke();
    cx.strokeStyle = css('--hot'); cx.beginPath(); cx.moveTo(x, y0); cx.lineTo(x, yB); cx.stroke(); cx.lineCap = 'butt';
    const rang = h.best >= (h.record || 1);
    cx.fillStyle = rang ? css('--gold') : css('--mut'); cx.beginPath(); cx.arc(x, yR - 12, rang ? 13 : 10, Math.PI, 0); cx.lineTo(x + (rang ? 13 : 10), yR - 8); cx.lineTo(x - (rang ? 13 : 10), yR - 8); cx.fill();
    cx.fillStyle = css('--ink'); cx.font = '600 11px Inter,sans-serif'; cx.fillText(rang ? 'DING!' : 'record', x - 2, yR - 30);
    if (view.reps) { cx.textAlign = 'left'; cx.font = '600 13px Inter,sans-serif'; cx.fillText(`Squeeze ${view.rep ?? 1} of ${view.reps}`, 70, 34); }
  }
  if (h.kind === 'beats') {
    const n = h.total, x0 = opts.big ? 120 : 20, r = Math.min(9, (W - x0 - 70) / n / 2.6);
    for (let i = 0; i < n; i++) { const x = x0 + i * r * 2.6 + r, y = 34; cx.beginPath(); cx.arc(x, y, r, 0, 7); cx.fillStyle = i < h.hits.length ? (h.hits[i] ? css('--ok') : css('--hot')) : css('--line'); cx.fill(); }
    ring();
  }
  if (h.kind === 'floor') {
    cx.fillStyle = css('--ink'); cx.font = '700 22px Fraunces,serif'; cx.textAlign = 'right';
    cx.fillText(h.floor ? `${h.dir === 'up' ? '▲' : '▼'} ${Math.round(h.floor * 100)}%` : 'G', W - 14, 40);
  }
  if (h.kind === 'ice') {
    const s = 46 * (1 - 0.75 * h.melt), x = W - 44, y = 40;
    cx.fillStyle = css('--ice'); cx.globalAlpha = 0.95; roundRect(cx, x - s / 2, y - s / 2 + (46 - s) / 2, s, s, 8); cx.fill();
    cx.globalAlpha = 1; cx.fillStyle = css('--ice'); cx.globalAlpha = 0.35; cx.beginPath(); cx.ellipse(x, y + 26, 10 + 26 * h.melt, 4 + 3 * h.melt, 0, 0, 7); cx.fill(); cx.globalAlpha = 1;
    if (h.soft) { cx.fillStyle = css('--ok'); cx.font = '600 11px Inter,sans-serif'; cx.fillText('melting', x, y - 30); }
  }
  if (h.kind === 'breath') {
    const x = W - 44, y = 38, r = 10 + 20 * h.frac;
    cx.strokeStyle = css('--ok'); cx.lineWidth = 3; cx.beginPath(); cx.arc(x, y, r, 0, 7); cx.stroke();
    cx.fillStyle = css('--ink'); cx.font = '600 11px Inter,sans-serif'; cx.fillText(h.inhale ? 'in' : 'out', x, y + 4);
  }
  if (h.kind === 'knack') {
    h.verdicts.forEach((ok, i) => { cx.beginPath(); cx.arc((opts.big ? 130 : 20) + i * 22, 34, 8, 0, 7); cx.fillStyle = ok ? css('--ok') : css('--hot'); cx.fill(); });
    if (h.cue) {
      cx.fillStyle = css('--hot'); cx.font = `800 ${Math.min(44, W / 9)}px Fraunces,serif`;
      cx.fillText(h.cue.split(' (')[0], W / 2, top + 50);
    }
    ring();
  }
  if (h.kind === 'stage' && h.stage) { cx.fillStyle = css('--ink'); cx.font = '700 18px Fraunces,serif'; cx.textAlign = 'right'; cx.fillText(h.stage, W - 14, 40); }
  if (view.stance) { cx.fillStyle = css('--mut'); cx.font = '600 12px Inter,sans-serif'; cx.textAlign = 'left'; cx.fillText('🧍 ' + view.stance, 8, H - 18); }
  cx.textAlign = 'left';
}
function roundRect(cx, x, y, w, h, r) { r = Math.min(r, h / 2, w / 2); cx.beginPath(); cx.moveTo(x + r, y); cx.arcTo(x + w, y, x + w, y + h, r); cx.arcTo(x + w, y + h, x, y + h, r); cx.arcTo(x, y + h, x, y, r); cx.arcTo(x, y, x + w, y, r); cx.closePath(); }

// ------------------------------------------------------------ metric dictionary
// [label, unit, plain-language meaning, higher is better?]
export const METRIC = {
  onTarget: ['On target', '%', 'Share of each squeeze spent inside the zone', true],
  relaxed: ['Let go between reps', '%', 'Rests where you dropped back to relaxed within 2 s', true],
  avgLevel: ['Average squeeze', '% max', 'How strong your holds were on average', true],
  peak: ['Peak', '% max', 'Strongest moment. Over 100% means you beat your calibration squeeze', true],
  retention: ['Kept while moving', '%', 'Moving squeeze ÷ still squeeze (100% = no drop)', true],
  heldThrough: ['Held through', 's', 'Seconds into the movement before the squeeze dropped below the bar', true],
  moveOnTarget: ['Moving on target', '%', 'Time at or above the bar (your set share of the still hold) while moving', true],
  stillOnTarget: ['Still on target', '%', 'Time above target during the still holds', true],
  stillLevel: ['Still squeeze', '% max', '', true],
  moveLevel: ['Moving squeeze', '% max', 'After removing what the movement itself adds', true],
  stillFade: ['Still-hold stamina', '×', 'Last still holds ÷ first (1.0 = no fade across the set)', true],
  retentionFade: ['Stamina while moving', '×', 'Last reps ÷ first reps', true],
  moveArtifact: ['Movement push', '% max', 'How much the movement alone moved the reading (subtracted)', false],
  bestHold: ['Longest hold', 's', 'Longest unbroken time above target', true],
  fatigue: ['Stamina', '×', '', true, 'hide'],
  fadePerSec: ['Fade', '%/s', '', true, 'hide'],
  sag: ['Sag within a hold', 'pts', 'How many points of your max a hold dropped from start to end (0 = rock steady)', false],
  relaxMedian: ['Let-go time', 's', 'Time to relax after a squeeze. Near 0 can also mean the hold had already faded', false],
  relaxMissed: ['Missed releases', '', 'Rests where you never fully let go', false],
  flicks: ['Flicks landed', '', 'Quick flicks after each hold', true],
  strainReps: ['Check-your-lift reps', '', 'Reps that looked like bearing down', false],
  timeToPeak: ['Time to peak', 's', 'How quickly you reach full strength', false],
  rise: ['Explosiveness', '%/s', 'Fastest rise in squeeze', true],
  consistency: ['Consistency', '%', 'How similar your squeezes were', true],
  valid: ['Clean flicks', '', 'Up past the line AND fully down again', true],
  validCount: ['Flicks landed', '', '', true, 'hide'], okCount: ['Shields', '', '', true, 'hide'],
  missedUp: ['Too weak', '', 'Beats that didn’t reach the line', false],
  missedDown: ['Didn’t drop', '', 'Beats where you didn’t let go in between', false],
  avgPeak: ['Average flick', '% max', '', true],
  release: ['Drop time', 's', 'How fast you let go after each flick', false],
  upAccuracy: ['Going up', '%', 'Accuracy on the way up', true],
  downAccuracy: ['Coming down', '%', 'Accuracy stepping down (usually harder)', true],
  avgError: ['Average miss', '% max', 'Distance from the floor', false],
  overshoot: ['Overshoot', '% max', 'Shooting past the floor', false],
  wobble: ['Wobble', '% max', 'Unsteadiness while holding a floor', false],
  error: ['Tracking error', '% max', 'Distance from the moving line', false],
  lag: ['Lag', 's', 'How far behind the line you ran', false],
  risingError: ['Error rising', '% max', '', false],
  fallingError: ['Error falling', '% max', 'Controlled release is usually the hard part', false],
  residual: ['Left-over tension', '% max', 'Squeeze still there 3 s after letting go', false],
  dropLevel: ['Breathing-drop level', '% max', 'Resting level during the breathing drops', false],
  drift: ['Drop vs start', '% max', 'Negative = you relaxed deeper than at the start', false],
  inSync: ['In sync', '%', 'Lifting on out-breaths and letting go on in-breaths', true],
  exhaleOnTarget: ['Out-breath lift', '%', '', true],
  inhaleRelaxed: ['In-breath release', '%', '', true],
  shielded: ['Shielded', '', 'Squeezed before the cough and held through it', true],
  avgLead: ['Head start', 's', 'How early you squeezed before the cough (aim 0.3–1 s)', true],
  reaction: ['Reaction', 's', 'Cue to squeeze', false],
  notDetected: ['Coughs not detected', '', 'Too gentle for the sensor to see', false],
  letGo: ['Let go too soon', '', 'Squeezed first but released during the cough', false],
  power: ['Strength (P)', '% max', 'Best of 3 max squeezes', true],
  endurance: ['Hold time (E)', 's', 'Seconds held above half your strongest (goal 10)', true],
  reps: ['Repeat holds (R)', '', 'Of 10 holds, how many lasted ≥80% as long as the first', true],
  fast: ['Quick flicks (F)', '', 'Of 10, clean fast squeeze-and-let-go flicks', true],
  stamina: ['Stamina', '%', 'How strong your last 3 holds were compared to your first 3 (100% = no fade)', true],
  restLevel: ['Resting level', '% max', 'Trend only. Rising over months can mean tension', false],
  restWobble: ['Resting wobble', '% max', '', false],
};

const fmtVal = (k, v) => v == null ? '–' : METRIC[k]?.[1] === 'pts' ? `${v} pts` : (METRIC[k]?.[1] === '%' || METRIC[k]?.[1] === '% max') ? `${v}%` : METRIC[k]?.[1] === 's' ? `${v}s` : METRIC[k]?.[1] === '×' ? `${v}×` : METRIC[k]?.[1] === '%/s' ? `${v}%/s` : String(v);

export function flags(res) {
  const m = res.metrics || {}, out = [];
  if (m.strainReps) out.push(['warn', `${m.strainReps} rep${m.strainReps > 1 ? 's' : ''} looked like bearing down, not lifting. These earned no points. Think “lift up and in”, keep breathing, belly soft.`]);
  if (m.relaxMissed) out.push(['warn', `You didn’t fully let go in ${m.relaxMissed} rest${m.relaxMissed > 1 ? 's' : ''}. Letting go matters as much as squeezing. Try a few rounds of Melt.`]);
  if (res.game === 'hold' && m.stamina != null && m.stamina < 60) out.push(['info', `Your last holds were ${m.stamina}% as strong as your first ones. That big fade is the endurance you’re working on.${res.next?.rest ? ` Next time you get ${res.next.rest} s of rest between holds to recover.` : ''}`]);
  if (m.peak != null && m.peak > 115 && res.game !== 'power') out.push(['info', `Your peak was ${m.peak}% of your calibrated max, so your calibration squeeze wasn’t quite full effort and every % reads high. Recalibrate when you’re fresh with a true all-out squeeze.`]);
  if (m.stillFade != null && m.stillFade < 0.8) out.push(['info', `Your still hold faded ${Math.round((1 - m.stillFade) * 100)}% from the first reps to the last, so later “kept while moving” numbers look better than they are. This is the endurance you’re building. Long holds in Hold the Line train it directly.`]);
  if (m.notDetected) out.push(['info', `${m.notDetected} cough${m.notDetected > 1 ? 's' : ''} weren’t detected. Cough a bit more firmly, or redo the cough recording in Setup.`]);
  if (res.newMax) out.push(['good', `New personal max, ${Math.round(res.newMax * 100)}% of your old one. Your calibration was updated.`]);
  if (res.nextText) out.push(['good', res.nextText]);
  if (res.calNote) out.push(['info', res.calNote]);
  return out;
}

export function resultHTML(res, prev) {
  const fl = flags(res);
  let h = `<div class="res-top"><div><div class="res-title">${esc(res.title)}</div>${res.moveLabel ? `<div class="note">${esc(res.moveLabel)}</div>` : ''}${res.stanceLabel ? `<div class="note">${esc(res.stanceLabel)}</div>` : ''}</div>`;
  h += res.perfect ? '' : `<div class="score"><b>${esc(res.score)}</b><span>score</span></div>`;
  h += '</div>';
  if (res.perfect) h += `<div class="tiles">${ckTiles(res).map(t => `<div class="tile"><b>${esc(t.v)}</b><span class="tn">${esc(t.name)}</span><span class="note">${esc(t.what)}</span></div>`).join('')}</div>`;
  if (fl.length) h += fl.map(([k, t]) => `<p class="flag ${k}">${esc(t)}</p>`).join('');
  if (res.holds?.length) {
    const top = Math.max(1, ...res.holds.map(x => x.level ?? 0));
    h += `<div class="bars"><div class="note"><b>Your 10 long holds.</b> Bar = how strong each hold was. Number = seconds it stayed above half the strength of your first hold${res.metrics?.stamina != null && res.metrics.stamina < 80 ? `. Your last holds were ${res.metrics.stamina}% of your first: that’s the endurance you’re building.` : ''}</div>` +
      res.holds.map((x, i) => `<div class="brow"><span>${i + 1}</span><div><i class="still" style="width:${Math.round(100 * (x.level ?? 0) / top)}%"></i></div><b>${esc(x.held)}s</b></div>`).join('') + '</div>';
  }
  if (res.game === 'move' && res.reps?.length) {
    // still vs moving, rep by rep: the gap is the drop you're working to shrink
    h += `<div class="bars"><div class="note">Each rep: <span class="k still"></span> still · <span class="k mov"></span> moving</div>` + res.reps.map((r, i) =>
      `<div class="brow"><span>${i + 1}</span><div><i class="still" style="width:${Math.min(100, r.still ?? 0)}%"></i><i class="mov" style="width:${Math.min(100, r.moving ?? 0)}%"></i></div><b>${esc(r.retention)}%</b></div>`).join('') + '</div>';
  }
  h += '<table class="mt"><tbody>';
  for (const [k, v] of Object.entries(res.metrics || {})) {
    const d = METRIC[k]; if (!d || d[4] === 'hide' || v == null) continue;
    if (res.perfect && ['power', 'endurance', 'reps', 'fast', 'relaxMedian', 'stamina'].includes(k)) continue;   // already shown as tiles
    let delta = '';
    const pv = prev?.metrics?.[k];
    if (typeof v === 'number' && typeof pv === 'number' && pv !== v) { const better = (v > pv) === d[3]; delta = `<span class="${better ? 'up' : 'down'}">${better ? 'better' : 'worse'} (was ${pv})</span>`; }
    h += `<tr><td>${esc(d[0])}${d[2] ? `<small>${esc(d[2])}</small>` : ''}</td><td>${esc(fmtVal(k, v))} ${delta}</td></tr>`;
  }
  return h + '</tbody></table>';
}

// The check-up's measures in plain words (P/E/R/F is the clinical PERFECT order, kept only as a small tag)
export const CK_ROWS = [
  { name: 'Strength', tag: 'P', what: 'Your strongest squeeze, vs your calibrated max', get: c => c.perfect?.P, fmt: v => v + '%', better: 1 },
  { name: 'Hold time', tag: 'E', what: 'Seconds you held above half your strongest (goal 10 s)', get: c => c.perfect?.E, fmt: v => v + ' s', better: 1 },
  { name: 'Repeat holds', tag: 'R', what: 'Of 10 long holds, how many stayed as strong and as long as your first', get: c => c.perfect?.R, fmt: v => v + ' of 10', better: 1 },
  { name: 'Stamina', what: 'Your last 3 long holds vs your first 3 (100% = no fade)', get: c => c.metrics?.stamina, fmt: v => v + '%', better: 1 },
  { name: 'Quick flicks', tag: 'F', what: 'Of 10 fast squeeze-and-let-go flicks (done fresh), how many were clean', get: c => c.perfect?.F, fmt: v => v + ' of 10', better: 1 },
  { name: 'Let-go time', what: 'How fast you relax after a squeeze (lower is better)', get: c => c.metrics?.relaxMedian, fmt: v => v + ' s', better: -1 },
  { name: 'Cough Shield', what: 'Coughs where you squeezed first and held through', get: c => c.knack, fmt: v => String(v).replace('/', ' of '), better: 1 },
  { name: 'Leak score', what: 'From your answers: 0 = no leaks, 12 = most (lower is better)', get: c => c.leak, fmt: v => v + ' of 12', better: -1 },
];
function ckTiles(c) { return CK_ROWS.filter(r => r.get(c) != null).map(r => ({ v: r.fmt(r.get(c)), name: r.name + (r.tag ? ` (${r.tag})` : ''), what: r.what })); }

// ------------------------------------------------------------ progress
export const KEY = { move: 'retention', hold: 'score', power: 'peak', flicks: 'validCount', elevator: 'onTarget', wave: 'onTarget', melt: 'relaxMedian', breath: 'inSync', knack: 'okCount' };
const keyVal = r => KEY[r.game] === 'score' ? r.score : r.metrics?.[KEY[r.game]];

function spark(vals, lowerBetter) {
  const v = vals.filter(x => x != null); if (v.length < 2) return '';
  const W = 120, H = 30, lo = Math.min(...v), hi = Math.max(...v), rng = hi - lo || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1) * W).toFixed(1)},${(H - 3 - (x - lo) / rng * (H - 6)).toFixed(1)}`).join(' ');
  const improving = lowerBetter ? v[v.length - 1] < v[0] : v[v.length - 1] > v[0];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline fill="none" stroke="${improving ? 'var(--ok)' : 'var(--mut)'}" stroke-width="2" stroke-linejoin="round" points="${pts}"/><circle cx="${W}" cy="${pts.split(' ').pop().split(',')[1]}" r="3" fill="var(--plum)"/></svg>`;
}

// Standing benchmarks from the postnatal return-to-impact guideline (Goom, Donnelly & Brockwell 2019)
export function milestones(sessions) {
  const st = sessions.filter(s => s.pos === 'standing');
  const has = f => st.some(f);
  return [
    ['10 clean fast flicks standing', has(s => s.game === 'flicks' && s.metrics.validCount >= 10) || has(s => s.game === 'checkup' && s.metrics.fast >= 10)],
    ['8–12 near-max holds of 6–8 s standing (Daily set ≥ 80% at a 70%+ target)', has(s => s.game === 'hold' && s.settings?.reps >= 8 && s.settings?.hold >= 6 && s.settings?.lo >= 70 && s.metrics.onTarget >= 80)],
    ['60 s hold at 30–50% standing', has(s => s.game === 'hold' && s.settings?.hold >= 60 && s.metrics.onTarget >= 80)],
    ['Cough Shield 6/6 standing', has(s => s.game === 'knack' && s.metrics.okCount >= 6)],
    ['Bridge + single-leg march: keep 80%+ of your still squeeze', sessions.some(s => s.game === 'move' && s.move === 'bridgeMarch' && s.metrics.retention >= 80 && !s.metrics.strainReps)],
    ['Bridge + march: hold through 14 s+ of marching', sessions.some(s => s.game === 'move' && s.move === 'bridgeMarch' && s.settings?.moving >= 14 && s.metrics.moveOnTarget >= 80)],
    ['Daily set at Level 3 (mini squats) or harder', has(s => s.game === 'hold' && ['squat', 'march', 'carry'].includes(s.stance) && s.metrics.onTarget >= 80)],
  ];
}

export function progressHTML(sessions, symptoms = []) {
  let h = '';
  const ms = milestones(sessions);
  h += `<h3>Milestones</h3><ul class="ms">${ms.map(([t, ok]) => `<li class="${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${esc(t)}</li>`).join('')}</ul>`;
  const cks = sessions.filter(s => s.game === 'checkup');
  if (cks.length) {
    const cols = cks.slice(0, 3);
    h += `<h3>Check-ups</h3><table class="ck"><thead><tr><th></th>${cols.map((c, i) => `<th>${esc(day(c.d))}${i === 0 ? '<small>latest</small>' : ''}</th>`).join('')}</tr></thead><tbody>`;
    h += CK_ROWS.map(r => `<tr><td><b>${esc(r.name)}</b><small>${esc(r.what)}</small></td>${cols.map((c, i) => {
      const v = r.get(c), pv = cols[i + 1] && r.get(cols[i + 1]);
      const arrow = typeof v === 'number' && typeof pv === 'number' && v !== pv ? ((v > pv) === (r.better > 0) ? '<small class="up">better</small>' : '<small class="down">worse</small>') : '';
      return `<td>${v == null ? '–' : esc(r.fmt(v))}${arrow}</td>`; }).join('')}</tr>`).join('');
    h += '</tbody></table>';
    if (cks.length > 3) h += `<p class="note">Showing your latest 3 of ${cks.length} check-ups.</p>`;
  }
  h += '<h3>Games</h3><div class="pgrid">';
  for (const [id, g] of Object.entries(GAMES)) {
    if (id === 'checkup') continue;
    const rs = sessions.filter(s => s.game === id).reverse(); // oldest → newest
    const k = KEY[id], lowerBetter = METRIC[k] ? !METRIC[k][3] : false;
    const last = rs[rs.length - 1];
    h += `<div class="pcard"><b>${esc(g.name)}</b><span class="note">${esc(g.quality)}</span>`;
    if (!rs.length) h += '<span class="note">Not played yet</span>';
    else {
      const vals = rs.slice(-20).map(keyVal);
      h += `<span class="pv">${esc(fmtVal(k === 'score' ? 'onTarget' : k, keyVal(last)))} <small>${esc(k === 'score' ? 'score' : METRIC[k][0].toLowerCase())}</small></span>${spark(vals, lowerBetter)}<span class="note">${rs.length} session${rs.length > 1 ? 's' : ''} · last ${esc(day(last.d))}</span>`;
    }
    h += '</div>';
  }
  h += '</div>';
  if (symptoms.length) {
    h += `<h3>Leak score <small class="note">(0 = no leaks · lower is better)</small></h3><p>${spark(symptoms.slice(0, 12).reverse().map(s => s.leak), true)} Latest ${symptoms[0].leak} on ${esc(day(symptoms[0].d))}${symptoms.length > 1 ? `, first ${symptoms[symptoms.length - 1].leak}` : ''}. A drop of 3+ points that lasts is a real improvement.</p>`;
  }
  // consistency (adherence)
  const days = new Set(sessions.filter(s => Date.now() - new Date(s.d) < 7 * 864e5).map(s => s.d.slice(0, 10))).size;
  h += `<p class="note">Trained on ${days} of the last 7 days. Aim for 3–4+ days a week (daily is fine). Strength gains take 3–5 months.</p>`;
  return h;
}
export const day = d => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ------------------------------------------------------------ symptoms (own wording; not a licensed questionnaire)
export const SYMPTOM_Q = [
  { id: 'freq', q: 'In the past week, how often did you leak urine?', opts: ['Never', 'Once', '2–3 times', 'About daily', 'Several times a day'] },
  { id: 'amt', q: 'How much, usually?', opts: ['None', 'A few drops', 'Enough to dampen underwear', 'Enough to soak through'] },
  { id: 'when', q: 'When did leaks happen? (pick any)', multi: true, opts: ['Cough / sneeze / laugh', 'Lifting baby or things', 'Running / jumping', 'Sudden urge, couldn’t make it', 'No obvious reason'] },
  { id: 'bother', q: 'How much does leaking bother you? (0 = not at all, 10 = a great deal)', range: [0, 10] },
  { id: 'red', q: 'Any of these? (pick any)', multi: true, opts: ['Heaviness, bulge or dragging in the vagina', 'Pain during or after the exercises', 'Pain with sex', 'Hard to start peeing or fully empty', 'Hard to empty bowels / straining', 'Bleeding that started with exercise'] },
];
export function leakScore(a) { return (a.freq ?? 0) + (a.amt ?? 0) + Math.round((a.bother ?? 0) / 2); } // 0–12
export const redFlags = a => (a.red || []).length > 0;
