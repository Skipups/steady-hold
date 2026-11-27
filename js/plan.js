// "What should I do now?" Pure function: history in, next session out.
// Dose from the research (Bø protocol, Cochrane): ~3 sets a day of 8–12 near-max holds, at least 3–4 days a week,
// for 3–5 months. Order within a set: warm-up → strength while fresh → endurance under load → skill → let go.
// Endurance focus per her PT: quick squeeze is strong, long and moving holds fade.

const DAY = 864e5, H = 36e5;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export const STEP = {
  warm:   { game: 'breath', opts: { reps: 4 }, label: 'Breath Sync (4 breaths)', why: 'Warm-up: wakes up the lift-on-exhale pattern before hard work.' },
  daily:  { game: 'hold', preset: 'daily', label: 'Hold the Line · Daily set', why: 'Your strength dose: 10 near-max 8 s holds + flicks. Done ~3× a day.' },
  move:   { game: 'move', label: 'Squeeze & Move', why: 'Your main goal: keeping the squeeze while your body works.' },
  long:   { game: 'hold', preset: 'long', label: 'Hold the Line · Long hold', why: 'Pure endurance: 60 s at a gentle 30–50%.' },
  knack:  { game: 'knack', opts: { cues: ['cough', 'sneeze', 'cough', 'laugh'] }, label: 'Cough Shield (4 cues)', why: 'The Knack: squeeze before coughs and sneezes. Fastest way to cut leaks.' },
  flicks: { game: 'flicks', label: 'Quick Flicks', why: 'Keeps the fast squeeze you already have.' },
  elevator: { game: 'elevator', label: 'Elevator', why: 'Control: grading your squeeze up and down.' },
  wave:   { game: 'wave', label: 'Trace the Wave', why: 'Coordination: following a moving target.' },
  power:  { game: 'power', label: 'Power Punch', why: 'Weekly strength check: try for a new record.' },
  melt:   { game: 'melt', label: 'Melt', why: 'Your recent sets showed slow or missed releases. Letting go matters as much as squeezing.' },
  checkup:{ game: 'checkup', label: 'Monthly Check-up', why: 'Your monthly report card: P/E/R/F, Cough Shield, symptoms. Same position every time.' },
};

// A "set" = one run through a plan. We count Daily-set sessions to know how many sets were done today.
export function recommend(sessions, now = Date.now(), { guardOn = false } = {}) {
  const S = sessions.filter(s => s.d && !s.sim);
  const today = S.filter(s => sameDay(s.d, now));
  const setsToday = today.filter(s => s.game === 'hold' && s.preset === 'daily').length;
  const lastDaily = S.find(s => s.game === 'hold' && s.preset === 'daily');
  const since = (game, f = () => true) => { const s = S.find(x => x.game === game && f(x)); return s ? (now - new Date(s.d)) / DAY : Infinity; };
  const recent = S.filter(s => now - new Date(s.d) < 3 * DAY).slice(0, 10);
  const notes = [];

  // 1. check-up due (monthly) — offered first, never forced
  const checkupDue = since('checkup') >= 28;

  // 2. enough for today?
  if (setsToday >= 3) {
    return { done: true, title: 'You’ve done today’s 3 sets 🎉', steps: [], checkupDue,
      notes: ['More isn’t better: muscles get stronger while resting. Come back tomorrow.', 'Optional: a few rounds of Melt before bed if you feel tight.'] };
  }

  // 3. spacing between sets
  const hoursSince = lastDaily ? (now - new Date(lastDaily.d)) / H : Infinity;
  if (setsToday > 0 && hoursSince < 2) notes.push(`Your last set was ${Math.round(hoursSince * 60)} min ago. Spacing sets ~2+ hours apart works better, but go ahead if this is your only window.`);

  // 4. what recent results say
  const strained = recent.some(s => s.metrics?.strainReps > 0);
  const tight = recent.filter(s => s.metrics?.relaxMissed > 0 || (s.metrics?.relaxMedian ?? 0) > 1.5 || (s.game === 'melt' && s.score < 50)).length >= 2;
  const stillFade = recent.find(s => s.game === 'move')?.metrics?.stillFade;

  const steps = [STEP.warm, STEP.daily];
  // focus slot by set number: set 1 = moving endurance (freshest), set 2 = long hold or moving again, set 3 = skill
  if (setsToday === 0) steps.push(STEP.move);
  else if (setsToday === 1) steps.push(since('hold', s => s.preset === 'long') >= 1.5 ? STEP.long : STEP.move);
  // skill slot: the Knack most sets; fast/control games rotate in when they're overdue
  const overdue = [['flicks', 3], ['elevator', 4], ['wave', 4], ['power', 7]].map(([g, d]) => [g, since(g) - d]).filter(x => x[1] >= 0).sort((a, b) => b[1] - a[1]);
  if (setsToday === 2 && overdue.length) steps.push(STEP[overdue[0][0]]);
  else if (since('knack') >= 0.4) steps.push(STEP.knack);
  else if (overdue.length) steps.push(STEP[overdue[0][0]]);
  if (tight) steps.push(STEP.melt);

  if (strained) notes.push(guardOn ? 'Some recent reps looked like bearing down. Think “lift up and in”, belly light, keep breathing.' : 'Some recent reps looked like bearing down. Consider redoing the Form check in Setup.');
  if (stillFade != null && stillFade < 0.8) notes.push('Your still hold faded across your last Squeeze & Move set: that’s the endurance you’re building. Stick with it.');
  if (tight) notes.push('Recent sets showed slow releases, so Melt is added at the end.');
  const daysTrained = new Set(S.filter(s => now - new Date(s.d) < 7 * DAY).map(s => new Date(s.d).toDateString())).size;
  if (S.length && daysTrained < 3) notes.push(`You trained on ${daysTrained} of the last 7 days. Aim for at least 3–4 days a week, daily if you can.`);

  return { done: false, title: `Set ${setsToday + 1} of 3 today`, steps, checkupDue, notes,
    minutes: Math.round(steps.reduce((m, s) => m + ({ breath: 0.8, hold: s.preset === 'long' ? 1.3 : 2.6, move: 3, knack: 0.8, flicks: 0.6, elevator: 0.6, wave: 0.6, power: 0.7, melt: 1.3 }[s.game] ?? 1), 0)) };
}
