// Game definitions. Pure logic (no DOM) so they can be simulated in Node.
// Every game exposes: step(dt, sample) · view() · done · result
//   sample = {v, r}: v = squeeze as fraction of your calibrated max (0 relaxed, 1 max), r = tip share (form check)
import * as M from './metrics.js';

const R = (x, d = 0) => x == null || !isFinite(x) ? null : +x.toFixed(d);
const pct = x => x == null ? null : Math.round(x * 100);

// ---------------------------------------------------------------- timeline engine
// phases: [{kind:'squeeze'|'relax'|'ready'|'free', dur, lo, hi, msg, tag, rep}]
// lo/hi: number (fraction of max) or function(localT) -> number.  hi = Infinity means "at least lo".
class Timeline {
  constructor(phases) {
    let t = 0;
    this.phases = phases.map((p, i) => { const q = { ...p, i, start: t, end: t + p.dur, samples: [] }; t += p.dur; return q; });
    this.total = t; this.t = 0; this.idx = 0; this.all = [];
  }
  get cur() { return this.phases[Math.min(this.idx, this.phases.length - 1)]; }
  get done() { return this.t >= this.total; }
  step(dt, s) {
    this.t += dt;
    while (this.idx < this.phases.length - 1 && this.t >= this.phases[this.idx].end) this.idx++;
    const smp = { t: this.t, v: s.v, r: s.r ?? null };
    this.all.push(smp); this.cur.samples.push(smp);
  }
  // target band at absolute time tau (for drawing upcoming targets)
  bandAt(tau) {
    const p = this.phases.find(q => tau >= q.start && tau < q.end);
    if (!p || p.lo == null) return null;
    const lt = tau - p.start, f = x => typeof x === 'function' ? x(lt) : x;
    return { lo: f(p.lo), hi: f(p.hi ?? Infinity), kind: p.kind, tag: p.tag };
  }
  phaseAt(tau) { return this.phases.find(q => tau >= q.start && tau < q.end) ?? null; }
  zone(p) { const f = x => typeof x === 'function' ? (t => x(t - p.start)) : x; return [f(p.lo), f(p.hi ?? Infinity)]; }
  left() { return Math.max(0, this.cur.end - this.t); }
}

// Standard per-squeeze analysis. ignoreFirst = reaction time allowance (s).
function squeezeStats(tl, p, { ignoreFirst = 0.5, sig } = {}) {
  const s = p.samples.filter(x => x.t >= p.start + ignoreFirst);
  const [lo, hi] = tl.zone(p);
  const pk = M.peak(p.samples);
  return {
    onTarget: M.inZoneFrac(s, lo, hi),
    peak: pk ? pk.v : 0,
    mean: s.length ? M.mean(s.map(x => x.v)) : 0,
    hold: M.longestAbove(p.samples, typeof lo === 'number' ? lo : 0.3),
    ttp: M.timeToPeak(p.samples, p.start),
    rise: M.rateOfRise(p.samples),
    fade: M.slope(s.filter(x => x.t >= p.start + 1)),
    strain: M.looksLikeStrain(p.samples, sig),
  };
}
// Relaxation after a squeeze: time to get back near zero, and what's left at 3 s.
function relaxStats(p, prevPeak) {
  const level = Math.max(0.08, 0.1 * (prevPeak || 0));
  const rt = M.relaxTime(p.samples, p.start, level);
  return { relaxTime: rt, residual: M.residualAt(p.samples, p.start + Math.min(3, p.dur - 0.5)), relaxed: rt !== null };
}

// Standing levels: same games, harder real-life positions. Gravity + movement is when leaks happen.
export const STANCES = {
  still:  { label: 'L1 · Stand still', cue: '' },
  shift:  { label: 'L2 · Weight shifts', cue: 'sway side to side' },
  squat:  { label: 'L3 · Mini squats', cue: 'lift as you rise from a mini squat' },
  march:  { label: 'L4 · March in place', cue: 'march slowly in place' },
  carry:  { label: 'L5 · Hold baby / weight', cue: 'holding baby or a weight' },
};

// Form reminders, from the research: pelvic floor leads, belly stays light (a hard brace can push the pelvic floor
// down), soft exhale on effort (gentle beats forceful), never hold your breath, let go fully on the in-breath.
export const TIPS = {
  start: 'Pelvic floor first: squeeze & lift, then everything else',
  hold: ['Lift up and in, like holding in gas and pee', 'Lower belly light, about 20%. Don’t brace', 'Breathe out softly, like blowing out candles', 'Keep breathing. Don’t hold your breath', 'Ribs soft, shoulders down, glutes relaxed'],
  move: ['Squeeze first, THEN breathe out as you lift', 'Soft exhale as the foot lifts', 'Glutes do the bridge, pelvic floor keeps lifting inside', 'Belly light. If it bulges or pushes out, ease off', 'Keep breathing through the march'],
  standMove: ['Squeeze first, THEN breathe out as you rise', 'Soft exhale on the effort', 'Belly light. If it pushes out, ease off', 'Keep breathing'],
  relax: ['Breathe in, let the pelvic floor drop and widen', 'Belly soft, jaw soft, let everything go'],
};
export function tipFor(p, lt, move) {
  if (!p || p.dur < 3) return null;
  if (p.kind === 'squeeze') {
    if (p.tag === 'ex') return lt < 2.5 ? 'Breathe out softly, like blowing out candles' : 'Lower belly light. Don’t brace';
    if (lt < 2) return TIPS.start;
    const set = p.tag === 'move' ? (MOVES[move]?.pos === 'standing' ? TIPS.standMove : TIPS.move) : TIPS.hold;
    return set[((p.rep ?? 0) * 2 + Math.floor((lt - 2) / 4)) % set.length];   // rotate across reps so every tip shows up
  }
  if (p.kind === 'relax' && p.tag !== 'in' && lt < 4) return TIPS.relax[(p.i ?? 0) % 2];
  return null;
}

const READY = (msg = 'Stand tall, feet hip-width. Relax completely…', dur = 3) => ({ kind: 'ready', dur, lo: 0, hi: 0.15, msg, tag: 'ready' });

