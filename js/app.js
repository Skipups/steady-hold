import { GAMES, HOLD_PRESETS, STANCES, MOVES } from './games.js';
import * as M from './metrics.js';
import { recommend, STEP } from './plan.js';
import { Player, PLAYERS } from './sim.js';
import { drawGame, resultHTML, progressHTML, SYMPTOM_Q, leakScore, redFlags, METRIC, day } from './ui.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search), SIM = PLAYERS[qs.get('sim')], FAST = Math.min(20, +qs.get('fast') || 1);
const PFX = SIM ? 'sim:' : '';   // simulated sessions live in their own storage, never mixed with your real data
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(PFX + k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch {} } };
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------ state
let lastDev = null, connected = false, demo = false, demoDown = false, packets = 0, pktTimes = [], chrName = '';
let rawB = 0, rawT = 0, sB = 0, sT = 0;              // raw + smoothed per sensor
let rawBuf = [], game = null, gameMeta = null, busy = false, hiddenAt = 0;
const pref = store.get('pref', { pos: 'standing', stance: 'still', sound: true, voice: true, ch: 'base', end: 'be', preset: 'daily', move: 'bridgeMarch', tips: true, tipVoice: true });
pref.move ??= 'bridgeMarch'; pref.tips ??= true; pref.tipVoice ??= true;
const savePref = () => store.set('pref', pref);
const gset = store.get('gset', {});                  // per-game adaptive settings
const calKey = () => 'cal:' + pref.pos;
let cal = loadCal();
function loadCal() {
  const c = store.get(calKey(), null);
  if (c) return c;
  const old = store.get('cal', null);                 // migrate the original single calibration
  if (old && old.max > old.rest && pref.pos === 'standing') return { rest: old.rest, max: old.max, ch: old.ch, restB: old.rest, restT: old.rest, migrated: true };
  return { rest: 0, max: 0 };
}
const hasCal = () => cal.max > cal.rest;
const chanVal = (b, t) => pref.ch === 'base' ? b : pref.ch === 'tip' ? t : Math.max(b, t);
const smooth = () => chanVal(sB, sT);
let zero = 0;   // shift of the relaxed reading since calibration (position, probe placement, time). Re-measured at each game start.
const norm = x => hasCal() ? (x - cal.rest - zero) / (cal.max - cal.rest) : 0;
function share() {        // tip share of the squeeze, for the form check
  if (!hasCal() || cal.restB == null) return null;
  const dB = sB - cal.restB, dT = sT - cal.restT, span = cal.max - cal.rest;
  return dB + dT > 0.1 * span ? M.clamp(dT / (dB + dT), 0, 1) : null;
}
const sample = () => ({ raw: smooth(), v: Math.max(-0.2, Math.min(1.6, norm(smooth()))), r: demo ? null : share() });

// ------------------------------------------------------------ sound & voice (useful when standing with the phone on a shelf)
let ac = null;
function beep(f = 660, ms = 120) { if (!pref.sound) return; try { ac ??= new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.18, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + ms / 1000); o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + ms / 1000); } catch {} }
let lastSaid = 0;
function say(t, soft) { if (!pref.voice || !window.speechSynthesis) return; if (soft && (performance.now() - lastSaid < 3500 || speechSynthesis.speaking)) return; lastSaid = performance.now(); try { if (!soft) speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.rate = 1.1; speechSynthesis.speak(u); } catch {} }

