import { GAMES, HOLD_PRESETS } from '../js/games.js';
import { PLAYERS, Player, simulate, mulberry } from '../js/sim.js';
const sig = { rS: 0.40, rB: 0.62 };
let fails = 0;
const bad = (o, path = '') => { const out = []; for (const [k, v] of Object.entries(o ?? {})) { if (typeof v === 'number' && !isFinite(v)) out.push(path + k); else if (v && typeof v === 'object') out.push(...bad(v, path + k + '.')); } return out; };
const configs = [['hold', { ...HOLD_PRESETS.daily }], ['hold', { ...HOLD_PRESETS.long }], ['hold', HOLD_PRESETS.hold], ...Object.keys(GAMES).filter(g => g !== 'hold').map(g => [g, {}])];
for (const [id, o] of configs) {
  for (const [pid, p] of Object.entries(PLAYERS)) {
    const g = GAMES[id].make({ ...o, sig, rand: mulberry(7) });
    const { result } = simulate(g, new Player(p, 3));
    const nan = bad(result);
    if (!result || nan.length) { fails++; console.log('FAIL', id, pid, nan); }
    console.log(id.padEnd(8), (o.label || '').slice(0, 14).padEnd(14), pid.padEnd(8), 'score', String(result.score).padStart(4), JSON.stringify(result.metrics), result.next ? 'next ' + JSON.stringify(result.next) : '');
  }
}
console.log(fails ? `${fails} FAILURES` : 'all games finished with finite metrics');

// ---- regression checks for bugs found while simulating play ----
const run = (id, pid, o = {}) => simulate(GAMES[id].make({ sig, rand: mulberry(7), ...o }), new Player(PLAYERS[pid], 3)).result;
const check = (name, cond) => { if (!cond) { fails++; console.log('FAIL', name); } else console.log('ok  ', name); };
check('good player passes the daily Bø set and progresses', run('hold', 'good', HOLD_PRESETS.daily).score >= 80 && run('hold', 'good', HOLD_PRESETS.daily).next?.lo > 0.7);
check('bearing down earns no hold points and never changes difficulty', (r => r.metrics.onTarget === 0 && !r.next)(run('hold', 'strainer', HOLD_PRESETS.daily)));
check('not letting go costs 30% of the hold score and blocks progression', (r => r.score <= 70 && !r.next)(run('hold', 'tight', HOLD_PRESETS.daily)));
check('fully strained power set scores 0 and does not raise your max', (r => r.score === 0 && !r.newMax)(run('power', 'strainer')));
check('flicks: failing to drop does NOT lower the line', !run('flicks', 'tight').next);
check('knack: coughing before squeezing never counts', run('knack', 'late').metrics.okCount === 0);
check('knack: squeeze-then-cough counts', run('knack', 'good').metrics.okCount === 6);
check('melt: slow relaxer scores low', run('melt', 'tight').score < 30);
check('checkup produces a full P/E/R/F card', (r => ['P', 'E', 'R', 'F'].every(k => r.perfect[k] != null))(run('checkup', 'good')));

// ---- her first real Daily set: strong start, fades to ~20%, lets go perfectly ----
{ const P = { ...PLAYERS.endurance, fatigue: 0.09 };
  const r = simulate(GAMES.hold.make({ sig, ...HOLD_PRESETS.daily }), new Player(P, 3)).result;
  console.log('     fading daily set:', r.score, JSON.stringify(r.metrics), 'next', JSON.stringify(r.next));
  check('hold: a big fade lowers the target even when let-go is perfect', r.next?.lo === 0.65);
  check('hold: a big fade adds rest between holds', r.next?.rest === 10);
  check('hold: stamina reported as a %', typeof r.metrics.stamina === 'number' && r.metrics.stamina < 60);
  check('hold: sag reported in points (positive)', r.metrics.sag > 0);
  const g = run('hold', 'good', HOLD_PRESETS.daily);
  check('hold: steady player gets no extra rest', !g.next?.rest); }
