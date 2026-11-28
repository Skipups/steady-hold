// "What should I do now?" Pure function: history in, next session out.
// Order within a session: warm-up → strength while fresh → endurance under load → skill → let go.
// Endurance focus per her PT: quick squeeze is strong, long and moving holds fade.

const DAY = 864e5, H = 36e5;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export const STEP = {
  warm:   { game: 'breath', opts: { reps: 4 }, label: 'Breath Sync (4 breaths)', why: 'Warm-up: wakes up the lift-on-exhale pattern before hard work.' },
  daily:  { game: 'hold', preset: 'daily', label: 'Hold the Line · Daily set', why: 'Your strength work: 10 strong 8 s holds + quick flicks.' },
  move:   { game: 'move', label: 'Squeeze & Move', why: 'Your main goal: keeping the squeeze while your body works.' },
  long:   { game: 'hold', preset: 'long', label: 'Hold the Line · Long hold', why: 'Pure endurance: 60 s at a gentle 30–50%.' },
  knack:  { game: 'knack', opts: { cues: ['cough', 'sneeze', 'cough', 'laugh'] }, label: 'Cough Shield (4 cues)', why: 'Practice squeezing BEFORE a cough or sneeze. The fastest way to cut those leaks.' },
  flicks: { game: 'flicks', label: 'Quick Flicks', why: 'Keeps the fast squeeze you already have.' },
  elevator: { game: 'elevator', label: 'Elevator', why: 'Control: grading your squeeze up and down.' },
  wave:   { game: 'wave', label: 'Trace the Wave', why: 'Coordination: following a moving target.' },
  power:  { game: 'power', label: 'Power Punch', why: 'Weekly strength check: try for a new record.' },
  melt:   { game: 'melt', label: 'Melt', why: 'Your recent sets showed slow or missed releases. Letting go matters as much as squeezing.' },
  checkup:{ game: 'checkup', label: 'Monthly Check-up', why: 'Your monthly report card: strength, hold time, repeat holds, quick flicks, Cough Shield and symptoms.' },
};

// One session a day, 4–5 days a week (Bø: 8–12 strong holds in three series, 3–4×/week builds strength;
// consistency over months matters more than volume). A Check-up replaces that day's session: it is a full
// workout by itself, and training first would tire you and skew the results.
const WEEK_GOAL = 4;
export function recommend(sessions, now = Date.now(), { guardOn = false } = {}) {
  const S = sessions.filter(s => s.d && !s.sim && !s.replaced);
  const today = S.filter(s => sameDay(s.d, now));
  const since = (game, f = () => true) => { const s = S.find(x => x.game === game && f(x)); return s ? (now - new Date(s.d)) / DAY : Infinity; };
  const recent = S.filter(s => now - new Date(s.d) < 3 * DAY).slice(0, 10);
  const daysTrained = new Set(S.filter(s => now - new Date(s.d) < 7 * DAY).map(s => new Date(s.d).toDateString())).size;
  const week = `${Math.min(daysTrained, 7)} of ${WEEK_GOAL} days this week`;
  const checkupToday = today.some(s => s.game === 'checkup');
  const sessionToday = today.some(s => s.game === 'hold' && s.preset === 'daily');
  const checkupDue = since('checkup') >= 28;
  const base = { week, daysTrained, weekGoal: WEEK_GOAL, checkupDue: false };

  // what recent results say
  const strained = recent.some(s => s.metrics?.strainReps > 0);
  const tight = recent.filter(s => s.metrics?.relaxMissed > 0 || (s.metrics?.relaxMedian ?? 0) > 1.5 || (s.game === 'melt' && s.score < 50)).length >= 2;
  const stillFade = recent.find(s => s.game === 'move')?.metrics?.stillFade;
  const overdue = [['flicks', 3], ['elevator', 5], ['wave', 5], ['power', 7]].map(([g, d]) => [g, since(g) - d]).filter(x => x[1] >= 0).sort((a, b) => b[1] - a[1]);

  if (checkupToday) return { ...base, done: true, redo: true, title: 'Check-up done ✓', steps: [], extra: null,
    notes: ['That counts as today’s session. Rest now; tomorrow it’s back to your usual session.'] };

  if (checkupDue && !sessionToday) return { ...base, done: false, checkupDay: true, title: 'Today: Monthly Check-up', steps: [STEP.checkup], minutes: 7,
    notes: ['It replaces today’s session: it’s a full workout on its own, and doing exercises first would tire you and skew the results.', 'Do it standing, fresh, ideally at the same time of day each month.'] };

  // tomorrow's alternation: Squeeze & Move one day, Long hold + a skill game the next
  const moveDay = since('move') >= since('hold', s => s.preset === 'long');
  const extra = [STEP.warm, STEP.daily, overdue.length ? STEP[overdue[0][0]] : STEP.flicks];

  if (sessionToday) {
    const notes = [`${week}.`, 'More isn’t required. Muscles get stronger while resting. An extra set is optional, if you feel fresh.'];
    if (checkupDue) notes.push('Your monthly Check-up is due. Make it tomorrow’s session instead of your usual exercises.');
    return { ...base, done: true, title: 'Today’s session done ✓', steps: [], extra, notes };
  }

  const steps = [STEP.warm, STEP.daily];
  if (moveDay) steps.push(STEP.move); else { steps.push(STEP.long); if (overdue.length) steps.push(STEP[overdue[0][0]]); }
  steps.push(STEP.knack);
  if (tight) steps.push(STEP.melt);

  const notes = [];
  if (strained) notes.push(guardOn ? 'Some recent reps looked like bearing down. Think “lift up and in”, belly light, keep breathing.' : 'Some recent reps looked like bearing down. Consider redoing the Form check in Setup.');
  if (stillFade != null && stillFade < 0.8) notes.push('Your still hold faded across your last Squeeze & Move set: that’s the endurance you’re building. Stick with it.');
  if (tight) notes.push('Recent sets showed slow releases, so Melt is added at the end.');
  notes.push(`${week} so far.`);

  return { ...base, done: false, title: 'Today’s session', steps, extra: null, notes,
    minutes: Math.round(steps.reduce((m, s) => m + ({ breath: 0.8, hold: s.preset === 'long' ? 1.3 : 2.6, move: 3, knack: 0.8, flicks: 0.6, elevator: 0.6, wave: 0.6, power: 0.7, melt: 1.3 }[s.game] ?? 1), 0)) };
}