// ------------------------------------------------------------ bluetooth (from v1)
function parse(dv) {
  const le = pref.end === 'le';
  const b = dv.byteLength >= 2 ? dv.getUint16(0, le) : 0, t = dv.byteLength >= 4 ? dv.getUint16(2, le) : b;
  packets++; const tn = performance.now(); pktTimes.push(tn); while (pktTimes.length && tn - pktTimes[0] > 2000) pktTimes.shift();
  const bytes = [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map(x => x.toString(16).padStart(2, '0')).join(' ');
  $('raw').textContent = `packets: ${packets} (${(pktTimes.length / 2).toFixed(0)}/sec) · ${chrName}\nraw: ${bytes}  base=${b} tip=${t}`;
  rawB = b; rawT = t;
  if (recording) recording.push({ t: tn, b, tip: t });
}
let recording = null;
// iPhone Bluetooth often ignores the first connect, or a stale link from an old tab blocks it.
// Each try gets 8 s; between tries we drop any half-open link. Up to 3 tries.
async function gattConnect(dev, log, verb) {
  if (dev.gatt.connected) return dev.gatt;                     // already linked (e.g. from before a reload)
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    log(`2/5 ${verb} ${dev.name || 'Perifit'}${i > 1 ? ` (try ${i} of 3)` : ''}`);
    try { return await Promise.race([dev.gatt.connect(), new Promise((_, j) => setTimeout(() => j(new Error('timed out after 8 s')), 8000))]); }
    catch (e) { lastErr = e; try { dev.gatt.disconnect(); } catch {} await sleep(800); }
  }
  throw new Error(`the Perifit didn’t answer (${lastErr?.message || lastErr}). Check its light is blinking, the Perifit app is fully closed (swipe it away), then tap Connect again`);
}
let connecting = false;
async function connect() {
  if (connecting) return;
  if (!navigator.bluetooth) { msg('This browser has no Bluetooth. Open this page in Bluefy on iPhone, or Chrome on Android/desktop. You can still try demo mode: press and hold the graph.'); return; }
  let step = 'start'; const log = t => { step = t; $('raw').textContent = 'step: ' + t; status(t); };
  connecting = true; refresh();
  try {
    let svc = $('uSvc').value.trim().toLowerCase().replace(/^0x/, ''); if (/^[0-9a-f]{4}$/.test(svc)) svc = '0000' + svc + '-0000-1000-8000-00805f9b34fb';
    const short = '0000aa40-0000-1000-8000-00805f9b34fb', dataUuid = '0000aa41-0000-1000-8000-00805f9b34fb', svcs = [...new Set([svc, short, dataUuid])];
    // Bluefy's name/service filters don't match the Perifit, so never filter.
    // Instead, reuse a device we already have permission for, so no picker is needed.
    let dev = null, gatt = null;
    const known = store.get('devName', '');
    if (!lastDev && navigator.bluetooth.getDevices) {
      try { const list = await navigator.bluetooth.getDevices(); lastDev = list.find(d => d.id === store.get('devId', '')) || list.find(d => known && d.name === known) || null; } catch {}
    }
    if (lastDev) {
      log('2/5 reconnecting to ' + (lastDev.name || 'Perifit'));
      try { gatt = await gattConnect(lastDev, log, 'reconnecting to'); dev = lastDev; }
      catch { lastDev = null; log('1/5 choosing device'); }   // fall through to the picker instead of giving up
    }
    if (!gatt) {
      log('1/5 choosing device');
      msg(known ? `Pick “${known}” from the list.` : 'Pick your Perifit from the list.');
      dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: svcs });
      gatt = await gattConnect(dev, log, 'connecting to');
    }
    lastDev = dev;
    if (!dev._lpListen) { dev._lpListen = true; dev.addEventListener('gattserverdisconnected', () => { connected = false; status('Disconnected. Tap Connect to reconnect.'); if (game && !game.done) abort('The Perifit disconnected. That set wasn’t saved.'); refresh(); }); }
    log('3/5 finding service'); let services = [];
    for (const u of svcs) { try { services.push(await gatt.getPrimaryService(u)); } catch {} }
    if (!services.length) { try { services = await gatt.getPrimaryServices(); } catch {} }
    if (!services.length) throw new Error('Connected, but no matching service. Paste the service UUID from a BLE scanner app into Device & debug.');
    log('4/5 finding data channel'); let chr = null;
    for (const s of services) if (!chr) { try { chr = await s.getCharacteristic(dataUuid); } catch {} }
    if (!chr) for (const s of services) { let cs = []; try { cs = await s.getCharacteristics(); } catch {} for (const c of cs) if (c.properties.notify && !chr) chr = c; }
    if (!chr) throw new Error('No notifying characteristic found.');
    chrName = 'data ' + chr.uuid.slice(4, 8);
    if (!chr._lpListen) { chr._lpListen = true; chr.addEventListener('characteristicvaluechanged', e => parse(e.target.value)); }
    log('5/5 starting data'); await chr.startNotifications();
    if (dev.name) store.set('devName', dev.name);
    if (dev.id) store.set('devId', dev.id);
    connected = true; demo = false; zero = 0; cal = loadCal(); status('Connected: ' + (dev.name || 'Perifit'));
    msg(hasCal() ? 'Connected. Pick a game.' : `Connected. Calibrate first (${pref.pos}).`);
  } catch (e) {
    const why = (e && (e.message || e.name)) || String(e);
    if (step.startsWith('1/5') && /cancel|NotFound/i.test(why)) { status('Not connected'); msg('No device chosen. Make sure the Perifit is on (light blinking) and the Perifit app is closed, then tap Connect.'); }
    else { status('Not connected (failed at ' + step + ')'); msg('Could not connect at step ' + step + ': ' + why); }
  }
  connecting = false;
  refresh();
}

// ------------------------------------------------------------ demo: press the graph to squeeze
const stage = $('stage');
function demoPress(e) { if (e.cancelable) e.preventDefault(); demoDown = true; if (!connected && !demo) { demo = true; zero = 0; cal = { rest: 200, max: 1800, restB: 200, restT: 200 }; status('Demo mode: press & hold the graph = squeeze'); refresh(); } }
const demoRelease = e => { if (e.touches && e.touches.length) return; demoDown = false; };
stage.addEventListener('touchstart', demoPress, { passive: false });
stage.addEventListener('touchend', demoRelease); stage.addEventListener('touchcancel', demoRelease);
stage.addEventListener('mousedown', demoPress); addEventListener('mouseup', demoRelease);
stage.addEventListener('contextmenu', e => e.preventDefault());

