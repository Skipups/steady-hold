// Pure signal metrics. No DOM. Samples are {t, v, r?}:
//   t = seconds (game clock), v = squeeze as a fraction of calibrated max above relaxed (0 = relaxed, 1 = max),
//   r = tip share of pressure (tip / (base + tip)), used by the form check. May be null.

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
export const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
export const cv = a => { const m = mean(a); return m > 0 ? sd(a) / m : NaN; };
export const fin = x => (typeof x === 'number' && isFinite(x)) ? x : null;

export const within = (samples, t0, t1) => samples.filter(s => s.t >= t0 && s.t < t1);

export function peak(samples) {
  let best = null;
  for (const s of samples) if (!best || s.v > best.v) best = s;
  return best; // {t,v} or null
}

// Seconds from cue (t0) until the signal first reaches 90% of its peak in this window.
export function timeToPeak(samples, t0) {
  const p = peak(samples); if (!p || p.v <= 0.05) return null;
  const hit = samples.find(s => s.v >= 0.9 * p.v);
  return hit ? Math.max(0, hit.t - t0) : null;
}

// Fastest rise over any `win`-second span (fraction of max per second).
export function rateOfRise(samples, win = 0.3) {
  let best = 0, j = 0;
  for (let i = 0; i < samples.length; i++) {
    while (j < i && samples[i].t - samples[j].t > win) j++;
    const dt = samples[i].t - samples[j].t;
    if (dt >= win * 0.5) best = Math.max(best, (samples[i].v - samples[j].v) / dt);
  }
  return best;
}

// Longest continuous run (seconds) with v >= thr. Dips shorter than `grace` seconds don't break a run.
export function longestAbove(samples, thr, grace = 0.25) {
  let best = 0, start = null, lastIn = null;
  for (const s of samples) {
    if (s.v >= thr) {
      if (start === null || s.t - lastIn > grace) start = s.t;
      lastIn = s.t; best = Math.max(best, lastIn - start);
    }
  }
  return best;
}

// Fraction of time (0..1) the signal is inside [lo, hi]. lo/hi may be functions of t.
export function inZoneFrac(samples, lo, hi) {
  if (samples.length < 2) return 0;
  let inT = 0, tot = 0;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i], dt = s.t - samples[i - 1].t;
    if (dt <= 0 || dt > 0.5) continue;
    const L = typeof lo === 'function' ? lo(s.t) : lo, H = typeof hi === 'function' ? hi(s.t) : hi;
    tot += dt; if (s.v >= L && s.v <= H) inT += dt;
  }
  return tot ? inT / tot : 0;
}

// Slope of a least-squares line through v over time (fraction of max per second). Negative = fading.
export function slope(samples) {
  const n = samples.length; if (n < 3) return 0;
  const mt = mean(samples.map(s => s.t)), mv = mean(samples.map(s => s.v));
  let num = 0, den = 0;
  for (const s of samples) { num += (s.t - mt) * (s.v - mv); den += (s.t - mt) ** 2; }
  return den ? num / den : 0;
}

// After a release cue at t0: seconds until v drops to <= level and stays there for `hold` seconds.
export function relaxTime(samples, t0, level, hold = 0.3) {
  let start = null;
  for (const s of samples) {
    if (s.t < t0) continue;
    if (s.v <= level) { if (start === null) start = s.t; if (s.t - start >= hold) return Math.max(0, start - t0); }
    else start = null;
  }
  return null; // never relaxed in the window
}

export const residualAt = (samples, t, w = 0.5) => { const a = within(samples, t - w, t + w).map(s => s.v); return a.length ? mean(a) : null; };

export function rmse(samples, target) {
  const e = samples.map(s => (s.v - target(s.t)) ** 2);
  return e.length ? Math.sqrt(mean(e)) : null;
}

// How far (seconds) the signal lags behind a moving target, by brute-force shift search.
export function lag(samples, target, maxLag = 1.2, step = 0.05) {
  let best = 0, bestE = Infinity;
  for (let L = 0; L <= maxLag + 1e-9; L += step) {
    const e = mean(samples.map(s => (s.v - target(s.t - L)) ** 2));
    if (e < bestE) { bestE = e; best = L; }
  }
  return best;
}

// Ratio of the last-3 average to the first-3 average (1 = no fatigue, <1 = fading).
export function fatigueIndex(vals) {
  const a = vals.filter(x => fin(x) !== null);
  if (a.length < 4) return null;
  const k = Math.min(3, Math.floor(a.length / 2));
  const f = mean(a.slice(0, k)), l = mean(a.slice(-k));
  return f > 0 ? l / f : null;
}

// ---- form check (straining guard) ----
// sig = {rS, rB}: tip share of pressure during a verified squeeze vs a deliberate bear-down.
export const guardUsable = sig => !!sig && fin(sig.rS) !== null && fin(sig.rB) !== null && Math.abs(sig.rS - sig.rB) >= 0.06;
export function repShare(samples) {
  const p = peak(samples); if (!p || p.v < 0.15) return null;
  const top = samples.filter(s => s.v >= 0.8 * p.v && fin(s.r) !== null).map(s => s.r);
  return top.length ? median(top) : null;
}
export function looksLikeStrain(samples, sig) {
  if (!guardUsable(sig)) return false;
  const r = repShare(samples); if (r === null) return false;
  return Math.abs(r - sig.rB) < Math.abs(r - sig.rS);
}

// ---- cough / Knack ----
// Finds the cough spike: the moment of fastest rise over ~120 ms. Returns {t, rate} or null if
// nothing rises faster than minRate (fraction of max per second).
// Fast rises are grouped into events (gaps > 0.25 s split them). The FASTEST event is the cough: an abdominal
// pressure spike rises far faster than any voluntary squeeze (calibrated per person in Setup).
export function findSpike(samples, minRate, win = 0.12) {
  const events = []; let cur = null, j = 0;
  for (let i = 0; i < samples.length; i++) {
    while (j < i && samples[i].t - samples[j].t > win) j++;
    const dt = samples[i].t - samples[j].t;
    if (dt < win * 0.5) continue;
    const rate = (samples[i].v - samples[j].v) / dt;
    if (rate < minRate) continue;
    if (cur && samples[i].t - cur.last <= 0.25) { cur.last = samples[i].t; if (rate > cur.rate) { cur.rate = rate; cur.t = samples[j].t; } }
    else { cur = { t: samples[j].t, rate, last: samples[i].t }; events.push(cur); }
  }
  const e = events.reduce((a, b) => (!a || b.rate > a.rate ? b : a), null);
  return e ? { t: e.t, rate: e.rate, count: events.length } : null;
}
// First time the signal crosses thr going up, and stays above for `hold` s (so a cough blip alone doesn't count).
export function onsetTime(samples, thr, hold = 0.15) {
  let start = null;
  for (const s of samples) {
    if (s.v >= thr) { if (start === null) start = s.t; if (s.t - start >= hold) return start; }
    else start = null;
  }
  return null;
}
