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

export function nowTime(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function humanDay(day: DayKey): string {
  const d = parseDay(day);
  const today = todayKey();
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