// ------------------------------------------------------------ setup flows
async function collect(sec, text) {
  const out = [], end = performance.now() + sec * 1000;
  while (performance.now() < end) { msg(`${text} ${Math.ceil((end - performance.now()) / 1000)}`); out.push({ t: performance.now() / 1000, v: smooth(), b: sB, tip: sT }); await sleep(40); }
  return out;
}
const med = (a, f) => M.median(a.map(f));
async function calibrate() {
  busy = true; refresh(); show('play');
  const where = pref.pos === 'standing' ? 'Stand tall, feet hip-width, knees soft.' : pref.pos === 'sitting' ? 'Sit upright.' : 'Lie on your back, knees bent.';
  msg(where); await sleep(2500);
  const r = await collect(5, 'Relax completely…');
  msg('Get ready to squeeze and lift…'); beep(520); await sleep(1500); beep(880);
  const m = await collect(5, 'Squeeze & lift as hard as you can!');
  beep(440);
  const rest = med(r, x => x.v), sorted = m.map(x => x.v).sort((a, b) => a - b), max = sorted[Math.floor(sorted.length * 0.9)];
  busy = false;
  if (!packets && !demo) { msg('No data is arriving from the device. Close the Perifit app fully and reconnect.'); refresh(); show('home'); return; }
  if (max - rest < 20) { msg(`Didn’t see much change (relaxed ${Math.round(rest)}, squeeze ${Math.round(max)}). Check Device & debug while squeezing.`); refresh(); show('home'); return; }
  const top = m.filter(x => x.v >= rest + 0.8 * (max - rest)), restB = med(r, x => x.b), restT = med(r, x => x.tip);
  const rS = M.median(top.map(x => { const dB = x.b - restB, dT = x.tip - restT; return dB + dT > 0 ? dT / (dB + dT) : NaN; }).filter(isFinite));
  zero = 0;
  cal = { ...cal, rest, max, restB, restT, ch: pref.ch, rS: isFinite(rS) ? rS : null, d: new Date().toISOString() };
  delete cal.migrated;
  if (!demo) { store.set(calKey(), cal); const cl = store.get('cals', []); cl.unshift({ d: cal.d, delta: max - rest, pos: pref.pos }); store.set('cals', cl.slice(0, 200)); }
  msg(`Calibrated (${pref.pos}). Max: ${fmtG(max - rest)}.` + (cal.rB == null ? ' Optional next: Setup → Form check.' : '')); refresh(); show('home');
}
async function formCheck() {
  if (!hasCal()) { msg('Calibrate first.'); return; }
  busy = true; refresh(); show('play');
  msg('Form check: relax first.'); await sleep(2000);
  const r = await collect(3, 'Relax…'); const restB = med(r, x => x.b), restT = med(r, x => x.tip);
  msg('Now GENTLY bear down, like starting a bowel movement. Gently! (3 s)'); say('Gently bear down'); await sleep(1200);
  const d = await collect(3, 'Gently bear down…');
  msg('Relax. Now a proper squeeze & lift.'); say('Relax'); await sleep(2500); say('Squeeze and lift');
  const s = await collect(4, 'Squeeze & lift…');
  busy = false;
  const sh = arr => M.median(arr.map(x => { const dB = x.b - restB, dT = x.tip - restT; return dB + dT > 0.1 * (cal.max - cal.rest) ? dT / (dB + dT) : NaN; }).filter(isFinite));
  const rB = sh(d), rS = sh(s);
  cal = { ...cal, rB: isFinite(rB) ? rB : null, rS: isFinite(rS) ? rS : cal.rS };
  if (!demo) store.set(calKey(), cal);
  const ok = M.guardUsable({ rS: cal.rS, rB: cal.rB });
  msg(ok ? `Form check is ON. Squeeze signature ${(cal.rS * 100).toFixed(0)}% tip vs bear-down ${(cal.rB * 100).toFixed(0)}% tip. Reps that look like bearing down will be flagged.`
    : `Your squeeze and bear-down looked too similar on the two sensors (${fmtPct(cal.rS)} vs ${fmtPct(cal.rB)} tip share), so the form check stays OFF. A pelvic floor PT can confirm your lift.`);
  refresh(); show('home');
}
const fmtPct = x => x == null || !isFinite(x) ? '–' : Math.round(x * 100) + '%';
async function coughRec() {
  if (!hasCal()) { msg('Calibrate first.'); return; }
  busy = true; refresh(); show('play');
  msg('Stay relaxed (no squeeze). When the timer starts, give 3 firm coughs, a few seconds apart.'); await sleep(3000);
  const c = await collect(9, 'Cough firmly ×3 (no squeeze)…');
  busy = false;
  const s = c.map(x => ({ t: x.t, v: norm(x.v) })), rates = [];
  for (let i = 0; i < 3; i++) { const sp = M.findSpike(s.filter(x => !rates.some(r => Math.abs(x.t - r.t) < 0.6)), 1.5); if (sp) rates.push(sp); }
  if (!rates.length) { msg('Didn’t see any cough spikes. Cough Shield will use a default setting. Try again with firmer coughs.'); refresh(); show('home'); return; }
  cal = { ...cal, coughRate: M.median(rates.map(r => r.rate)) };
  if (!demo) store.set(calKey(), cal);
  msg(`Recorded ${rates.length} cough${rates.length > 1 ? 's' : ''}. Cough Shield is tuned to you.`); refresh(); show('home');
}

