import { GAMES, HOLD_PRESETS, STANCES } from './games.js';
import { PLAYERS, Player, simulate, mulberry } from './sim.js';
import { drawGame, resultHTML, progressHTML } from './ui.js';

const $ = id => document.getElementById(id);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const SIG = { rS: 0.40, rB: 0.62 };

// What you do / how it's scored, in plain language
const INFO = {
  hold: ['Lift into the coral zone when it arrives and keep the dot there. The <b>Daily</b> preset is the research-backed dose (Bø): 10 × 8 s near-max holds, 3 quick flicks at the end of each, 6 s rest. <b>Long hold</b> is the 60 s gentle hold from the standing return-to-running benchmark.',
    'Score = 70% time in the zone + 30% letting go within 2 s during rests. Reps flagged as bearing down earn 0. Score ≥ 80 with clean form → target +5% (up to 85%, then +1 s holds). Under 50 → target −5%.'],
  move: ['Lying on your back: first do the movement once WITHOUT squeezing (so the app can subtract the pressure the movement itself adds). Then each rep is an 8 s still hold, a rest, and the same squeeze held through 10 s of the movement: glute bridge, bridge + single-leg march, bridge reps, mini squats or marching. A dotted line shows your still hold, and the coral bar is the share of it you must keep.',
    'Headline number: <b>Kept while moving</b> = moving squeeze ÷ still squeeze (100% = no drop). Also <b>Held through</b>: seconds before the squeeze sagged below the bar. Score = 50% kept + 30% time above the bar + 20% letting go between reps. Progression: start at keeping 80%. Do well → longer moving holds (up to 20 s), then a 90% bar. Struggle → shorter holds (down to 6 s), then a lower bar. Bear-down reps earn nothing.'],
  power: ['Three all-out 5-second squeezes. The puck flies up the tower. Hit the bell (your record) for a DING.', 'Your best clean peak, as % of your calibrated max. Also: time to peak, explosiveness, consistency. A clean new record above 105% updates your calibration.'],
  flicks: ['A beat every ~2 s: snap up past the line, then drop all the way down before the next beat. Dots fill green or coral.', 'A flick counts only if it gets above the line AND drops below 20% afterwards. 10/10 → line moves up 5% (to 70%). Under 5 → line drops 5%.'],
  elevator: ['Floors at 20, 40, 60, 80% on the way up, then step down floor by floor to the ground floor.', 'Time on each floor (after a 0.8 s settle), shown separately for going up and coming down. Also overshoot and wobble.'],
  wave: ['Follow a moving line through three shapes: a smooth swell, sharp ramps and stairs.', 'Time inside the band plus tracking error, lag, and rising vs falling error. Above 80 → band gets narrower next time. Under 45 → wider.'],
  melt: ['Squeeze for 3 s, then let go so completely that the ice cube melts. Finishes with 24 s of breathing “drops” (let the pelvic floor widen on the in-breath).', 'Release speed: letting go in 0.5 s = 100, 4 s or never = 0. Also leftover tension at 3 s and your resting level during the breathing drops.'],
  breath: ['Gentle lift (35–75%) on a 5 s out-breath, full release on a 5 s in-breath. The circle shows the breath.', 'Share of time in the right zone for each breath phase. Strained exhales score 0.'],
  knack: ['At random moments you’ll hear and see COUGH!, SNEEZE! or LAUGH!. Squeeze first, then cough, and keep holding through it.', 'A trial counts if your squeeze starts ≥ 0.2 s before the cough spike and you’re still squeezing 0.4–1.2 s after it. Head start and reaction time are tracked.'],
  checkup: ['Once a month, always standing: 30 s rest → 3 power squeezes → 10 × 10 s holds with 4 s rest → 1 min break → 10 fast flicks → 3 Cough Shield trials → symptom questions.', 'A report card in plain words: <b>Strength</b> (your best squeeze), <b>Hold time</b> (seconds above half your strongest, goal 10), <b>Repeat holds</b> (of 10, how many lasted as long as the first), <b>Quick flicks</b> (of 10 clean), plus let-go time, Cough Shield and your leak score.'],
};

let speed = 2, playerId = 'endurance';
const cards = [];

function makeGame(id, seed) {
  const o = { sig: SIG, rand: mulberry(seed), stance: 'still' };
  if (id === 'hold') { const p = cards.find(c => c.id === 'hold')?.preset || 'daily'; Object.assign(o, HOLD_PRESETS[p], { preset: p }); }
  return GAMES[id].make(o);
}

