// Universal constants only. Anything personal or tunable lives in config.json
// in the private data repo. See PLAN.md "Constants policy".

/** Approximation. Fine because TDEE is continuously re-derived from fresh data. */
export const KCAL_PER_KG_FAT = 7700;
export const DAYS_PER_WEEK = 7;

/** Mifflin-St Jeor published coefficients. */
export const MIFFLIN = { weight: 10, height: 6.25, age: 5, maleOffset: 5, femaleOffset: -161 };

/**
 * Epley's divisor: e1RM = weight × (1 + reps / 30). Which formula is used
 * barely matters here — Brzycki and Lombardi land within a point of it over ten
 * weeks, because almost every set in the log is at the same reps and the rep
 * term cancels between two sessions that share them. Epley is the one people
 * recognise.
 */
export const EPLEY_REPS = 30;

/** Local calendar date, "YYYY-MM-DD". Never a UTC timestamp. */
export type DayKey = string;
/** "YYYY-MM" */
export type MonthKey = string;

export interface FoodItem {
  id: string;
  /**
   * When it was entered: an ISO 8601 instant in UTC, and the key the day's
   * items are ordered by. Older files carry "19:40", local — see `atKey`.
   */
  at: string;
  /** The description as typed. Doubles as the text the estimate was made from. */
  name: string;
  kcal: number;
  protein_g: number;
  /**
   * Which model produced the numbers, absent when they were typed by hand —
   * which is the whole of the provenance. There was a separate "llm" | "manual"
   * field alongside this saying the same thing, and nothing read it.
   *
   * Older files carry that field, plus grams and sourceText from a version that
   * logged several items per description. None are declared here because none
   * are read; they survive on disk regardless, since merges copy whole items.
   */
  model?: string;
}

/** One performed set. Weight in kg, matching `Day.weight_kg` — the app has no
 *  unit setting and is not getting one. */
export interface LiftSet {
  weight_kg: number;
  reps: number;
}

/**
 * The sets of one movement within a session. Identified by its name and nothing
 * else: the session is the unit merges resolve at, so an id here would have no
 * reader. Names are matched with `exerciseKey` at read time rather than being
 * given a stored key, so nothing derived lands on disk.
 */
export interface Exercise {
  name: string;
  sets: LiftSet[];
}

/**
 * A training session. Deliberately the same shape as a `FoodItem` — an
 * id-bearing record in a flat array hanging off a day — so it merges the same
 * way: two devices adding different sessions to one day both keep theirs, and
 * two editing the same session resolve last-writer-wins at the session level.
 *
 * `name` doubles as the template name. There is no separate template store:
 * selecting "Push" finds the most recent session called "Push" and prefills
 * from it, so a template is always the last session actually done rather than a
 * curated list that drifts out of date.
 */
export interface Session {
  id: string;
  /** When the session was started, stamped and ordered like `FoodItem.at`. */
  at: string;
  /** Absent on a one-off that was never named, which is also never a template. */
  name?: string;
  exercises: Exercise[];
}

export interface Day {
  weight_kg?: number;
  /**
   * The calorie target the app actually displayed on this day, written once and
   * never revised. The bias accumulator measures how far intake landed from what
   * the user was told, so it has to read the number they saw — not one re-derived
   * later from more data. Absent on days that predate the feature, or that were
   * logged without opening the app that day.
   */
  goal_kcal?: number;
  items: FoodItem[];
  /** Absent rather than empty on the overwhelming majority of days, so no file
   *  grows a key for a feature it never used. */
  sessions?: Session[];
  /**
   * Set only when the user says so. Absent means the day is not fully logged
   * and nothing derived reads it.
   *
   * There is deliberately no auto-classifier. A forgotten dinner still clears
   * any intake threshold you could pick, so guessing admits exactly the days
   * that are worst to admit: ones that look complete and land low. Each of
   * those drags TDEE and every following day's target down with it.
   *
   * Files written before this was explicit may carry "incomplete", which reads
   * the same as absent.
   */
  logging?: "complete";
}

export interface MonthFile {
  version: 1;
  days: Record<DayKey, Day>;
}

// ------------------------------------------------------- the session in progress
//
// Local only. A draft lives in localStorage and never enters the outbox, so an
// unfinished session is not a session — it is not in the repo, not merged, and
// invisible to every other device and to everything derived. What localStorage
// buys is the hour between the first set and the last: the phone locks, the tab
// is evicted, and the session is still there. In memory alone it would not be.

/** A set that may not have happened yet. Prefilled rows arrive with `done`
 *  absent — they are last session's numbers offered as a question, and are
 *  dropped on save unless confirmed. */
export interface DraftSet extends LiftSet {
  done?: boolean;
}

export interface DraftExercise {
  name: string;
  sets: DraftSet[];
}

/**
 * The session being edited, new or existing. `day` and `id` are what saving
 * writes against: an id already on that day replaces it, anything else is
 * appended. Editing a saved session therefore goes through exactly the same
 * screen and the same save path as creating one.
 */
export interface Draft {
  day: DayKey;
  id: string;
  /** Carried through to `Session.at` on save, so it dates the start of the
   *  session rather than the moment it was finished. */
  at: string;
  name: string;
  exercises: DraftExercise[];
}

/**
 * What to aim for. The sign of the offset is the phase — there is no separate
 * cut/maintain/bulk field, because it would only ever restate it. When a phase
 * started and when to review it are answered by the data repo's own history:
 * every change to this file is a commit with a date on it.
 */
export interface Goal {
  /** Added to TDEE to give the day's calorie goal. Negative cuts, positive bulks. */
  kcalOffset: number;
  /** Full width of the band around the goal; half of it lands on each side. */
  kcalWindow: number;
  proteinGPerKg: number;
}

export interface Config {
  version: 1;
  bio: {
    heightCm: number;
    /** "YYYY-MM-DD". Only the age it implies is ever used. */
    birth: string;
    sex: "m" | "f";
  };
  goal: Goal;
  estimator: {
    /** Holt level half-life: how fast the smoothed weight follows the scale. */
    levelHalfLifeDays: number;
    /** Holt trend half-life: how fast the estimated slope adapts. Longer is calmer. */
    trendHalfLifeDays: number;
    /** How far back to load. Warms up the smoother and sets the chart span. */
    historyDays: number;
    /** How far past the last weigh-in the chart carries the current slope. 0 hides it. */
    projectionDays: number;
    tdeeWindowDays: number;
    blendFullConfidenceDays: number;
    activityFactor: number;
    /** Fraction of the accumulated bias handed back per day. 0 disables the correction. */
    biasGain: number;
    /** Leak applied to the bias per counted day. 0.96 is a ~17-day half-life. */
    biasLeak: number;
    /** Anti-windup cap on the accumulated bias, kcal. */
    biasMaxKcal: number;
  };
  strength: {
    /** How far back the strength verdict and its decomposition are fitted. */
    windowDays: number;
  };
  llm: { provider: Provider; model: string };
  notifications: Notifications;
}

/** A daily nudge, or not. "HH:MM" local — there is no timezone here beyond
 *  whatever the device thinks the time is. */
export interface Reminder {
  enabled: boolean;
  time: string;
}

export interface Notifications {
  /** Weigh-in. Stays quiet once the day has a weight. */
  weight: Reminder;
  /** Confirming the day is fully logged. Stays quiet once it is ticked. */
  nutrition: Reminder;
}

export type Provider = "anthropic" | "openai";

export function emptyDay(): Day {
  return { items: [] };
}

export function emptyMonth(): MonthFile {
  return { version: 1, days: {} };
}