// ------------------------------------------------------------ games
function optsFor(id, presetOverride) {
  const o = { tips: pref.tips, sig: M.guardUsable({ rS: cal.rS, rB: cal.rB }) ? { rS: cal.rS, rB: cal.rB } : null, stance: pref.pos === 'standing' ? pref.stance : null, ...(gset[id] || {}) };
  if (id === 'hold') { const p = presetOverride ?? pref.preset; Object.assign(o, HOLD_PRESETS[p], gset['hold:' + p] || {}, { preset: p }); }
  if (id === 'knack') o.coughRate = cal.coughRate;
  if (id === 'move') Object.assign(o, { move: pref.move }, gset['move:' + pref.move] || {}, { stance: null });
  if (id === 'power') o.record = Math.max(1, ...store.get('sessions', []).filter(s => s.game === 'power' && s.pos === pref.pos).map(s => (s.metrics.peak || 0) / 100));
  return o;
}
function start(id, extra = {}) {
  simP = null;
  if (!hasCal()) { msg('Calibrate first.'); return; }
  gameMeta = { id, chain: extra.chain, lastPhase: -1, lastCue: null, pos: pref.pos, preset: extra.preset ?? pref.preset, label: extra.label };
  if (id === 'move') {   // bridges are done lying: use the lying calibration when there is one
    const need = MOVES[pref.move].pos;
    if (need !== pref.pos) {
      const c = SIM ? null : store.get('cal:' + need, null);
      if (c && c.max > c.rest) { gameMeta.savedCal = cal; cal = c; gameMeta.pos = need; }
      else { gameMeta.pos = need; gameMeta.calNote = `This movement is done ${need === 'lying' ? 'lying down' : 'standing'}, but you only have a ${pref.pos} calibration, so the % numbers are approximate. “Kept while moving” is a ratio, so it’s still accurate. Calibrate in ${need} position for exact numbers.`; }
    }
  }
  const { preset: _p, label: _l, ...rest } = extra;
  game = GAMES[id].make({ ...optsFor(id, extra.preset), ...rest });
  show('play'); $('pb').hidden = false; $('gTitle').textContent = (planQ ? `${planDone + 1}/${planTotal} · ` : '') + (extra.label || GAMES[id].name); $('homeFlag').innerHTML = ''; busy = true; refresh(); beep(660);
}
function abort(text) { planQ = null; $('tip').hidden = true; if (gameMeta?.savedCal) { cal = gameMeta.savedCal; gameMeta.savedCal = null; } game = null; busy = false; show('home'); msg(text || 'Stopped. Nothing saved.'); refresh(); }
function cues() {
  // beep + voice on phase changes so you can train standing without staring at the phone
  const v = game.view(), p = game.tl ? game.tl.idx : null;
  if (p !== null && p !== gameMeta.lastPhase) {
    const ph = game.tl.cur; gameMeta.lastPhase = p;
    if (ph.kind === 'squeeze') { beep(ph.tag === 'on' || ph.tag === 'flick' || ph.tag === 'F' ? 990 : 880, ph.tag === 'on' || ph.tag === 'flick' || ph.tag === 'F' ? 70 : 140); if (ph.dur >= 3 && ph.tag !== 'floor' && ph.tag !== 'wave') say(ph.tag === 'ex' ? 'Breathe out, lift' : 'Squeeze'); }
    else if (ph.kind === 'relax' && ph.dur >= 3 && p > 0) { beep(440, 140); say(ph.tag === 'in' ? 'Breathe in, let go' : 'Let go'); }
    else if (ph.tag === 'floor') beep(700, 80);
  }
  if (v.tip !== gameMeta.lastTip) { gameMeta.lastTip = v.tip; if (v.tip && pref.tipVoice) say(v.tip.replace(/THEN/g, 'then').replace('about 20%', 'about twenty percent'), true); }
  if (game.id === 'knack') { const c = v.hud?.cue || null; if (c && c !== gameMeta.lastCue) { beep(990, 90); say(c.split(' (')[0].replace('!', '')); } gameMeta.lastCue = c; }
}
function finished() {
  const pos = gameMeta.pos || pref.pos;
  const res = { ...game.result, d: new Date().toISOString(), pos, stance: pos === 'standing' && gameMeta.id !== 'move' ? pref.stance : null,
    stanceLabel: gameMeta.id === 'move' ? pos : pos === 'standing' ? STANCES[pref.stance].label : pos, calNote: [gameMeta.calNote, gameMeta.zeroNote].filter(Boolean).join(' ') || null, restShift: gameMeta.restShift ?? null };
  if (gameMeta.savedCal) { cal = gameMeta.savedCal; gameMeta.savedCal = null; }
  const id = gameMeta.id; busy = false; game = null; $('tip').hidden = true;
  // apply adaptive progression
  if (res.next) {
    const k = id === 'hold' ? 'hold:' + gameMeta.preset : id === 'move' ? 'move:' + pref.move : id;
    gset[k] = { ...(gset[k] || {}), ...res.next }; store.set('gset', gset);
    const n = res.next;
    res.nextText = n.keep != null ? `Next time: keep at least ${Math.round(n.keep * 100)}% of your still squeeze while moving.` : n.moving != null ? `Next time: ${n.moving}s moving holds.` : n.lo != null ? `Next time: target ${Math.round(n.lo * 100)}%.` : n.hold != null ? `Next time: ${n.hold}s holds.` : n.thr != null ? `Next time: flick line at ${Math.round(n.thr * 100)}%.` : n.tol != null ? `Next time: ${n.tol < 0.1 ? 'narrower' : 'wider'} band.` : '';
  }
  if (res.newMax && !demo) { const d = (cal.max - cal.rest) * res.newMax; cal = { ...cal, max: cal.rest + d }; store.set(calKey(), cal); }
  if (id === 'checkup') { pendingCheckup = res; msg('Last part: 3 cued coughs (Cough Shield).'); setTimeout(() => start('knack', { cues: ['cough', 'cough', 'cough'], chain: 'checkup' }), 1500); return; }
  if (gameMeta.chain === 'checkup' && pendingCheckup) { pendingCheckup.knack = res.metrics.shielded; pendingCheckup.metrics.knackLead = res.metrics.avgLead; openSymptoms(true); return; }
  save(res); showResult(res);
}
let pendingCheckup = null;
const CK_STEPS = [['base', 'Rest'], ['P', 'Power'], ['E', 'Endurance'], ['break', 'Break'], ['F', 'Fast'], ['knack', 'Coughs'], ['q', 'Questions']];
function progressBar() {
  const total = game.tl ? game.tl.total : game.total, frac = Math.min(1, game.t / total), left = Math.max(0, total - game.t);
  const mm = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  $('pbFill').style.width = (frac * 100).toFixed(1) + '%';
  let txt = `${mm} left`, steps = '';
  const ck = game.id === 'checkup' || gameMeta.chain === 'checkup';
  if (ck) {
    // a rest belongs to the part it sits in: the last Rest/Power/Endurance/Break/Fast phase at or before now
    const tag = game.id === 'knack' ? 'knack' : [...game.tl.phases.slice(0, game.tl.idx + 1)].reverse().map(p => p.tag === 'Foff' || p.tag === 'end' ? 'F' : p.tag).find(t => ['base', 'P', 'E', 'break', 'F'].includes(t));
    const at = CK_STEPS.findIndex(c => c[0] === tag);
    steps = CK_STEPS.map(([, l], i) => `<span class="${i < at ? 'done' : i === at ? 'now' : ''}">${l}</span>`).join('');
    txt = game.id === 'knack' ? `Step 6 of 7 · ${mm} left, then 30 s of questions` : `Step ${at + 1} of 7 · ${mm} left in this part, then ~1 min of coughs & questions`;
  }
  $('pbText').textContent = txt; $('pbSteps').innerHTML = steps; $('pbSteps').hidden = !ck;
}
// end of the opening "relax" phase of a game (Knack: first 3 s)
const readyEnd = g => g.tl ? g.tl.phases[0].end : 3;
function autoZero() {
  gameMeta.zeroed = true;
  if (!hasCal() || SIM) return;
  const span = cal.max - cal.rest, xs = rawBuf.filter(r => r.t >= rawBuf[rawBuf.length - 1].t - 1.5).map(r => r.x);
  if (xs.length < 5) return;
  const med = M.median(xs), wob = M.sd(xs) / span, shift = med - cal.rest;
  if (wob > 0.08) { gameMeta.zeroNote = 'Couldn’t check your resting level (you weren’t still at the start), so this set uses your calibration.'; return; }
  const old = zero; zero = M.clamp(shift, -0.6 * span, 0.6 * span);
  gameMeta.restShift = shift / span;
  if (Math.abs(shift) > 0.6 * span) gameMeta.zeroNote = `Your relaxed reading is far from your calibration (${Math.round(shift / span * 100)}%). Please Calibrate again in ${pref.pos} position.`;
  else if (Math.abs(zero - old) / span > 0.1) gameMeta.zeroNote = `Re-zeroed: your relaxed reading had moved ${Math.round((zero - old) / span * 100)}% since calibration (normal after changing position or moving the probe).`;
}
// ------------------------------------------------------------ today's plan
let planQ = null, planDone = 0, planTotal = 0;
function startPlan(steps) { planQ = steps.slice(); planDone = 0; planTotal = steps.length; nextInPlan(); }
function nextInPlan() { const st = planQ?.shift(); if (!st) { planQ = null; return; } planDone = planTotal - planQ.length - 1; start(st.game, { ...(st.opts || {}), preset: st.preset, label: st.label }); }
function renderPlan() {
  const r = recommend(store.get('sessions', []), Date.now(), { guardOn: M.guardUsable({ rS: cal.rS, rB: cal.rB }) });
  const ready = (connected || demo) && hasCal() && !busy;
  const dots = Array.from({ length: Math.max(r.weekGoal, Math.min(7, r.daysTrained)) }, (_, i) => `<i class="${i < r.daysTrained ? 'on' : ''}"></i>`).join('');
  let h = `<div class="ptop"><h2>${esc(r.title)}</h2><span class="wk" title="${esc(r.week)}">${dots}</span></div>`;
  if (r.steps.length) h += `<ol class="plan">${r.steps.map(s => `<li><b>${esc(s.label)}</b><span class="note">${esc(s.why)}</span></li>`).join('')}</ol>`;
  h += r.notes.map(n => `<p class="note">• ${esc(n)}</p>`).join('');
  if (r.steps.length) h += `<div class="row" style="margin-top:8px"><button class="pri" id="bPlan" ${ready ? '' : 'disabled'}>${r.checkupDay ? 'Start Check-up' : 'Start session'} · ~${r.minutes} min</button></div>`;
  if (r.extra) h += `<div class="row" style="margin-top:8px"><button id="bExtra" ${ready ? '' : 'disabled'}>Extra set (optional) · ~4 min</button></div>`;
  if (!ready && (r.steps.length || r.extra)) h += `<p class="note">${!(connected || demo) ? 'Connect your Perifit to start.' : !hasCal() ? 'Calibrate first.' : ''}</p>`;
  $('plan').innerHTML = h;
  $('bPlan')?.addEventListener('click', () => r.checkupDay ? start('checkup') : startPlan(r.steps));
  $('bExtra')?.addEventListener('click', () => startPlan(r.extra));
}
function save(res) { if (demo && !SIM) return; const s = store.get('sessions', []); s.unshift(res); store.set('sessions', s.slice(0, 2000)); }
function showResult(res) {
  const prev = store.get('sessions', []).find(s => s.game === res.game && s.d !== res.d && s.pos === res.pos);
  $('result').innerHTML = resultHTML(res, prev) + (demo && !SIM ? '<p class="note">Demo mode: not saved.</p>' : SIM ? '<p class="note">Simulated player: saved to the separate test store only.</p>' : '');
  show('result'); renderProgress();
  const nx = planQ?.[0];
  $('bNext').hidden = !nx; if (nx) $('bNext').textContent = `Next: ${nx.label} →`;
  $('bBack').textContent = planQ && !nx ? 'Set complete ✓ · Back' : nx ? 'End set here' : 'Back to games';
  if (planQ && !nx) { planQ = null; }
}