// Base class for timeline games
class TimelineGame {
  constructor(id, title, phases, opts) { this.id = id; this.title = title; this.tl = new Timeline(phases); this.opts = opts; this.events = []; }
  get done() { return this.tl.done; }
  get t() { return this.tl.t; }
  step(dt, s) { if (!this.done) { this.tl.step(dt, s); this.onStep?.(s); } if (this.done && !this.result) this.result = this.finish(); }
  bandAt(tau) { return this.tl.bandAt(tau); }
  view() {
    const p = this.tl.cur, left = this.tl.left();
    const last = this.tl.all[this.tl.all.length - 1], v = last ? last.v : 0;
    const [lo, hi] = p.lo == null ? [null, null] : this.tl.zone(p);
    const L = typeof lo === 'function' ? lo(this.t) : lo, H = typeof hi === 'function' ? hi(this.t) : hi;
    const inside = L != null && v >= L && v <= H;
    let msg = typeof p.msg === 'function' ? p.msg(left, v, inside) : (p.msg || '');
    if (p.kind === 'squeeze' && L != null && !p.noHint) msg = inside ? `${p.msg || 'Hold it'} · ${Math.ceil(left)}s` : v < L ? `Lift higher · ${Math.ceil(left)}s` : `A bit lighter · ${Math.ceil(left)}s`;
    if (p.kind === 'relax' && !p.msg) msg = `Let go completely · ${Math.ceil(left)}s`;
    const st = STANCES[this.opts?.stance];
    return { tip: this.opts?.tips === false ? null : tipFor(p, this.t - p.start, this.c?.move), stance: st && st.cue && p.kind === 'squeeze' ? st.cue : null, msg, kind: p.kind, inside, rep: p.rep, reps: this.reps, frac: 1 - left / p.dur, hud: this.hud?.() };
  }
}

// ---------------------------------------------------------------- 1. Hold the Line (and presets)
export const HOLD_PRESETS = {
  daily:  { label: 'Daily strength (Bø protocol)', hold: 8, rest: 6, reps: 10, lo: 0.7, band: false, flicks: 3 },
  hold:   { label: 'Steady hold', hold: 10, rest: 10, reps: 6, lo: 0.6, band: false, flicks: 0 },
  long:   { label: 'Long hold · 60 s at 30–50%', hold: 60, rest: 10, reps: 1, lo: 0.3, hi: 0.5, band: true, flicks: 0 },
};
export class Hold extends TimelineGame {
  constructor(o = {}) {
    const c = { ...HOLD_PRESETS.hold, ...o };
    const hi = c.band ? (c.hi ?? Math.min(1.1, c.lo + (c.width ?? 0.25))) : Infinity;
    const ph = [READY()];
    for (let r = 1; r <= c.reps; r++) {
      ph.push({ kind: 'squeeze', dur: c.hold, lo: c.lo, hi, rep: r, tag: 'hold', msg: 'Squeeze, lift & hold' });
      for (let k = 0; k < c.flicks; k++) {
        ph.push({ kind: 'squeeze', dur: 0.7, lo: 0.6, hi: Infinity, rep: r, tag: 'flick', msg: 'Flick!', noHint: true });
        ph.push({ kind: 'relax', dur: 0.7, lo: 0, hi: 0.25, rep: r, tag: 'flickoff', msg: 'Drop' });
      }
      ph.push({ kind: 'relax', dur: r < c.reps ? c.rest : Math.min(c.rest, 5), lo: 0, hi: 0.15, rep: r, tag: 'rest', msg: (l) => `Let go completely · ${Math.ceil(l)}s` });
    }
    super('hold', c.label, ph, c); this.c = c; this.reps = c.reps;
  }
  hud() { return { kind: 'ring' }; }
  finish() {
    const tl = this.tl, sig = this.opts.sig, holds = tl.phases.filter(p => p.tag === 'hold');
    const reps = holds.map(p => ({ ...squeezeStats(tl, p, { sig }), rep: p.rep }));
    const rests = tl.phases.filter(p => p.tag === 'rest').map(p => relaxStats(p, reps[p.rep - 1]?.peak));
    const fl = tl.phases.filter(p => p.tag === 'flick');
    const flicksOk = fl.filter(p => (M.peak(p.samples)?.v ?? 0) >= 0.6).length;
    const holdScore = M.mean(reps.map(r => r.strain ? 0 : r.onTarget));
    const relaxScore = rests.length ? rests.filter(r => r.relaxed && r.relaxTime <= 2).length / rests.length : 1;
    const score = 0.7 * holdScore + 0.3 * relaxScore;
    const res = {
      game: 'hold', preset: this.c.preset, title: this.title,
      score: pct(score), settings: { hold: this.c.hold, reps: this.c.reps, lo: pct(this.c.lo), band: this.c.band },
      metrics: {
        onTarget: pct(holdScore), relaxed: pct(relaxScore), avgLevel: pct(M.mean(reps.map(r => r.mean))), peak: pct(Math.max(...reps.map(r => r.peak))),
        bestHold: R(Math.max(...reps.map(r => r.hold)), 1), fatigue: R(M.fatigueIndex(reps.map(r => r.mean)), 2),
        fadePerSec: R(M.mean(reps.map(r => r.fade)) * 100, 1), relaxMedian: R(M.median(rests.map(r => r.relaxTime).filter(x => x != null)), 2),
        relaxMissed: rests.filter(r => !r.relaxed).length, flicks: fl.length ? `${flicksOk}/${fl.length}` : null,
        strainReps: reps.filter(r => r.strain).length,
      },
      reps: reps.map(r => ({ onTarget: pct(r.onTarget), mean: pct(r.mean), peak: pct(r.peak), hold: R(r.hold, 1), strain: r.strain })),
    };
    // progression: only when the set was clean (no straining, relaxed between reps)
    const clean = !res.metrics.strainReps && !res.metrics.relaxMissed;
    if (score >= 0.8 && clean) res.next = this.c.band ? { hold: Math.min(90, this.c.hold + 10) } : this.c.lo < 0.85 ? { lo: Math.round((this.c.lo + 0.05) * 100) / 100 } : { hold: Math.min(12, this.c.hold + 1) };
    else if (score < 0.5 && res.metrics.strainReps <= reps.length / 2 && holdScore < 0.5) res.next = { lo: Math.max(0.3, Math.round((this.c.lo - 0.05) * 100) / 100) };
    return res;
  }
}