// ---- check-up: fading must show up ----
{ const g = run('checkup', 'good'), e = simulate(GAMES.checkup.make({ sig }), new Player(PLAYERS.endurance, 3)).result;
  console.log('     check-up good:', JSON.stringify(g.perfect), 'stamina', g.metrics.stamina, '| endurance-type:', JSON.stringify(e.perfect), 'stamina', e.metrics.stamina, 'holds', e.holds.map(x => x.level).join(','));
  check('checkup: a fading player shows low stamina (<80%)', e.metrics.stamina < 80 && g.metrics.stamina >= 90);
  check('checkup: fading holds do NOT count as repeat holds', e.perfect.R < g.perfect.R);
  check('checkup: quick flicks are measured fresh, so endurance-type still lands most', e.perfect.F >= 7);
  check('checkup: 10 per-hold bars are reported', e.holds.length === 10); }
// ---- Squeeze & Move ----
const mv = (pl, o = {}) => simulate(GAMES.move.make({ sig, ...o }), new Player(pl, 3)).result;
check('move: a player whose squeeze sags 40% while moving keeps ≈60–75%', (r => r.metrics.retention >= 55 && r.metrics.retention <= 78)(mv(PLAYERS.endurance)));
check('move: struggling player gets a SHORTER moving hold, not a failing one', mv(PLAYERS.endurance).next?.moving === 8);
check('move: not relaxing between reps blocks progression', !mv(PLAYERS.tight).next);
{ const a = mv({ ...PLAYERS.endurance, moveDrop: 0.3, moveArtifact: 0 }), b = mv({ ...PLAYERS.endurance, moveDrop: 0.3, moveArtifact: 0.25 });
  check(`move: the movement’s own pressure push is removed (retention ${a.metrics.retention}% vs ${b.metrics.retention}% with a big push)`, Math.abs(a.metrics.retention - b.metrics.retention) <= 5 && b.metrics.moveArtifact >= 10); }
check('move: bearing down while moving earns no moving points', mv(PLAYERS.strainer).metrics.moveOnTarget === 0);
check('move: a fading still hold is reported (stillFade < 0.8)', mv(PLAYERS.endurance).metrics.stillFade < 0.8);
// six weeks, three sessions a week, applying the game's own progression each time
let o = { moving: 10 }, hist = [];
for (let wk = 0; wk < 18; wk++) {
  const P = { ...PLAYERS.endurance, moveDrop: 0.4 - 0.33 * wk / 17, fatigue: 0.05 - 0.04 * wk / 17 };
  const r = simulate(GAMES.move.make({ sig, ...o }), new Player(P, wk + 1)).result;
  hist.push(`${r.metrics.retention}%(bar ${Math.round((o.keep ?? 0.8) * 100)}, ${o.moving}s)`); if (r.next) o = { ...o, ...r.next };
}
console.log('     retention @ moving-hold length over 18 sessions:', hist.join(' '));
check('move: as the drop shrinks, moving holds get longer', o.moving > 10);
const settingsSeq = hist.map(h => h.replace(/^\d+%/, '')); let run1 = 1, worst = 1;
for (let i = 1; i < settingsSeq.length; i++) { run1 = settingsSeq[i] === settingsSeq[i - 1] ? run1 + 1 : 1; worst = Math.max(worst, run1); }
check(`move: never stuck more than 4 sessions on one setting (worst ${worst})`, worst <= 4);
console.log(fails ? `${fails} FAILURES` : 'ALL CHECKS PASSED');

