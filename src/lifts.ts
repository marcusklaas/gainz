// Sessions, templates and exercise identity, plus the strength index the log
// is read for. Pure functions over the same `Map<DayKey, Day>` the estimator
// takes: no storage, no DOM, nothing derived persisted.
import { addDays, atKey, daysBetween } from "./dates.js";
import {
  EPLEY_REPS,
  type Day,
  type DayKey,
  type Draft,
  type DraftExercise,
  type Exercise,
  type Session,
} from "./types.js";

/** A session as it sits in history: the record, plus the day it belongs to. */
export interface DatedSession {
  day: DayKey;
  session: Session;
}

/**
 * What makes two spellings the same movement. "Bench", "bench press" and
 * "Bench  Press" have to land on one series or the history is three exercises
 * with nothing in each, and the fragmentation is unfixable once months of it
 * exist.
 *
 * Derived at read time and never written down, which is both the rule the rest
 * of the app follows and the thing that makes a better rule adoptable later —
 * a stored key would have to be migrated, and would disagree with its own name
 * the moment one was edited. The real defence is not this function anyway: it
 * is the autocomplete over past names, which makes picking the existing
 * exercise cheaper than typing a new one.
 */
export function exerciseKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every session in the window, newest first. */
export function sessionsOf(days: Map<DayKey, Day>): DatedSession[] {
  const out: DatedSession[] = [];
  for (const [day, d] of days) {
    for (const session of d.sessions ?? []) out.push({ day, session });
  }
  // Day first, so it dominates; the stamp only orders sessions within one day.
  const key = ({ day, session }: DatedSession) => day + atKey(session.at);
  return out.sort((a, b) => key(b).localeCompare(key(a)));
}

/** Distinct values of `key` across sessions, most recently used first. A Map
 *  keyed on the normalised form keeps the newest spelling as the display one. */
function recent<T>(list: DatedSession[], each: (s: DatedSession) => Iterable<[string, T]>): T[] {
  const seen = new Map<string, T>();
  for (const item of list) {
    for (const [key, value] of each(item)) if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()];
}

/**
 * The templates. There is no stored list — a template is the name of a session
 * you have done, so the menu is exactly the set of names in history and can
 * never contain something stale. This is the shape favourites lacked (`9ee3265`):
 * nothing to curate, so nothing to rot.
 */
export function templateNames(list: DatedSession[]): string[] {
  return recent(list, ({ session }) =>
    session.name ? [[exerciseKey(session.name), session.name] as [string, string]] : [],
  );
}

/** For the add-exercise autocomplete. Most recently performed first, which is
 *  the order that puts what you are about to do next at the top. */
export function exerciseNames(list: DatedSession[]): string[] {
  return recent(list, ({ session }) =>
    session.exercises.map((e) => [exerciseKey(e.name), e.name] as [string, string]),
  );
}

/**
 * Past exercises matching what has been typed so far, best first. The match is
 * on the normalised key at both ends, so "bicep" and "Bicep " both find "Bicep
 * Curl (Dumbbell)" — anywhere in the name, because the word you remember is
 * often not the one the name starts with ("curl", "incline"). Names that start
 * with the query come first; within each group the recency order of
 * `exerciseNames` survives.
 *
 * This is the defence `exerciseKey` describes: picking the exercise you already
 * have has to be cheaper than retyping it, or the index fragments.
 */
export function matchExercises(names: string[], query: string): string[] {
  const q = exerciseKey(query);
  if (!q) return [];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const key = exerciseKey(name);
    if (key.startsWith(q)) starts.push(name);
    else if (key.includes(q)) contains.push(name);
  }
  return [...starts, ...contains];
}

/** The session a template prefills from. `exceptId` skips the one being edited,
 *  so reopening a saved session does not offer to prefill from itself. */
export function lastSessionNamed(
  list: DatedSession[],
  name: string,
  exceptId?: string,
): Session | null {
  const key = exerciseKey(name);
  const hit = list.find(
    ({ session }) =>
      session.id !== exceptId && session.name && exerciseKey(session.name) === key,
  );
  return hit?.session ?? null;
}