// ---------------------------------------------------------------- 2. Power Punch
export class Power extends TimelineGame {
  constructor(o = {}) {
    const n = o.reps ?? 3, ph = [READY()];
    for (let r = 1; r <= n; r++) {
      ph.push({ kind: 'squeeze', dur: 5, lo: 0.15, hi: Infinity, rep: r, tag: 'max', noHint: true, msg: l => `MAX squeeze & lift! · ${Math.ceil(l)}s` });
      if (r < n) ph.push({ kind: 'relax', dur: 10, lo: 0, hi: 0.15, rep: r, tag: 'rest', msg: l => `Rest, breathe · ${Math.ceil(l)}s` });
    }
    super('power', 'Power Punch', ph, o); this.reps = n; this.best = 0;
  }
  onStep(s) { if (this.tl.cur.tag === 'max') this.best = Math.max(this.best, s.v); }
  hud() { return { kind: 'bell', best: this.best, record: this.opts.record ?? 1 }; }
  finish() {
    const tl = this.tl, sig = this.opts.sig, reps = tl.phases.filter(p => p.tag === 'max').map(p => squeezeStats(tl, p, { sig }));
    const clean = reps.filter(r => !r.strain), pool = clean.length ? clean : reps;
    const best = Math.max(...pool.map(r => r.peak));
    const bi = pool.findIndex(r => r.peak === best);
    return {
      game: 'power', title: this.title, score: clean.length ? pct(best) : 0,
      metrics: { peak: pct(best), timeToPeak: R(pool[bi].ttp, 2), rise: R(pool[bi].rise * 100, 0), consistency: R(M.clamp(1 - M.cv(reps.map(r => r.peak)), 0, 1) * 100, 0), strainReps: reps.length - clean.length },
      reps: reps.map(r => ({ peak: pct(r.peak), ttp: R(r.ttp, 2), strain: r.strain })),
      newMax: best > 1.05 && clean.length > 0 ? best : null,
    };
  }
}

// ---------------------------------------------------------------- 3. Quick Flicks
export class Flicks extends TimelineGame {
  constructor(o = {}) {
    const n = o.reps ?? 10, on = o.on ?? 1, off = o.off ?? 1.2, thr = o.thr ?? 0.5, ph = [READY('Stand tall. Get ready to flick…', 3)];
    for (let r = 1; r <= n; r++) {
      ph.push({ kind: 'squeeze', dur: on, lo: thr, hi: Infinity, rep: r, tag: 'on', noHint: true, msg: 'FLICK!' });
      ph.push({ kind: 'relax', dur: off, lo: 0, hi: 0.2, rep: r, tag: 'off', msg: 'drop…' });
    }
    super('flicks', 'Quick Flicks', ph, o); this.reps = n; this.thr = thr; this.hits = [];
  }
  onStep() {
    // live verdict for the previous beat once its release window has passed
    const p = this.tl.cur; if (p.tag !== 'on' || p.samples.length !== 1) return;
    const prevOff = this.tl.phases[p.i - 1], prevOn = this.tl.phases[p.i - 2];
    if (prevOff?.tag === 'off' && prevOn) this.hits.push(this.judge(prevOn, prevOff));
  }
  judge(on, off) {
    // contraction may spill a little into the off window (reaction time)
    const pk = M.peak([...on.samples, ...M.within(off.samples, off.start, off.start + 0.35)])?.v ?? 0;
    const tail = M.within(off.samples, off.start + 0.4, off.end + 0.01).map(s => s.v);
    const low = tail.length ? Math.min(...tail) : 1;
    return { peak: pk, up: pk >= this.thr, down: low <= 0.2, ok: pk >= this.thr && low <= 0.2, release: M.relaxTime(off.samples, off.start, 0.2, 0.1) };
  }
  hud() { return { kind: 'beats', hits: this.hits.map(h => h.ok), total: this.reps }; }
  finish() {
    const ph = this.tl.phases, all = [];
    for (let i = 1; i < ph.length; i++) if (ph[i].tag === 'on') all.push(this.judge(ph[i], ph[i + 1]));
    const ok = all.filter(h => h.ok).length;
    return {
      game: 'flicks', title: this.title, score: Math.round(100 * ok / all.length),
      metrics: { valid: `${ok}/${all.length}`, validCount: ok, missedUp: all.filter(h => !h.up).length, missedDown: all.filter(h => h.up && !h.down).length,
        avgPeak: pct(M.mean(all.map(h => h.peak))), fatigue: R(M.fatigueIndex(all.map(h => h.peak)), 2), release: R(M.median(all.map(h => h.release).filter(x => x != null)), 2) },
      reps: all.map(h => ({ peak: pct(h.peak), ok: h.ok })), settings: { thr: pct(this.thr) },
      next: ok === all.length && this.thr < 0.7 ? { thr: Math.round((this.thr + 0.05) * 100) / 100 } : all.filter(h => !h.up).length > all.length / 2 && this.thr > 0.35 ? { thr: Math.round((this.thr - 0.05) * 100) / 100 } : null,
    };
  }
}

// ---------------------------------------------------------------- 4. Elevator
export class Elevator extends TimelineGame {
  constructor(o = {}) {
    const top = o.top ?? 0.8, n = o.floors ?? 4, dwell = o.dwell ?? 3, tol = o.tol ?? 0.08;
    const floors = Array.from({ length: n }, (_, i) => (i + 1) * top / n);
    const seq = [...floors, ...floors.slice(0, -1).reverse(), 0];
    const ph = [READY()];
    seq.forEach((f, i) => ph.push({ kind: f ? 'squeeze' : 'relax', dur: f ? dwell : 4, lo: Math.max(0, f - tol), hi: f ? f + tol : 0.12, tag: 'floor', floor: f,
      dir: i < n ? 'up' : 'down', rep: i + 1, noHint: true,
      msg: (l, v, inn) => f === 0 ? `Ground floor: let go completely · ${Math.ceil(l)}s` : `${i < n ? 'Up' : 'Down'} to floor ${Math.round(f * n / top)} · ${inn ? 'hold it there' : v < f ? 'a little higher' : 'a little lower'}` }));
    super('elevator', 'Elevator', ph, o); this.reps = seq.length; this.tol = tol;
  }
  hud() { const p = this.tl.cur; return { kind: 'floor', floor: p.floor, dir: p.dir }; }
  finish() {
    const fl = this.tl.phases.filter(p => p.tag === 'floor').map(p => {
      const settle = p.samples.filter(s => s.t >= p.start + 0.8);
      const early = M.within(p.samples, p.start, p.start + 1.5);
      return { f: p.floor, dir: p.dir, onTarget: M.inZoneFrac(settle, p.lo, p.hi), err: settle.length ? M.mean(settle.map(s => Math.abs(s.v - p.floor))) : 1,
        overshoot: p.dir === 'up' ? Math.max(0, (M.peak(early)?.v ?? 0) - p.floor) : Math.max(0, p.floor - Math.min(...early.map(s => s.v), 9)),
        wobble: M.sd(settle.map(s => s.v)) };
    });
    const up = fl.filter(f => f.dir === 'up'), dn = fl.filter(f => f.dir === 'down');
    const sc = M.mean(fl.map(f => f.onTarget));
    return {
      game: 'elevator', title: this.title, score: pct(sc),
      metrics: { onTarget: pct(sc), upAccuracy: pct(M.mean(up.map(f => f.onTarget))), downAccuracy: pct(M.mean(dn.map(f => f.onTarget))),
        avgError: pct(M.mean(fl.map(f => f.err))), overshoot: pct(M.mean(fl.map(f => f.overshoot))), wobble: pct(M.mean(fl.map(f => f.wobble))) },
      reps: fl.map(f => ({ floor: pct(f.f), dir: f.dir, onTarget: pct(f.onTarget) })),
    };
  }
}

