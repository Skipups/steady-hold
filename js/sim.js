// Simulated players: used by the automated tests and by the preview page.
// A player looks at what the game is asking for (slightly late, like a real person) and its muscle
// follows with a rise/fall lag, fatigue, wobble, and optional bad habits.
export const PLAYERS = {
  endurance:{ label: 'Quick squeeze fine, fades in long & moving holds', strength: 1.0, react: 0.3, rise: 0.12, fall: 0.2, fatigue: 0.05, noise: 0.03, residual: 0.03, moveDrop: 0.4, moveArtifact: 0.08 },
  good:     { label: 'Steady player', strength: 1.0, react: 0.3, rise: 0.12, fall: 0.15, fatigue: 0.004, noise: 0.025, residual: 0.02, moveDrop: 0.05, moveArtifact: 0.08 },
  weak:     { label: 'Early postpartum (weak, tires fast)', strength: 0.65, react: 0.4, rise: 0.25, fall: 0.2, fatigue: 0.02, noise: 0.04, residual: 0.03 },
  tight:    { label: 'Slow to relax (overactive)', strength: 0.9, react: 0.3, rise: 0.12, fall: 1.6, fatigue: 0.006, noise: 0.03, residual: 0.18 },
  strainer: { label: 'Bears down instead of lifting', strength: 1.1, react: 0.3, rise: 0.15, fall: 0.2, fatigue: 0.004, noise: 0.03, residual: 0.03, strain: true },
  late:     { label: 'Knack: coughs before squeezing', strength: 0.9, react: 0.3, rise: 0.12, fall: 0.15, fatigue: 0.004, noise: 0.025, residual: 0.02, knackLead: -0.3 },
};

export function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export class Player {
  constructor(p, seed = 1) { this.p = { knackLead: 0.6, coughAmp: 0.8, ...p }; this.v = 0; this.tired = 0; this.rand = mulberry(seed); this.cough = null; }
  // the squeeze level this player is trying to reach at game time t
  aim(game, t) {
    const P = this.p;
    if (game.id === 'knack') {
      const tr = game.trials.find(x => t < x.end + 2) ?? game.trials[game.trials.length - 1];
      const sqStart = tr.cueAt + P.react, coughAt = sqStart + P.knackLead;      // knackLead < 0: coughs first
      if (!this.cough || this.cough.n !== tr.n) this.cough = { n: tr.n, at: coughAt };
      return t >= sqStart + Math.max(0, -P.knackLead) && t < tr.end + 0.3 ? 0.55 : P.residual;
    }
    // people react late to what the screen shows (but rhythm games show what's coming, so they can roughly anticipate)
    const look = game.id === 'wave' || game.id === 'elevator' ? t : t - P.react;
    const b = game.bandAt(Math.max(0, look));
    if (!b || b.kind === 'relax' || b.kind === 'ready') return P.residual;
    let a = b.hi === Infinity ? (b.lo <= 0.2 ? 9 : b.lo + 0.15) : (b.lo + b.hi) / 2; // 9 = "everything you've got"
    if (b.tag === 'move') a = ((game.c?.lo ?? 0.5) + 0.15) * (1 - (P.moveDrop ?? 0.1));   // tries to keep the still squeeze; it sags while the body is busy
    return a;
  }
  sample(game, t, dt) {
    const P = this.p;
    let a = this.aim(game, t);
    const cap = P.strength * Math.exp(-this.tired);
    a = Math.min(a, cap);
    const squeezing = a > P.residual + 0.05;
    this.tired = Math.max(0, this.tired + (squeezing ? P.fatigue * Math.min(a, 1) : -0.015) * dt);
    const tau = a > this.v ? P.rise : P.fall;
    this.v += (a - this.v) * Math.min(1, dt / tau);
    let v = this.v + (this.rand() - 0.5) * 2 * P.noise;
    const ph = game.tl?.phaseAt(t);
    if (ph && (ph.tag === 'mbase' || ph.tag === 'move')) v += (P.moveArtifact ?? 0) * (0.6 + 0.4 * Math.sin(t * 3));
    // cough spike: short, sharp abdominal pressure bump
    if (this.cough && t >= this.cough.at && t < this.cough.at + 0.25) { const u = (t - this.cough.at) / 0.25; v += this.p.coughAmp * Math.sin(Math.PI * u); }
    // form-check share: a real lift has its own tip/base signature (0.40), bearing down shifts it (0.62)
    const r = v > 0.1 ? (P.strain ? 0.62 : 0.40) + (this.rand() - 0.5) * 0.04 : null;
    return { v: Math.max(-0.05, v), r };
  }
}

// Run a whole game to completion at a fixed frame rate. Returns {game, result, trace}
export function simulate(game, player, fps = 30) {
  const dt = 1 / fps, trace = []; let t = 0, guard = 0;
  while (!game.done && guard++ < 100000) { const s = player.sample(game, t, dt); game.step(dt, s); t += dt; trace.push({ t, v: s.v }); }
  return { game, result: game.result, trace };
}