const ghosts = (exercises: Exercise[]): DraftExercise[] =>
  exercises.map((e) => ({
    name: e.name,
    // `done` absent: last session's numbers, offered as a question rather than
    // recorded as an answer. Confirming each one is the point — it is the only
    // moment the app asks whether today actually matched last time.
    sets: e.sets.map((s) => ({ weight_kg: s.weight_kg, reps: s.reps })),
  }));

/** A new session, prefilled from the last one of that name if there was one. */
export function newDraft(day: DayKey, at: string, name: string, from: Session | null): Draft {
  return {
    day,
    id: crypto.randomUUID(),
    at,
    name,
    exercises: from ? ghosts(from.exercises) : [],
  };
}

/** An existing session opened for editing. Everything in it happened, so
 *  everything is already confirmed. */
export function draftOf(day: DayKey, session: Session): Draft {
  return {
    day,
    id: session.id,
    at: session.at,
    name: session.name ?? "",
    exercises: session.exercises.map((e) => ({
      name: e.name,
      sets: e.sets.map((s) => ({ ...s, done: true })),
    })),
  };
}

export const confirmedSets = (d: Draft): number =>
  d.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);

/**
 * The list with one item moved. Order here is the array and nothing else — there
 * is no position field to keep in step, and no id to renumber — so this is the
 * whole of what reordering a session is.
 *
 * Generic because it has no business knowing what it is moving, and returning
 * rather than splicing in place because that is what everything else in this
 * file does. Out-of-range indices return the list untouched, so the ends of a
 * list are the caller's problem only when it wants to say so in the UI.
 */
export function moved<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item === undefined) return list;
  out.splice(to, 0, item);
  return out;
}

/**
 * The draft as it will be stored: unconfirmed sets dropped, exercises left with
 * none dropped with them, the flag stripped. A set you did not do is one you
 * never confirmed — there is no separate way to say so, and no way to record a
 * set that was only ever a suggestion.
 *
 * Null when nothing was confirmed, which is the same as no session at all.
 */
export function finish(d: Draft): Session | null {
  const exercises: Exercise[] = [];
  for (const e of d.exercises) {
    const sets = e.sets.filter((s) => s.done).map((s) => ({ weight_kg: s.weight_kg, reps: s.reps }));
    if (sets.length) exercises.push({ name: e.name, sets });
  }
  if (!exercises.length) return null;

  const name = d.name.trim();
  return { id: d.id, at: d.at, ...(name ? { name } : {}), exercises };
}

/** "5 exercises · 18 sets" — a count rather than tonnage, which rewards light
 *  high-rep work disproportionately and reads as a metric when it is not. */