// ---------------------------------------------------------------- 5. Trace the Wave
export class Wave extends TimelineGame {
  constructor(o = {}) {
    const tol = o.tol ?? 0.1, lo = o.min ?? 0.15, hi = o.max ?? 0.65, mid = (lo + hi) / 2, amp = (hi - lo) / 2;
    // three shapes: smooth swell, sharp triangle ramps, staircase
    const sine = t => mid - amp * Math.cos(2 * Math.PI * t / 6);
    const tri = t => { const u = (t % 5) / 5; return lo + (hi - lo) * (u < 0.5 ? u * 2 : 2 - u * 2); };
    const stair = t => lo + (hi - lo) * [0, 1 / 3, 2 / 3, 1, 2 / 3, 1 / 3][Math.floor(t / 1.5) % 6];
    const seg = (fn, dur, name) => ({ kind: 'squeeze', dur, lo: t => Math.max(0, fn(t) - tol), hi: t => fn(t) + tol, fn, tag: 'wave', shape: name, noHint: true,
      msg: (l, v, inn) => inn ? `Ride the wave · ${name}` : 'Follow the line' });
    super('wave', 'Trace the Wave', [READY('Watch the line coming from the right…', 3), seg(sine, 12, 'swell'), seg(tri, 10, 'ramps'), seg(stair, 9, 'stairs'), { kind: 'relax', dur: 3, lo: 0, hi: 0.15, tag: 'end', msg: 'Let go' }], o);
    this.reps = 3; this.tol = tol;
  }
  hud() { return { kind: 'none' }; }
  finish() {
    const segs = this.tl.phases.filter(p => p.tag === 'wave').map(p => {
      const tgt = t => p.fn(t - p.start), s = p.samples.filter(x => x.t >= p.start + 0.5);
      // rising vs falling parts of the target
      const rising = s.filter(x => tgt(x.t + 0.05) > tgt(x.t)), falling = s.filter(x => tgt(x.t + 0.05) < tgt(x.t));
      return { shape: p.shape, rmse: M.rmse(s, tgt), lag: M.lag(s, tgt), inZone: M.inZoneFrac(s, t => tgt(t) - this.tol, t => tgt(t) + this.tol),
        upErr: rising.length ? M.rmse(rising, tgt) : null, downErr: falling.length ? M.rmse(falling, tgt) : null };
    });
    const sc = M.mean(segs.map(s => s.inZone));
    return {
      game: 'wave', title: this.title, score: pct(sc),
      metrics: { onTarget: pct(sc), error: pct(M.mean(segs.map(s => s.rmse))), lag: R(M.mean(segs.map(s => s.lag)), 2),
        risingError: pct(M.mean(segs.map(s => s.upErr).filter(x => x != null))), fallingError: pct(M.mean(segs.map(s => s.downErr).filter(x => x != null))) },
      reps: segs.map(s => ({ shape: s.shape, onTarget: pct(s.inZone), error: pct(s.rmse) })),
      next: sc > 0.8 ? { tol: Math.max(0.05, this.tol - 0.02) } : sc < 0.45 ? { tol: Math.min(0.15, this.tol + 0.02) } : null,
    };
  }
}

// ---------------------------------------------------------------- 6. Melt (relaxation / down-training)
export class Melt extends TimelineGame {
  constructor(o = {}) {
    const n = o.reps ?? 5, ph = [READY()];
    for (let r = 1; r <= n; r++) {
      ph.push({ kind: 'squeeze', dur: 3, lo: 0.5, hi: Infinity, rep: r, tag: 'sq', msg: 'Squeeze' });
      ph.push({ kind: 'relax', dur: 7, lo: 0, hi: 0.1, rep: r, tag: 'melt', noHint: true, msg: (l, v) => v <= 0.1 ? 'Melting… stay soft' : 'Let go… soften, belly loose' });
    }
    ph.push({ kind: 'relax', dur: 24, lo: 0, hi: 0.08, tag: 'drop', noHint: true,
      msg: l => { const k = (24 - l) % 10; return k < 4 ? 'Breathe in… let the pelvic floor drop and widen' : 'Long breath out… stay soft'; } });
    super('melt', 'Melt', ph, o); this.reps = n;
  }
  hud() {
    const p = this.tl.cur;
    if (p.tag === 'melt') {
      const prev = this.tl.phases[p.i - 1], pk = M.peak(prev.samples)?.v ?? 0.5;
      const lvl = Math.max(0.08, 0.1 * pk), cur = p.samples[p.samples.length - 1]?.v ?? 1;
      const inT = p.samples.filter(s => s.v <= lvl).length / Math.max(1, p.samples.length);
      return { kind: 'ice', melt: Math.min(1, inT * 1.4), soft: cur <= lvl };
    }
    if (p.tag === 'drop') { const k = (this.t - p.start) % 10; return { kind: 'breath', inhale: k < 4, frac: k < 4 ? k / 4 : 1 - (k - 4) / 6 }; }
    return { kind: 'ice', melt: 0 };
  }
  finish() {
    const ph = this.tl.phases, reps = [];
    for (const p of ph) if (p.tag === 'melt') { const pk = M.peak(ph[p.i - 1].samples)?.v ?? 0; reps.push({ peak: pk, ...relaxStats(p, pk) }); }
    const drop = ph.find(p => p.tag === 'drop'), ready = ph[0];
    const base = M.mean(ready.samples.slice(-20).map(s => s.v)), dropLvl = M.mean(drop.samples.filter(s => s.t > drop.start + 4).map(s => s.v));
    const rts = reps.map(r => r.relaxTime);
    // score: fast + complete releases. 0.5 s → 100, 4 s or never → 0
    const sc = M.mean(rts.map(t => t == null ? 0 : M.clamp(1 - (t - 0.5) / 3.5, 0, 1)));
    return {
      game: 'melt', title: this.title, score: pct(sc),
      metrics: { relaxMedian: R(M.median(rts.filter(x => x != null)), 2), relaxMissed: rts.filter(x => x == null).length,
        residual: pct(M.mean(reps.map(r => r.residual ?? 0))), dropLevel: pct(dropLvl), drift: pct(dropLvl - base) },
      reps: reps.map(r => ({ peak: pct(r.peak), relaxTime: R(r.relaxTime, 2), residual: pct(r.residual) })),
    };
  }
}