function build() {
  $('cards').innerHTML = Object.entries(GAMES).map(([id, g]) => `
    <div class="card" id="c-${id}">
      <h2>${esc(g.name)} <span class="tag">${esc(g.quality)}</span></h2>
      ${id === 'hold' ? `<select id="pv-preset" style="margin-bottom:8px">${Object.entries(HOLD_PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select>` : ''}
      <div class="stage" style="height:260px"><canvas></canvas></div>
      <div class="msg" style="font-size:16px;min-height:42px"></div><p class="tip"></p>
      <p><b>What you do.</b> ${INFO[id][0]}</p>
      <p><b>Scoring.</b> ${INFO[id][1]}</p>
      <details><summary>Example results card (simulated player)</summary><div class="res"></div></details>
    </div>`).join('');
  for (const id of Object.keys(GAMES)) {
    const el = $('c-' + id), c = { id, el, cv: el.querySelector('canvas'), msg: el.querySelector('.msg'), tip: el.querySelector('.tip'), res: el.querySelector('.res'), seed: 1, visible: false, preset: 'daily' };
    cards.push(c); reset(c);
  }
  $('pv-preset').onchange = e => { const c = cards.find(x => x.id === 'hold'); c.preset = e.target.value; reset(c); };
  const io = new IntersectionObserver(es => es.forEach(e => { const c = cards.find(x => x.el === e.target); c.visible = e.isIntersecting; }), { rootMargin: '100px' });
  cards.forEach(c => io.observe(c.el));
}
function reset(c) {
  c.seed++;
  c.game = makeGame(c.id, c.seed); c.player = new Player(PLAYERS[playerId], c.seed); c.t = 0; c.hold = 0;
  // fast-forward the checkup to its interesting part
  if (c.id === 'checkup') for (let i = 0; i < 26 * 30; i++) { c.game.step(1 / 30, c.player.sample(c.game, c.t, 1 / 30)); c.t += 1 / 30; }
  // full example result from a separate complete run
  const full = simulate(makeGame(c.id, c.seed), new Player(PLAYERS[playerId], c.seed), 30).result;
  const shown = { ...full, stanceLabel: 'Standing · ' + STANCES.still.label };
  c.res.innerHTML = resultHTML(shown, null);
}
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000) * speed; last = now;
  for (const c of cards) {
    if (!c.visible) continue;
    if (!c.game.done) { const n = Math.max(1, Math.round(dt * 30)); for (let i = 0; i < n && !c.game.done; i++) { const s = c.player.sample(c.game, c.t, dt / n); c.game.step(dt / n, s); c.t += dt / n; } const vw = c.game.view(); c.msg.textContent = vw.msg; c.tip.textContent = vw.tip || ''; c.tip.style.visibility = vw.tip ? 'visible' : 'hidden'; }
    else { c.hold += dt; c.msg.textContent = `Finished · score ${c.game.result.score ?? Object.entries(c.game.result.perfect).map(([k, v]) => k + ' ' + v).join(' · ')} · restarting…`; if (c.hold > 4 * speed) reset(c); }
    drawGame(c.cv, c.game);
  }
  requestAnimationFrame(loop);
}

// ---- a pretend 10 weeks of standing training, to show the Progress view
function fakeHistory() {
  const sessions = [], symptoms = [], rand = mulberry(42), start = Date.now() - 70 * 864e5;
  const plan = ['hold', 'move', 'flicks', 'hold', 'move', 'knack', 'melt', 'power', 'elevator', 'wave', 'breath'];
  for (let d = 0; d < 70; d += 2) {
    const f = d / 70; // 0 → 1 over ten weeks: stronger, steadier, relaxes better
    const P = { strength: 0.62 + 0.4 * f, react: 0.42 - 0.12 * f, rise: 0.25 - 0.12 * f, fall: 0.45 - 0.3 * f, fatigue: 0.02 - 0.015 * f, noise: 0.045 - 0.02 * f, residual: 0.08 - 0.06 * f, knackLead: 0.1 + 0.5 * f, strain: f < 0.15 && rand() < 0.5, moveDrop: 0.4 - 0.32 * f, moveArtifact: 0.06 };
    const mvSet = { move: 'bridgeMarch', moving: Math.round(8 + 8 * f / 2) * 2 / 2 };
    const id = plan[(d / 2) % plan.length], when = new Date(start + d * 864e5).toISOString();
    const stance = f < 0.4 ? 'still' : f < 0.7 ? 'shift' : 'squat';
    const o = { sig: SIG, rand: mulberry(d + 1), stance };
    if (id === 'hold') Object.assign(o, HOLD_PRESETS.daily, { lo: Math.min(0.8, 0.5 + 0.35 * f) });
    if (id === 'move') Object.assign(o, mvSet, { stance: null });
    const r = simulate(GAMES[id].make(o), new Player(P, d + 7), 15).result;
    sessions.unshift({ ...r, d: when, pos: id === 'move' ? 'lying' : 'standing', stance: id === 'move' ? null : stance });
    if (d % 28 === 0 || d === 68) {
      const ck = simulate(GAMES.checkup.make({ sig: SIG }), new Player(P, d + 3), 15).result;
      const lk = simulate(GAMES.knack.make({ cues: ['cough', 'cough', 'cough'], rand: mulberry(d) }), new Player(P, d + 5), 15).result;
      const leak = Math.max(1, Math.round(8 - 6 * f));
      sessions.unshift({ ...ck, d: when, pos: 'standing', knack: lk.metrics.shielded, leak });
      symptoms.unshift({ d: when, leak });
    }
  }
  return { sessions, symptoms };
}

$('player').innerHTML = Object.entries(PLAYERS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
$('player').onchange = e => { playerId = e.target.value; cards.forEach(reset); };
$('speed').onchange = e => speed = +e.target.value;
build(); requestAnimationFrame(loop);
setTimeout(() => { const { sessions, symptoms } = fakeHistory(); $('fakeProgress').innerHTML = progressHTML(sessions, symptoms); }, 50);
