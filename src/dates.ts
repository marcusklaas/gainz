// All dates are LOCAL calendar dates. new Date("2026-07-25") parses as UTC and
// will silently misfile late-night entries, so day keys are always built from
// local Y/M/D components and parsed back the same way.
import type { DayKey, MonthKey } from "./types.js";

const pad = (n: number) => String(n).padStart(2, "0");

export function toDayKey(d: Date): DayKey {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(): DayKey {
  return toDayKey(new Date());
}

/** Local midnight of the given day. */
export function parseDay(day: DayKey): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function monthOf(day: DayKey): MonthKey {
  return day.slice(0, 7);
}

export function addDays(day: DayKey, n: number): DayKey {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return toDayKey(d);
}

/** Whole days from a to b. Positive when b is later. */
export function daysBetween(a: DayKey, b: DayKey): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

// ------------------------------------------------------------- `at` stamps
//
// Food items and sessions are stamped with when they were entered, and that
// stamp is what orders them. It used to be local "HH:MM", which is neither
// monotonic nor unique: logging yesterday's dinner this morning filed it by
// this morning's clock, so it landed in the middle of yesterday's list rather
// than the end of it, and two entries in one minute compared equal. An instant
// in UTC is the entry order, is comparable across both devices, and separates
// entries a second apart.

/** When something was entered: an ISO 8601 instant, UTC, to the millisecond. */
export function nowStamp(): string {
  return new Date().toISOString();
}

/** The "HH:MM" local clock time `at` held before it became an instant. */
const LEGACY_AT = /^\d\d:\d\d$/;

/**
 * Sort key for an `at` stamp. Legacy values sort ahead of every instant rather
 * than by their own text — "08:30" would compare before an ISO string and
 * "23:50" after it, interleaving the two formats on the one day that holds
 * both. Anything still carrying the old format was entered before anything
 * carrying the new one, so first is also correct.
 */
export const atKey = (at: string): string => (LEGACY_AT.test(at) ? `0${at}` : `1${at}`);

/** Entry order, oldest first. The single rule for ordering anything `at`-stamped. */
export const byAt = (a: { at: string }, b: { at: string }): number =>
  atKey(a.at).localeCompare(atKey(b.at));

/** An `at` stamp as local clock time. Legacy values already are one. */
export function atTime(at: string): string {
  if (LEGACY_AT.test(at)) return at;
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function humanDay(day: DayKey): string {
  const d = parseDay(day);
  const today = todayKey();
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