// ---------------------------------------------------------------- 7. Breath Sync
export class Breath extends TimelineGame {
  constructor(o = {}) {
    const n = o.reps ?? 8, ex = o.ex ?? 5, inh = o.inh ?? 5, ph = [READY('Breathe normally. Relax…', 4)];
    for (let r = 1; r <= n; r++) {
      ph.push({ kind: 'squeeze', dur: ex, lo: 0.35, hi: 0.75, rep: r, tag: 'ex', msg: 'Breathe OUT… lift gently' });
      ph.push({ kind: 'relax', dur: inh, lo: 0, hi: 0.15, rep: r, tag: 'in', msg: 'Breathe IN… let go' });
    }
    super('breath', 'Breath Sync', ph, o); this.reps = n;
  }
  hud() { const p = this.tl.cur, f = (this.t - p.start) / p.dur; return { kind: 'breath', inhale: p.tag !== 'ex', frac: p.tag === 'ex' ? 1 - f : p.tag === 'in' ? f : 0.3 }; }
  finish() {
    const tl = this.tl, sig = this.opts.sig, ex = tl.phases.filter(p => p.tag === 'ex').map(p => squeezeStats(tl, p, { ignoreFirst: 0.8, sig }));
    const ins = tl.phases.filter(p => p.tag === 'in').map(p => ({ ...relaxStats(p, 0.5), onTarget: M.inZoneFrac(p.samples.filter(s => s.t > p.start + 0.8), 0, 0.15) }));
    const sc = M.mean([...ex.map(e => e.strain ? 0 : e.onTarget), ...ins.map(i => i.onTarget)]);
    return {
      game: 'breath', title: this.title, score: pct(sc),
      metrics: { inSync: pct(sc), exhaleOnTarget: pct(M.mean(ex.map(e => e.onTarget))), inhaleRelaxed: pct(M.mean(ins.map(i => i.onTarget))),
        relaxMedian: R(M.median(ins.map(i => i.relaxTime).filter(x => x != null)), 2), strainReps: ex.filter(e => e.strain).length },
      reps: ex.map((e, i) => ({ exhale: pct(e.onTarget), inhale: pct(ins[i]?.onTarget) })),
    };
  }
}

// ---------------------------------------------------------------- 8. Cough Shield (the Knack)
// Not a fixed timeline: random cue times. Each trial: wait (relaxed) → cue → 4 s response window → 3 s recover.
export const KNACK_CUES = {
  cough: { text: 'COUGH!', spike: true, hint: 'Squeeze first, then cough, keep holding' },
  sneeze: { text: 'SNEEZE! (fake a big “ha-CHOO” huff)', spike: true, hint: 'Squeeze first, then huff, keep holding' },
  lift: { text: 'LIFT THE BABY!', spike: false, hint: 'Squeeze before you bend and lift' },
  laugh: { text: 'LAUGH! (3 big “ha”s)', spike: true, hint: 'Squeeze first, keep holding through the laugh' },
};
export class Knack {
  constructor(o = {}) {
    this.id = 'knack'; this.title = 'Cough Shield'; this.opts = o;
    const rnd = o.rand ?? Math.random, mix = o.cues ?? ['cough', 'cough', 'cough', 'sneeze', 'cough', 'laugh'];
    this.trials = mix.map((c, i) => ({ cue: c, wait: 2.5 + rnd() * 3.5, n: i + 1 }));
    let t = 3; for (const tr of this.trials) { tr.cueAt = t + tr.wait; tr.end = tr.cueAt + 4; t = tr.end + 2.5; }
    this.total = t; this.t = 0; this.samples = []; this.done = false; this.reps = this.trials.length; this.verdicts = [];
    this.minRate = o.coughRate ? o.coughRate * 0.6 : 5; // fraction of max per second
  }
  get cur() { return this.trials.find(tr => this.t < tr.end + 2.5) ?? this.trials[this.trials.length - 1]; }
  step(dt, s) {
    if (this.done) return;
    this.t += dt; this.samples.push({ t: this.t, v: s.v, r: s.r ?? null });
    for (const tr of this.trials) if (!tr.v && this.t >= tr.end) { tr.v = this.judge(tr); this.verdicts.push(tr.v); }
    if (this.t >= this.total) { this.done = true; this.result = this.finish(); }
  }
  bandAt() { return null; }
  judge(tr) {
    const win = M.within(this.samples, tr.cueAt - 0.2, tr.end);
    if (!KNACK_CUES[tr.cue].spike) {
      const on = M.onsetTime(win, 0.3);
      const held = on != null ? M.longestAbove(M.within(win, on, tr.end), 0.25) : 0;
      return { ok: on != null && on - tr.cueAt <= 1.5 && held >= 2.5, react: on != null ? on - tr.cueAt : null, lead: null, cue: tr.cue };
    }
    const sp = M.findSpike(win, this.minRate);
    if (!sp) return { ok: false, noSpike: true, cue: tr.cue, react: null, lead: null };
    const before = win.filter(s => s.t < sp.t - 0.05);
    const on = M.onsetTime(before, 0.25);
    const lead = on != null ? sp.t - on : null;
    const after = M.within(win, sp.t + 0.4, sp.t + 1.2).map(s => s.v);
    const held = after.length > 0 && Math.min(...after) >= 0.2;
    return { ok: lead != null && lead >= 0.2 && held, lead, held, react: on != null ? on - tr.cueAt : null, cue: tr.cue, early: on != null && on < tr.cueAt - 0.1 };
  }
  view() {
    const tr = this.cur, v = this.samples[this.samples.length - 1]?.v ?? 0;
    let msg, cue = null;
    if (this.t < 3) msg = 'Stand tall, relaxed. Wait for the cue…';
    else if (this.t < tr.cueAt) msg = v > 0.25 ? 'Relax – wait for it…' : `Ready… (${tr.n} of ${this.reps})`;
    else if (this.t < tr.end) { cue = KNACK_CUES[tr.cue].text; msg = KNACK_CUES[tr.cue].hint; }
    else { const vd = tr.v; msg = !vd ? '' : vd.ok ? `Shielded! Squeezed ${vd.lead != null ? vd.lead.toFixed(1) + 's' : ''} before` : vd.noSpike ? 'Didn’t catch a cough – a bit stronger next time' : vd.lead != null && vd.lead < 0.2 ? 'Squeeze a moment earlier' : vd.lead == null ? 'Squeeze before the cough' : 'Keep holding through it'; }
    const st = STANCES[this.opts?.stance];
    const tip = this.opts?.tips === false ? null : cue ? 'Pelvic floor first, then the cough. Keep lifting through it' : this.t >= tr.end ? 'Let go fully, belly soft' : null;
    return { tip, stance: st && st.cue ? st.cue : null, msg, kind: cue ? 'squeeze' : 'relax', inside: false, rep: tr.n, reps: this.reps, frac: 0, hud: { kind: 'knack', cue, verdicts: this.verdicts.map(x => x.ok) } };
  }
  finish() {
    const v = this.trials.map(t => t.v ?? this.judge(t)), counted = v.filter(x => !x.noSpike), ok = v.filter(x => x.ok).length;
    return {
      game: 'knack', title: this.title, score: Math.round(100 * ok / v.length),
      metrics: { shielded: `${ok}/${v.length}`, okCount: ok, avgLead: R(M.mean(counted.map(x => x.lead).filter(x => x != null)), 2),
        reaction: R(M.median(v.map(x => x.react).filter(x => x != null)), 2), notDetected: v.filter(x => x.noSpike).length, letGo: counted.filter(x => x.lead >= 0.2 && !x.held).length },
      reps: v.map(x => ({ cue: x.cue, ok: x.ok, lead: R(x.lead, 2) })),
    };
  }
}

