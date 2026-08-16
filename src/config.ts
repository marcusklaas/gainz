// The settings form, described once.
//
// Every setting is one row: the id of the input that edits it, where it lives
// in config.json, and the value to use when the stored config does not have it.
// Filling the form, reading it back, and the defaults a loaded config is merged
// over are all loops over this table.
//
// It used to be four hand-written copies of the same mapping — the fill, the
// inverse read, a suggested-config literal, and a check for keys the stored
// config predated. Adding a setting meant editing all four, and the check
// existed largely to catch the case where you had not.
import type { Config } from "./types.js";

export type FieldValue = number | string | boolean;

/** The input's type follows from the default: boolean is a checkbox, number a
 *  number box, string a text box or a select. */
export type Field = readonly [id: string, path: string, fallback: FieldValue];

export const FIELDS: readonly Field[] = [
  ["g-offset", "goal.kcalOffset", 0],
  ["g-window", "goal.kcalWindow", 400],
  ["g-protein", "goal.proteinGPerKg", 1.6],

  ["b-height", "bio.heightCm", 192],
  ["b-birth", "bio.birth", "1991-03-15"],
  ["b-sex", "bio.sex", "m"],

  ["e-activity", "estimator.activityFactor", 1.4],
  // Six days each. The old 10/28 was chosen when only the level was read, and a
  // 28-day trend half-life does draw a beautifully smooth line — but the slope
  // behind it takes months to catch a rate that changed. Now that TDEE is
  // derived from that slope, the lag is the whole ballgame: on a dead-steady
  // -0.5 kg/week it still read -0.39 after sixty days, a 22% undercount worth
  // about 120 kcal/day. Six catches a real change inside a fortnight, and is
  // what this deployment's own config has been running regardless.
  ["e-level", "estimator.levelHalfLifeDays", 6],
  ["e-trend", "estimator.trendHalfLifeDays", 6],
  ["e-history", "estimator.historyDays", 180],
  ["e-window", "estimator.tdeeWindowDays", 21],
  ["e-confidence", "estimator.blendFullConfidenceDays", 14],
  ["e-bias-gain", "estimator.biasGain", 0.3],
  ["e-bias-leak", "estimator.biasLeak", 0.96],
  ["e-bias-max", "estimator.biasMaxKcal", 900],

  // Six weeks: long enough for the interval to be useful, short enough to be
  // about now. Everything else the strength index could have had a knob for —
  // break threshold, staleness, basket rule, smoothing — was removed by the
  // design rather than defaulted.
  ["s-window", "strength.windowDays", 42],

  ["e-provider", "llm.provider", "anthropic"],
  ["e-model", "llm.model", "claude-sonnet-5"],

  // Off by default, because a reminder nobody asked for is worse than none.
  ["n-weight-on", "notifications.weight.enabled", false],
  ["n-weight-at", "notifications.weight.time", "08:00"],
  ["n-food-on", "notifications.nutrition.enabled", false],
  ["n-food-at", "notifications.nutrition.time", "21:00"],
];

export function at(obj: unknown, path: string): unknown {
  let o = obj;
  for (const key of path.split(".")) {
    if (o === null || typeof o !== "object") return undefined;
    o = (o as Record<string, unknown>)[key];
  }
  return o;
}

export function put(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let o = obj;
  for (const key of keys) {
    const next = o[key];
    if (typeof next !== "object" || next === null) o[key] = {};
    o = o[key] as Record<string, unknown>;
  }
  o[last] = value;
}

/** A stored value only beats the default when it is the right shape. */
function usable(value: unknown, fallback: FieldValue): boolean {
  if (typeof value !== typeof fallback) return false;
  return typeof value !== "number" || Number.isFinite(value);
}

/**
 * Every field present and of the right type, whatever the stored config left
 * out. This is what lets the rest of the app assume its numbers are numbers.
 *
 * It stands in for a migration step: a key added after a config was written
 * reads as its default until the next save writes it down, so there is no
 * half-configured state for anything downstream to detect or refuse. Keys not
 * in the table are dropped, which is also what the old form-to-literal write
 * path did — the table is the whole definition of the file.
 */
/**
 * Birth was kept to the month before the form had a date picker. A date input
 * will not show a value it cannot parse, so a config written back then has to
 * be given a day — mid-month, the least wrong guess for one never recorded.
 * Anything still unparseable is not a date and falls back like any other field.
 */
function birthDate(stored: unknown, fallback: string): string {
  const s = typeof stored === "string" ? stored : "";
  const dated = /^\d{4}-\d{2}$/.test(s) ? `${s}-15` : s;
  return /^\d{4}-\d{2}-\d{2}$/.test(dated) ? dated : fallback;
}

export function withDefaults(raw: unknown): Config {
  const out: Record<string, unknown> = { version: 1 };
  for (const [, path, fallback] of FIELDS) {
    const stored = at(raw, path);
    if (path === "bio.birth") put(out, path, birthDate(stored, fallback as string));
    else put(out, path, usable(stored, fallback) ? stored : fallback);
  }
  // Sound because the table covers every field of Config, which is the one
  // invariant this module exists to hold.
  return out as unknown as Config;
}

export const defaultConfig = (): Config => withDefaults(null);
