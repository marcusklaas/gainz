// Sessions, templates and exercise identity. Pure functions over the same
// `Map<DayKey, Day>` the estimator takes: no storage, no DOM, nothing derived
// persisted. The e1RM series and everything that reads it will land here too.
import { atKey } from "./dates.js";
import type {
  Day,
  DayKey,
  Draft,
  DraftExercise,
  Exercise,
  Session,
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