// ---------------------------------------------------------------- 9. Check-up (PERFECT-inspired monthly test)
export class Checkup extends TimelineGame {
  // Order: rest → strength → quick flicks (while fresh) → 1-min break → 10 long holds.
  // Flicks used to come after the long holds, which measured tiredness instead of speed.
  constructor(o = {}) {
    const ph = [{ kind: 'ready', dur: 30, lo: 0, hi: 0.15, tag: 'base', msg: l => `Resting level: stand still, relax fully · ${Math.ceil(l)}s` }];
    for (let r = 1; r <= 3; r++) { ph.push({ kind: 'squeeze', dur: 5, lo: 0.15, hi: Infinity, rep: r, tag: 'P', noHint: true, msg: l => `STRENGTH ${r} of 3 · squeeze & lift as hard as you can · ${Math.ceil(l)}s` }); ph.push({ kind: 'relax', dur: r < 3 ? 10 : 20, lo: 0, hi: 0.15, tag: 'rest', msg: l => r < 3 ? `Rest · ${Math.ceil(l)}s` : `Rest. Quick flicks next · ${Math.ceil(l)}s` }); }
    for (let r = 1; r <= 10; r++) { ph.push({ kind: 'squeeze', dur: 1, lo: 0.5, hi: Infinity, rep: r, tag: 'F', noHint: true, msg: `QUICK FLICK ${r} of 10 · squeeze fast!` }); ph.push({ kind: 'relax', dur: 1.5, lo: 0, hi: 0.2, tag: 'Foff', msg: 'let go fully' }); }
    ph.push({ kind: 'relax', dur: 60, lo: 0, hi: 0.15, tag: 'break', msg: l => `One-minute break. 10 long holds next · ${Math.ceil(l)}s` });
    for (let r = 1; r <= 10; r++) { ph.push({ kind: 'squeeze', dur: 10, lo: 0.15, hi: Infinity, rep: r, tag: 'E', noHint: true, msg: l => `LONG HOLD ${r} of 10 · as strong as you can, as long as you can · ${Math.ceil(l)}s` }); ph.push({ kind: 'relax', dur: 4, lo: 0, hi: 0.15, tag: 'rest', msg: l => `Rest · ${Math.ceil(l)}s` }); }
    ph.push({ kind: 'relax', dur: 5, lo: 0, hi: 0.15, tag: 'end', msg: 'Done with the squeezes. Relax.' });
    super('checkup', 'Monthly Check-up', ph, o); this.reps = null;
  }
  hud() { const p = this.tl.cur; return { kind: 'stage', stage: { base: 'Rest', P: 'Strength', E: 'Long holds', F: 'Quick flicks', Foff: 'Quick flicks', break: 'Break', rest: '', end: '' }[p.tag] }; }
  finish() {
    const ph = this.tl.phases, sig = this.opts.sig;
    const P = ph.filter(p => p.tag === 'P').map(p => squeezeStats(this.tl, p, { sig }));
    const best = Math.max(...P.map(p => p.peak));
    // quick flicks: up past the line, then let go. The line is 50% of max, or 60% of today's strength if lower
    // (so a calibration that overestimates your max doesn't make every flick "miss").
    const fThr = Math.min(0.5, 0.6 * best), F = [];
    ph.forEach((p, i) => { if (p.tag === 'F') { const off = ph[i + 1]; const pk = M.peak([...p.samples, ...M.within(off.samples, off.start, off.start + 0.35)])?.v ?? 0; const tail = M.within(off.samples, off.start + 0.5, off.end + 0.01).map(s => s.v); F.push(pk >= fThr && tail.length > 0 && Math.min(...tail) <= Math.max(0.2, 0.35 * pk)); } });
    // long holds: every hold is judged against the FIRST hold's strength, so fading shows up
    const Eph = ph.filter(p => p.tag === 'E');
    const pk1 = M.peak(Eph[0].samples)?.v ?? 0, bar = Math.max(0.1, pk1 * 0.5);
    const E = Eph.map(p => { const s = p.samples.filter(x => x.t >= p.start + 1); return { pk: M.peak(p.samples)?.v ?? 0, mean: s.length ? M.mean(s.map(x => x.v)) : 0, hold: M.longestAbove(p.samples, bar) }; });
    const e1 = E[0].hold, Rn = E.filter(e => e1 > 0 && e.hold >= 0.8 * e1).length;
    const stamina = M.fatigueIndex(E.map(e => e.mean));
    const rests = ph.filter(p => p.tag === 'rest').map(p => relaxStats(p, 0.6));
    const base = ph[0].samples.filter(s => s.t > 10).map(s => s.v);
    return {
      game: 'checkup', title: this.title, score: null, v: 2,
      perfect: { P: pct(best), E: R(e1, 1), R: Rn, F: F.filter(Boolean).length },
      metrics: { power: pct(best), timeToPeak: R(P.find(p => p.peak === best)?.ttp, 2), endurance: R(e1, 1), reps: Rn, fast: F.filter(Boolean).length,
        stamina: stamina == null ? null : pct(stamina), relaxMedian: R(M.median(rests.map(r => r.relaxTime).filter(x => x != null)), 2),
        restLevel: pct(M.mean(base)), restWobble: pct(M.sd(base)), strainReps: P.filter(p => p.strain).length },
      holds: E.map(e => ({ level: pct(e.mean), held: R(e.hold, 1) })),
    };
  }
}