export function summarise(s: Session): string {
  const sets = s.exercises.reduce((n, e) => n + e.sets.length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(s.exercises.length, "exercise")} · ${plural(sets, "set")}`;
}

// -------------------------------------------------------- the strength index
//
// One number for "am I getting stronger", built the way a chained price index
// is built, because it is the same problem. Sessions alternate Push and Pull,
// so no two consecutive sessions share a single exercise and nothing can be
// compared session to session. Exercises arrive, drift to the back of the
// rotation and leave. The aggregate must not move merely because the basket
// did — so every exercise is matched against its own previous appearance, the
// matched changes are pooled, and the result is chained.
//
// The lifting-side twin of what estimate() does for weight: one noisy series
// in, a trend and an honest error bar out. See STRENGTH.md for what was
// measured, what was rejected, and what is still unverified.

/** One exercise on one day: the atom everything below is built from. */
export interface LiftPoint {
  day: DayKey;
  /** `exerciseKey(name)` — what makes two spellings one series. */
  key: string;
  /** The spelling used that day, for display. */
  name: string;
  /** log of the best set's Epley e1RM. */
  x: number;
}

/**
 * Logs, because strength changes proportionally, and because every e1RM formula
 * has the shape `weight × f(reps)` — so the log splits into `log weight +
 * log f(reps)` and the rep term cancels exactly between two sessions that used
 * the same reps, which is nearly all of them.
 *
 * The best set, not the average of the sets. The average is marginally quieter
 * and much easier to fool: a warm-up ramp that later becomes three straight sets
 * at the top weight reads as an enormous gain, and an exercise cut from three
 * sets to one reads as an enormous loss, in both cases because the programming
 * changed and not the strength. The top set is the strength proxy; the rest is
 * volume, which is a different thing this is not measuring.
 *
 * One point per exercise per *day*, not per session — two sessions on one day
 * are zero days apart, and the index below divides by the days a link covers.
 * Taking the better of the two is the same top-set rule one level up.
 */
export function e1rmPoints(list: DatedSession[]): LiftPoint[] {
  const best = new Map<string, LiftPoint>();
  for (const { day, session } of list) {
    for (const ex of session.exercises) {
      // A set with no load is not a lighter set of the same movement, it is no
      // reading at all — bodyweight work cannot enter until the added weight is
      // known. Reps decide alongside it: a set of none did not happen.
      const top = Math.max(
        0,
        ...ex.sets.filter((s) => s.weight_kg > 0 && s.reps > 0)
          .map((s) => s.weight_kg * (1 + s.reps / EPLEY_REPS)),
      );
      if (!top) continue;

      const key = exerciseKey(ex.name);
      const id = `${day} ${key}`;
      const seen = best.get(id);
      if (!seen || top > Math.exp(seen.x)) best.set(id, { day, key, name: ex.name, x: Math.log(top) });
    }
  }
  return [...best.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The points of one day at a time, oldest first. */
function byDay(points: LiftPoint[]): LiftPoint[][] {
  const days = new Map<DayKey, LiftPoint[]>();
  for (const p of points) days.set(p.day, [...(days.get(p.day) ?? []), p]);
  return [...days.values()];
}

/** A level, in log points, on the day it was reached. */
export interface IndexPoint {
  day: DayKey;
  x: number;
}

/**
 * The chained index:
 *
 *     SI += (Σ log-change of the exercises trained)
 *           ÷ (Σ exercise-days that covers)
 *           × (days since the previous session)
 *
 * The pooled rate at which the things you actually trained are improving,
 * integrated over time. An exercise appearing for the first time has nothing to
 * be matched against and so contributes nothing: it can join the index, never
 * move it. That is what makes adding exercises unable to inflate anything.
 *
 * The denominator is exercise-days rather than the size of the basket. The two
 * are identical whenever everything is trained on the same cadence, and part
 * company when cadences differ — which is the real case. An exercise drifting
 * toward the back of the rotation keeps occupying a slot in a basket-sized
 * denominator while contributing no change, which understates the rate badly.
 * Dividing by the time actually covered is self-normalising: an exercise counts
 * exactly when, and as much as, it informs. It costs some wander, and that is
 * the better trade — a bias makes the number wrong, wander only makes it
 * imprecise, and the verdict below carries its own error bar regardless.
 *
 * The level has no absolute meaning and by construction cannot acquire one: it
 * is defined only up to an additive constant. It answers "how much stronger
 * than then", never "how strong". The first point is therefore always zero, and
 * the chart rebases from there.
 *
 * Every link reads only data at or before its own day, so yesterday's value
 * never moves when today is logged.
 */
export function strengthIndex(points: LiftPoint[]): IndexPoint[] {
  const out: IndexPoint[] = [];
  const previous = new Map<string, LiftPoint>();
  let si = 0;
  let before: DayKey | null = null;

  for (const today of byDay(points)) {
    const day = today[0]!.day;
    let change = 0; // Σ log-change over the matched exercises
    let covered = 0; // Σ days each of those matches spans

    for (const p of today) {
      const was = previous.get(p.key);
      if (!was) continue;
      change += p.x - was.x;
      covered += daysBetween(was.day, day);
    }
    if (covered > 0 && before) si += (change / covered) * daysBetween(before, day);

    for (const p of today) previous.set(p.key, p);
    before = day;
    out.push({ day, x: si });
  }
  return out;
}

/** A fitted rate and how well it is pinned down, over a stated window. */
export interface Fit {
  /** Log points per day. */
  perDay: number;
  stdErrPerDay: number;
  /** Exercise-days the fit saw, and how many distinct exercises they covered. */
  points: number;
  exercises: number;
  windowDays: number;
}

/**
 * OLS of `x` on day, with one intercept per exercise, over the window.
 *
 * One intercept per exercise means only within-exercise change is fitted and
 * each exercise's own level is absorbed — which is again what stops adding
 * exercises from inflating anything, and what lets the fit use every session in
 * the window rather than only its endpoints. Fitting the index instead would
 * give the same point estimate and a dishonest interval: index points share
 * measurement noise with their neighbours, which OLS assumes away, and a
 * two-sigma test on them fires on a fifth of histories that are genuinely flat.
 * So the index is the picture and this is the verdict.
 *
 * Implemented by demeaning within each exercise, which is the same fit without
 * building the dummy columns. An exercise appearing once in the window demeans
 * to nothing and consumes exactly the one degree of freedom its intercept
 * costs, so it is dropped outright: including it would change no part of the
 * arithmetic and would overstate what the number was built from, which is the
 * one thing the counts below are there to report.
 */
export function panelFit(all: LiftPoint[], windowDays: number): Fit | null {
  const groups = new Map<string, LiftPoint[]>();
  for (const p of all) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
  for (const [key, g] of groups) if (g.length < 2) groups.delete(key);

  const points = [...groups.values()].flat();
  const df = points.length - groups.size - 1;
  if (df < 1) return null;

  const origin = points[0]!.day;
  const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
  const centred: { t: number; x: number }[] = [];
  let stt = 0;
  let stx = 0;

  for (const g of groups.values()) {
    const mt = mean(g.map((p) => daysBetween(origin, p.day)));
    const mx = mean(g.map((p) => p.x));
    for (const p of g) {
      const t = daysBetween(origin, p.day) - mt;
      const x = p.x - mx;
      centred.push({ t, x });
      stt += t * t;
      stx += t * x;
    }
  }
  if (stt === 0) return null; // every point of every exercise on one day

  const perDay = stx / stt;
  let sse = 0;
  for (const c of centred) sse += (c.x - perDay * c.t) ** 2;

  return {
    perDay,
    stdErrPerDay: Math.sqrt(sse / df / stt),
    points: points.length,
    exercises: groups.size,
    windowDays,
  };
}

/**
 * The fit as a total over its own window, as a proportion: 0.45 is +45%.
 * Reported as a total rather than a rate because the window is the honest unit
 * of the computation. `sigmas` walks the interval out; two of them is what the
 * app shows and what decides whether it says anything at all.
 */
export const fitTotal = (f: Fit, sigmas = 0): number =>
  Math.exp((f.perDay + sigmas * f.stdErrPerDay) * f.windowDays) - 1;

export interface Strength {
  /** The chained level, one point per training day, oldest first. */
  index: IndexPoint[];
  /** The verdict over the last `windowDays`. Null until there is enough. */
  fit: Fit | null;
}

/**
 * Everything the screens read, from the sessions they already have. Nothing is
 * persisted and nothing is cached: it is a few hundred points of arithmetic,
 * and recomputing it is what lets a better estimator improve the whole history
 * retroactively.
 *
 * The whole basket, every time. Which exercises belong in the index is a
 * question worth asking — `panelFit` restricted to any subset of the points is
 * the same fit, and restricted to one exercise it degenerates to plain OLS on
 * that series — but it is a question for the screen to ask, not for this to
 * answer by picking for you.
 */
export function strengthOf(list: DatedSession[], today: DayKey, windowDays: number): Strength {
  const points = e1rmPoints(list);
  const from = addDays(today, -windowDays);
  // Bounded at both ends. Nothing later than `today` normally exists — the
  // caller loads history up to the day on screen — but a window is a window,
  // and one open at the top would quietly answer about a different stretch than
  // the one it names.
  const recent = points.filter((p) => p.day >= from && p.day <= today);

  return { index: strengthIndex(points), fit: panelFit(recent, windowDays) };
}