// ------------------------------------------------------------ symptoms
function openSymptoms(fromCheckup) {
  const f = $('symForm');
  f.innerHTML = SYMPTOM_Q.map(q => `<fieldset><legend>${esc(q.q)}</legend>${q.range ? `<input type="range" name="${q.id}" min="${q.range[0]}" max="${q.range[1]}" value="0" oninput="this.nextElementSibling.textContent=this.value"><output>0</output>`
    : q.opts.map((o, i) => `<label class="opt"><input type="${q.multi ? 'checkbox' : 'radio'}" name="${q.id}" value="${i}" ${!q.multi && i === 0 ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</fieldset>`).join('') +
    `<button class="pri" type="submit">Save</button>`;
  f.dataset.checkup = fromCheckup ? '1' : '';
  show('symptoms');
}
$('symForm').addEventListener('submit', e => {
  e.preventDefault(); const fd = new FormData(e.target), a = {};
  for (const q of SYMPTOM_Q) a[q.id] = q.multi ? fd.getAll(q.id).map(Number) : Number(fd.get(q.id));
  a.red = (a.red || []).map(i => SYMPTOM_Q[4].opts[i]); a.when = (a.when || []).map(i => SYMPTOM_Q[2].opts[i]);
  const entry = { d: new Date().toISOString(), leak: leakScore(a), ...a };
  if (!demo || SIM) { const s = store.get('symptoms', []); s.unshift(entry); store.set('symptoms', s.slice(0, 200)); }
  let extra = redFlags(a) ? `<p class="flag warn">You ticked: ${esc(a.red.join('; '))}. Please book a pelvic floor physical therapist (or your OB for bleeding) before pushing your training harder.</p>` : '';
  if (e.target.dataset.checkup && pendingCheckup) { pendingCheckup.leak = entry.leak; pendingCheckup.red = a.red; save(pendingCheckup); const res = pendingCheckup; pendingCheckup = null; showResult(res); $('result').insertAdjacentHTML('afterbegin', extra + `<p class="flag info">Leak score ${entry.leak} / 12 (lower is better).</p>`); }
  else { renderProgress(); show('home'); msg(`Saved. Leak score ${entry.leak} / 12.`); if (extra) $('homeFlag').innerHTML = extra; }
});

// ------------------------------------------------------------ views
function show(v) {
  for (const x of ['home', 'result', 'symptoms']) $('v-' + x).hidden = x !== (v === 'play' ? 'none' : v);
  const playing = v === 'play'; $('bStop').hidden = !playing; $('gTitle').hidden = !playing; $('pb').hidden = !playing || !game; $('stageCard').hidden = v === 'symptoms' || v === 'result';
  if (v === 'home') msg(hasCal() ? 'Pick a game.' : 'Calibrate first.');
  if (!playing) $('gTitle').textContent = '';
  window.scrollTo(0, 0);
}
function msg(t) { $('msg').textContent = t; }
function status(t) { $('stxt').textContent = t; }
const gPer = () => { const ref = +$('sRef').value, d = cal.max - cal.rest; return ref > 0 && d > 0 && !demo ? ref / d : 0; };
const fmtG = d => { const k = gPer(); return k ? Math.round(Math.max(0, d) * k) + ' g' : Math.round(Math.max(0, d)) + ' u'; };
function refresh() {
  $('topConn').hidden = connected || busy;
  $('topConn').disabled = connecting; $('topConn').textContent = connecting ? 'Connecting…' : demo ? 'Connect Perifit (leave demo)' : 'Connect Perifit';
  if ($('plan')) renderPlan();
  const live = connected || demo;
  $('dot').classList.toggle('on', live);
  $('bConn').disabled = connected || busy || connecting; $('bConn').textContent = connecting ? 'Connecting…' : 'Connect'; $('bCal').disabled = !live || busy;
  for (const b of document.querySelectorAll('[data-game]')) b.disabled = !live || busy || !hasCal();
  for (const b of document.querySelectorAll('[data-setup]')) b.disabled = !live || busy || !hasCal();
  const guard = M.guardUsable({ rS: cal.rS, rB: cal.rB });
  const staleCal = connected && hasCal() && (cal.migrated || !cal.d);
  $('calWarn').hidden = !staleCal;
  $('calState').innerHTML = hasCal() ? `Calibrated for <b>${esc(pref.pos)}</b>${cal.d ? ' on ' + esc(day(cal.d)) : cal.migrated ? ' (from v1)' : ''} · max ${esc(fmtG(cal.max - cal.rest))} · form check ${guard ? 'ON' : 'off'} · cough ${cal.coughRate ? 'tuned' : 'default'}` : `Not calibrated for <b>${esc(pref.pos)}</b> yet.`;
  $('stanceWrap').hidden = pref.pos !== 'standing';
  $('sRef').value = store.get('gramsRef', '') || store.get('settings', {}).sRef || '';
}
function renderGames() {
  $('games').innerHTML = Object.entries(GAMES).map(([id, g]) => `<div class="gcard"><div><b>${esc(g.name)}</b> <span class="tag">${esc(g.quality)}</span><p class="note">${esc(g.blurb)}</p>
    ${id === 'move' ? `<select id="movePick">${Object.entries(MOVES).map(([k, m]) => `<option value="${k}" ${k === pref.move ? 'selected' : ''}>${esc(m.label)} (${m.pos})</option>`).join('')}</select>` : ''}
    ${id === 'hold' ? `<select id="preset">${Object.entries(HOLD_PRESETS).map(([k, p]) => `<option value="${k}" ${k === pref.preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>` : ''}</div>
    <button class="pri" data-game="${id}">Play</button></div>`).join('');
  $('preset').addEventListener('change', e => { pref.preset = e.target.value; savePref(); });
  $('movePick').addEventListener('change', e => { pref.move = e.target.value; savePref(); });
  for (const b of document.querySelectorAll('[data-game]')) b.addEventListener('click', () => start(b.dataset.game));
}
function renderProgress() { $('progress').innerHTML = progressHTML(store.get('sessions', []), store.get('symptoms', [])) + legacy(); }
function legacy() { const h = store.get('history', []); return h.length ? `<details><summary>Older Hold sessions (v1)</summary><p class="note">${h.length} sets · latest on target ${h[0].avg}% on ${esc(day(h[0].d))}</p></details>` : ''; }

// ------------------------------------------------------------ test hook: ?sim=good&fast=8 drives the app with a simulated player
let simP = null;
if (SIM) { demo = true; cal = { rest: 0, max: 1, restB: 0, restT: 0, rS: 0.40, rB: 0.62 }; setTimeout(() => status('Simulated player: ' + SIM.label), 0); }

// ------------------------------------------------------------ loop
let last = performance.now(), idleTrace = [];
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;   // capped: a frozen screen never fast-forwards a game
  if (demo && !connected && !SIM) { const tgt = demoDown ? 1800 : 200; rawB += (tgt - rawB) * Math.min(1, dt * (demoDown ? 6 : 8)); rawT = rawB; }
  const a = Math.min(1, dt * 18); sB += (rawB - sB) * a; sT += (rawT - sT) * a;
  rawBuf.push({ t: now / 1000, x: smooth() }); while (rawBuf.length && now / 1000 - rawBuf[0].t > 3) rawBuf.shift();
  if (game && !game.done && !gameMeta.zeroed && game.t >= readyEnd(game) - 0.05) autoZero();
  if (game && !game.done) {
    if (SIM) {   // fixed 1/60 s substeps so fast-forwarding never skips a short phase
      const n = Math.round(dt * FAST * 60); simP ??= new Player(SIM, 1);
      for (let i = 0; i < n && !game.done; i++) { const s = simP.sample(game, game.t, 1 / 60); rawB = rawT = s.v; sB = sT = s.v; game.step(1 / 60, s); }
    } else game.step(dt, sample());
    cues();
  }
  if (game) { progressBar(); const v = drawGame($('cv'), game, { big: true }); $('msg').textContent = v.msg; $('tip').hidden = !v.tip; $('tip').textContent = v.tip || ''; if (game.done) finished(); }
  else {   // idle: a simple live view so you can see the signal
    idleTrace.push({ t: now / 1000, v: hasCal() ? norm(smooth()) : 0 }); while (idleTrace.length && now / 1000 - idleTrace[0].t > 6) idleTrace.shift();
    const g = { t: now / 1000, bandAt: () => null, samples: idleTrace, view: () => ({ msg: '', inside: false, hud: {} }) };
    drawGame($('cv'), g);
  }
  $('pct').textContent = hasCal() ? Math.max(0, Math.round(norm(smooth()) * 100)) + '%' : '—';
  requestAnimationFrame(loop);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = performance.now();
  else if (game && !game.done && performance.now() - hiddenAt > 2000) abort('Paused when the screen went off, so that set wasn’t saved. Tip: turn off Auto-Lock while training.');
});

// ------------------------------------------------------------ wiring
$('bConn').onclick = connect; $('topConn').onclick = connect; $('bCal').onclick = calibrate;
$('bForm').onclick = formCheck; $('bCough').onclick = coughRec;
$('bStop').onclick = () => abort();
$('bBack').onclick = () => { planQ = null; show('home'); refresh(); };
$('bNext').onclick = () => nextInPlan();
$('bSym').onclick = () => openSymptoms(false);
$('pos').value = pref.pos; $('pos').onchange = e => { pref.pos = e.target.value; savePref(); zero = 0; cal = demo ? cal : loadCal(); refresh(); };
$('stance').innerHTML = Object.entries(STANCES).map(([k, s]) => `<option value="${k}" ${k === pref.stance ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
$('stance').onchange = e => { pref.stance = e.target.value; savePref(); };
for (const [id, k] of [['sSound', 'sound'], ['sVoice', 'voice'], ['sTips', 'tips'], ['sTipVoice', 'tipVoice']]) { $(id).checked = pref[k]; $(id).onchange = e => { pref[k] = e.target.checked; savePref(); if (pref[k] && (k === 'sound' || k === 'voice')) { beep(); if (k === 'voice') say('Voice on'); } }; }
$('sCh').value = pref.ch; $('sCh').onchange = e => { pref.ch = e.target.value; savePref(); msg('Sensor changed. Please calibrate again.'); cal = { rest: 0, max: 0 }; refresh(); };
$('uEnd').value = pref.end; $('uEnd').onchange = e => { pref.end = e.target.value; savePref(); };
$('sRef').oninput = e => { store.set('gramsRef', e.target.value); refresh(); };
$('bExport').onclick = () => {
  const data = {}; for (const k of ['sessions', 'symptoms', 'cals', 'history', 'gset', 'pref', 'cal:standing', 'cal:sitting', 'cal:lying']) data[k] = store.get(k, null);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: `leakproof-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('fImport').onchange = async e => {
  try { const data = JSON.parse(await e.target.files[0].text()); for (const [k, v] of Object.entries(data)) if (v != null) store.set(k, v); location.reload(); }
  catch { alert('That file could not be read as a Leak Proof backup.'); }
};
renderGames(); renderProgress(); refresh(); show('home'); requestAnimationFrame(loop);