// ---------------------------------------------------------------- 10. Squeeze & Move (hold while the body works)
// Each rep: a still hold, then the same squeeze held through a movement. The headline number is RETENTION:
// how much of your still-hold strength survives the movement. A "move only" round first measures how much the
// movement itself pushes on the sensor (belly/glute pressure), and that offset is subtracted from moving holds.
export const MOVES = {
  bridgeMarch: { label: 'Glute bridge + single-leg march', pos: 'lying', setup: 'Lie on your back, knees bent, feet hip-width.',
    cue: t => { const k = Math.floor(t / 2); return t < 1.5 ? 'Lift your hips into a bridge…' : k % 2 ? 'March: LEFT foot up… down' : 'March: RIGHT foot up… down'; } },
  bridge: { label: 'Glute bridge hold', pos: 'lying', setup: 'Lie on your back, knees bent, feet hip-width.', cue: t => t < 1.5 ? 'Lift your hips into a bridge…' : 'Hold the bridge, keep lifting inside' },
  bridgeReps: { label: 'Bridge reps (up 2 s, down 2 s)', pos: 'lying', setup: 'Lie on your back, knees bent, feet hip-width.', cue: t => Math.floor(t / 2) % 2 ? 'Lower slowly… keep the squeeze' : 'Bridge UP… keep the squeeze' },
  squat: { label: 'Mini squats', pos: 'standing', setup: 'Stand tall, feet hip-width.', cue: t => Math.floor(t / 2) % 2 ? 'Rise up… keep lifting' : 'Sit back into a mini squat…' },
  march: { label: 'March in place', pos: 'standing', setup: 'Stand tall, feet hip-width.', cue: t => Math.floor(t / 1.5) % 2 ? 'Left knee up' : 'Right knee up' },
};
export class Move extends TimelineGame {
  constructor(o = {}) {
    const mv = MOVES[o.move] ?? MOVES.bridgeMarch, n = o.reps ?? 5, still = o.still ?? 8, moving = o.moving ?? 10, lo = o.lo ?? 0.5;
    const keep = o.keep ?? 0.8, refs = {};
    // moving target = keep × the still hold you just did (filled in live once that still hold ends)
    const moveLo = r => () => refs[r] != null ? Math.max(0.2, keep * refs[r]) : lo;
    const ph = [
      READY(mv.setup + ' Relax completely. Remember: squeeze first, soft exhale on the lift, belly light.', 5),
      { kind: 'free', dur: 8, tag: 'mbase', msg: l => `Do the movement WITHOUT squeezing (measures the movement itself) · ${mv.cue(8 - l)}` },
      { kind: 'relax', dur: 5, lo: 0, hi: 0.15, tag: 'prep', msg: l => `Rest, back to the start · ${Math.ceil(l)}s` },
    ];
    for (let r = 1; r <= n; r++) {
      ph.push({ kind: 'squeeze', dur: still, lo, hi: Infinity, rep: r, tag: 'still', msg: 'Still: squeeze, lift & hold' });
      ph.push({ kind: 'relax', dur: 5, lo: 0, hi: 0.15, rep: r, tag: 'rest', msg: l => `Let go · get ready to move · ${Math.ceil(l)}s` });
      ph.push({ kind: 'squeeze', dur: moving, lo: moveLo(r), hi: Infinity, rep: r, tag: 'move', noHint: true, msg: (l, v, inn) => `${mv.cue(moving - l)} · ${inn ? 'still lifting ✓' : 'squeeze back up!'}` });
      ph.push({ kind: 'relax', dur: 7, lo: 0, hi: 0.15, rep: r, tag: 'rest', msg: l => `Lower down, let go completely · ${Math.ceil(l)}s` });
    }
    super('move', 'Squeeze & Move', ph, o); this.reps = n; this.mv = mv; this.refs = refs; this.c = { n, still, moving, lo, keep, move: o.move ?? 'bridgeMarch' };
  }
  onStep() {   // when a still hold finishes, lock in its average as the bar for the moving hold
    const p = this.tl.cur;
    if (p.tag === 'rest' && p.samples.length === 1) { const st = this.tl.phases[p.i - 1]; if (st?.tag === 'still') this.refs[st.rep] = M.mean(st.samples.filter(s => s.t >= st.start + 1).map(s => s.v)) || 0; }
  }
  // how much the movement alone raises the reading (only an upward push is corrected for)
  get offset() {
    const b = this.tl.phases.find(p => p.tag === 'mbase'), r = this.tl.phases[0];
    if (!b || !b.samples.length) return 0;
    return Math.max(0, M.median(b.samples.map(s => s.v)) - M.median(r.samples.slice(-30).map(s => s.v)));
  }
  hud() {
    const p = this.tl.cur;
    if (p.tag !== 'move') return { kind: 'ring' };
    const st = this.tl.phases[p.i - 2], stillMean = M.mean(st.samples.filter(s => s.t > st.start + 1).map(s => s.v)) || 0;
    return { kind: 'ring', ref: stillMean, keep: this.c.keep };
  }
  finish() {
    const tl = this.tl, sig = this.opts.sig, off = this.offset;
    const reps = tl.phases.filter(p => p.tag === 'still').map(st => {
      const mv = tl.phases[st.i + 2], lo = Math.max(0.2, this.c.keep * (this.refs[st.rep] ?? this.c.lo));
      const sS = st.samples.filter(s => s.t >= st.start + 1), mS = mv.samples.filter(s => s.t >= mv.start + 1).map(s => ({ ...s, v: s.v - off }));
      const stillMean = M.mean(sS.map(s => s.v)), moveMean = M.mean(mS.map(s => s.v));
      // seconds into the movement before the squeeze first drops below target (and stays below for 0.5 s)
      let heldFor = mv.dur - 1, below = null;
      for (const s of mS) { if (s.v < lo) { below ??= s.t; if (s.t - below >= 0.5) { heldFor = below - mv.start - 1; break; } } else below = null; }
      return { stillMean, moveMean, retention: stillMean > 0.05 ? M.clamp(moveMean / stillMean, 0, 1.3) : 0,
        stillOn: M.inZoneFrac(sS, this.c.lo, Infinity), moveOn: M.inZoneFrac(mS, lo, Infinity), heldFor: Math.max(0, heldFor),
        strain: M.looksLikeStrain(st.samples, sig) || M.looksLikeStrain(mv.samples, sig) };
    });
    const rests = tl.phases.filter(p => p.tag === 'rest').map((p, i) => relaxStats(p, 0.6));
    const ret = M.mean(reps.map(r => r.retention)), moveOn = M.mean(reps.map(r => r.strain ? 0 : r.moveOn));
    const relax = rests.filter(r => r.relaxed && r.relaxTime <= 2).length / rests.length;
    const score = 0.5 * Math.min(1, ret) + 0.3 * moveOn + 0.2 * relax;
    const res = {
      game: 'move', title: this.title, score: pct(score), move: this.c.move, moveLabel: this.mv.label,
      settings: { reps: this.c.n, moving: this.c.moving, lo: pct(this.c.lo), keep: pct(this.c.keep) },
      metrics: { retention: pct(ret), heldThrough: R(M.mean(reps.map(r => r.heldFor)), 1), moveOnTarget: pct(moveOn), stillOnTarget: pct(M.mean(reps.map(r => r.stillOn))),
        stillLevel: pct(M.mean(reps.map(r => r.stillMean))), moveLevel: pct(M.mean(reps.map(r => r.moveMean))),
        stillFade: R(M.fatigueIndex(reps.map(r => r.stillMean)), 2), retentionFade: R(M.fatigueIndex(reps.map(r => r.retention)), 2), moveArtifact: pct(off), relaxed: pct(relax), strainReps: reps.filter(r => r.strain).length },
      reps: reps.map(r => ({ still: pct(r.stillMean), moving: pct(r.moveMean), retention: pct(r.retention), heldFor: R(r.heldFor, 1), strain: r.strain })),
    };
    const clean = !res.metrics.strainReps && relax >= 0.7;
    // progression has two levers: the bar (share of your still squeeze to keep) and the moving-hold length.
    // Success raises the bar up to 80%, then lengthens the hold (to 20 s), then raises the bar toward 90%.
    // Struggling shortens the hold (down to 6 s), then lowers the bar (down to 50%).
    const stillOn = M.mean(reps.map(r => r.stillOn)), lo = this.c.lo, k = this.c.keep, mvS = this.c.moving, r2 = x => Math.round(x * 100) / 100;
    if (clean && moveOn >= 0.75) res.next = k < 0.8 ? { keep: r2(k + 0.05) } : mvS < 20 ? { moving: mvS + 2 } : k < 0.9 ? { keep: r2(k + 0.05) } : null;
    else if (clean && moveOn < 0.4) res.next = mvS > 6 ? { moving: mvS - 2 } : k > 0.5 ? { keep: r2(k - 0.05) } : null;
    else if (clean && stillOn < 0.5 && lo > 0.3) res.next = { lo: r2(lo - 0.05) };
    return res;
  }
}