// ---- plan: "what should I do now?" ----
import { recommend } from '../js/plan.js';
const T0 = new Date('2026-12-01T08:00:00').getTime(), h = 36e5;
const sess = (game, hoursAgo, extra = {}) => ({ game, d: new Date(T0 - hoursAgo * h).toISOString(), metrics: {}, ...extra });
const names = r => r.steps.map(s => s.label).join(' → ');
const ck = sess('checkup', 24 * 10);
let r0 = recommend([], T0);
check('plan: brand-new user starts with the Check-up only', r0.checkupDay && r0.steps.length === 1 && r0.steps[0].game === 'checkup');
const after = recommend([sess('checkup', 1)], T0);
check('plan: after a Check-up, nothing else that day', after.done && after.steps.length === 0 && !after.extra);
const r1 = recommend([ck], T0); console.log('     normal day:', names(r1), `(~${r1.minutes} min)`);
check('plan: a normal day is ONE session of ~7–9 min', !r1.done && r1.minutes >= 6 && r1.minutes <= 9);
const done = recommend([sess('hold', 1, { preset: 'daily' }), ck], T0);
check('plan: after today’s session it’s done, with an optional extra set', done.done && done.steps.length === 0 && done.extra?.length >= 2);
const yMove = recommend([sess('move', 24), sess('hold', 24, { preset: 'daily' }), ck], T0); console.log('     day after a Move day:', names(yMove));
check('plan: alternates Squeeze & Move with Long hold day to day', yMove.steps.some(s => s.label.includes('Long hold')) && !yMove.steps.some(s => s.game === 'move'));
const yLong = recommend([sess('hold', 24, { preset: 'long' }), sess('move', 48), ck], T0);
check('plan: …and back to Squeeze & Move the next day', yLong.steps.some(s => s.game === 'move'));
const dueButTrained = recommend([sess('hold', 1, { preset: 'daily' }), sess('checkup', 24 * 30)], T0);
check('plan: Check-up due but already trained today → suggested for tomorrow, not today', dueButTrained.done && dueButTrained.notes.some(n => n.includes('tomorrow')));
check('plan: Check-up due on a fresh day → Check-up replaces the session', recommend([sess('checkup', 24 * 30)], T0).checkupDay);
const tightHist = [sess('hold', 20, { preset: 'daily', metrics: { relaxMissed: 3 } }), sess('move', 21, { metrics: { relaxMissed: 2 } }), ck];
check('plan: adds Melt when recent sets show missed releases', recommend(tightHist, T0).steps.at(-1).game === 'melt');
check('plan: nudges form when recent reps looked like bearing down', recommend([sess('hold', 20, { preset: 'daily', metrics: { strainReps: 2 } }), ck], T0).notes.some(n => n.includes('bearing down')));
check('plan: counts days this week toward 4', recommend([sess('hold', 24, { preset: 'daily' }), sess('hold', 48, { preset: 'daily' }), ck], T0).week.startsWith('2 of 4'));
console.log(fails ? `${fails} FAILURES` : 'ALL CHECKS PASSED');

// ---- cache-busting: every internal reference carries the same version ----
import { readFileSync, readdirSync } from 'fs';
{ const txt = ['index.html', 'preview.html', ...readdirSync('js').map(f => 'js/' + f)].map(f => readFileSync(f, 'utf8')).join('\n');
  const refs = [...txt.matchAll(/(?:from '\.\/\w+\.js|src="js\/\w+\.js|href="style\.css)(\?v=([0-9a-f]+))?/g)];
  const vers = new Set(refs.map(m => m[2]));
  check(`cache-busting: all ${refs.length} internal references stamped with one version (${[...vers].join(',')})`, refs.length >= 12 && vers.size === 1 && !vers.has(undefined)); }
console.log(fails ? `${fails} FAILURES` : 'ALL CHECKS PASSED');
// ---- redo check-up: replaced ones drop out of the plan ----
{ const T = new Date('2026-12-01T20:00:00').getTime();
  const old = { game: 'checkup', d: new Date(T - 2 * 36e5).toISOString(), metrics: {}, replaced: new Date(T - 36e5).toISOString() };
  check('redo: a replaced check-up is ignored by the plan (only the redo counts)', recommend([old], T).checkupDay === true); }
console.log(fails ? `${fails} FAILURES` : 'ALL CHECKS PASSED');