// ---------------------------------------------------------------- registry
export const GAMES = {
  hold:     { make: o => new Hold(o), name: 'Hold the Line', quality: 'Strength & endurance', blurb: 'Lift into the shaded zone and keep the line there. Daily preset = Bø protocol: 10 × 8 s near-max + 3 flicks each.' },
  move:     { make: o => new Move(o), name: 'Squeeze & Move', quality: 'Endurance under load', blurb: 'Hold still, then hold the same squeeze through a glute bridge, single-leg march, squat or march. Tracks how much strength you keep while moving.' },
  power:    { make: o => new Power(o), name: 'Power Punch', quality: 'Max strength', blurb: '3 all-out squeezes. Ring the bell — beat your record.' },
  flicks:   { make: o => new Flicks(o), name: 'Quick Flicks', quality: 'Fast-twitch', blurb: '10 beats. Snap up on the beat, drop fully between.' },
  elevator: { make: o => new Elevator(o), name: 'Elevator', quality: 'Precision control', blurb: 'Stop at each floor going up, then step down floor by floor.' },
  wave:     { make: o => new Wave(o), name: 'Trace the Wave', quality: 'Coordination', blurb: 'Follow a moving line: swells, ramps and stairs.' },
  melt:     { make: o => new Melt(o), name: 'Melt', quality: 'Relaxation', blurb: 'Squeeze, then let go so fully the ice cube melts. Ends with breathing drops.' },
  breath:   { make: o => new Breath(o), name: 'Breath Sync', quality: 'Breath coordination', blurb: 'Lift gently on the out-breath, let go on the in-breath.' },
  knack:    { make: o => new Knack(o), name: 'Cough Shield', quality: 'Squeeze before you cough', blurb: 'Random cue: squeeze BEFORE you cough, sneeze or laugh, and hold through it.' },
  checkup:  { make: o => new Checkup(o), name: 'Monthly Check-up', quality: 'Strength · hold time · repeats · flicks', blurb: '~6 min standardized test + symptom check. Your report card.' },
};
