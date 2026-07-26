// Local cache + outbox over the GitHub repo.
//
// Writes are optimistic: they land in localStorage immediately and are queued
// for sync. Logging on mobile with poor signal is the normal case, so this is
// the only write path in the app.
//
// Conflicts resolve per day. The outbox records which day keys changed locally;
// on flush we re-read the remote month, overwrite just those days, and PUT.
// Two devices editing different days both survive; the same day is last-write-
// wins, which is the right trade for one user with a phone and a laptop.
import { getFile, putFile } from "./github.js";
import { loadSettings, type Settings } from "./settings.js";
import { addDays, monthOf } from "./dates.js";
import {
  emptyDay,
  emptyFavorites,
  emptyMonth,
  type Config,
  type Day,
  type DayKey,
  type FavoritesFile,
  type MonthFile,
  type MonthKey,
} from "./types.js";

const CACHE = "gainz.cache.";
const OUTBOX = "gainz.outbox";

/** path -> changed day keys, or null meaning "replace the whole file". */
type Outbox = Record<string, DayKey[] | null>;

export const CONFIG_PATH = "config.json";
export const FAVORITES_PATH = "favorites.json";

export function monthPath(m: MonthKey): string {
  return `data/${m.slice(0, 4)}/${m}.json`;
}

function settings(): Settings {
  const s = loadSettings();
  if (!s) throw new Error("Not configured");
  return s;
}

function readCache(path: string): string | null {
  return localStorage.getItem(CACHE + path);
}

function writeCache(path: string, text: string): void {
  localStorage.setItem(CACHE + path, text);
}

function readOutbox(): Outbox {
  return JSON.parse(localStorage.getItem(OUTBOX) ?? "{}") as Outbox;
}

function writeOutbox(o: Outbox): void {
  localStorage.setItem(OUTBOX, JSON.stringify(o));
}

function markDirty(path: string, day: DayKey | null): void {
  const o = readOutbox();
  if (day === null) {
    o[path] = null;
  } else {
    const existing = o[path];
    if (existing === null) return; // already a whole-file write
    const days = existing ?? [];
    if (!days.includes(day)) days.push(day);
    o[path] = days;
  }
  writeOutbox(o);
}

export function pendingWrites(): number {
  return Object.keys(readOutbox()).length;
}

// ---------------------------------------------------------------- months

async function fetchMonth(m: MonthKey): Promise<MonthFile> {
  const remote = await getFile(settings(), monthPath(m));
  const file = remote ? (JSON.parse(remote.text) as MonthFile) : emptyMonth();
  writeCache(monthPath(m), JSON.stringify(file));
  return file;
}

function cachedMonth(m: MonthKey): MonthFile | null {
  const raw = readCache(monthPath(m));
  return raw ? (JSON.parse(raw) as MonthFile) : null;
}

/** Cache first. Falls back to an empty month when offline and never fetched. */
export async function readMonth(m: MonthKey): Promise<MonthFile> {
  const cached = cachedMonth(m);
  if (cached) return cached;
  try {
    return await fetchMonth(m);
  } catch {
    return emptyMonth();
  }
}

export async function readDay(day: DayKey): Promise<Day> {
  const month = await readMonth(monthOf(day));
  return month.days[day] ?? emptyDay();
}

/** Every logged day in [from, to], across however many month files that spans. */
export async function readRange(from: DayKey, to: DayKey): Promise<Map<DayKey, Day>> {
  const months = new Set<MonthKey>();
  for (let d = from; d <= to; d = addDays(d, 1)) months.add(monthOf(d));

  const out = new Map<DayKey, Day>();
  for (const m of months) {
    for (const [day, value] of Object.entries((await readMonth(m)).days)) {
      if (day >= from && day <= to) out.set(day, value);
    }
  }
  return out;
}

export async function updateDay(day: DayKey, fn: (d: Day) => void): Promise<Day> {
  const m = monthOf(day);
  const month = await readMonth(m);
  const current = month.days[day] ?? emptyDay();
  fn(current);
  month.days[day] = current;
  writeCache(monthPath(m), JSON.stringify(month));
  markDirty(monthPath(m), day);
  return current;
}

/** Bulk day writes (CSV import). One dirty mark per touched day. */
export async function updateDays(days: DayKey[], fn: (d: Day, key: DayKey) => void): Promise<void> {
  const byMonth = new Map<MonthKey, DayKey[]>();
  for (const d of days) {
    const list = byMonth.get(monthOf(d)) ?? [];
    list.push(d);
    byMonth.set(monthOf(d), list);
  }
  for (const [m, keys] of byMonth) {
    const month = await readMonth(m);
    for (const key of keys) {
      const day = month.days[key] ?? emptyDay();
      fn(day, key);
      month.days[key] = day;
      markDirty(monthPath(m), key);
    }
    writeCache(monthPath(m), JSON.stringify(month));
  }
}

// ---------------------------------------------------------------- config

export function cachedConfig(): Config | null {
  const raw = readCache(CONFIG_PATH);
  return raw ? (JSON.parse(raw) as Config) : null;
}

export async function refreshConfig(): Promise<Config | null> {
  const remote = await getFile(settings(), CONFIG_PATH);
  if (!remote) return null;
  writeCache(CONFIG_PATH, remote.text);
  return JSON.parse(remote.text) as Config;
}

export function saveConfig(c: Config): void {
  writeCache(CONFIG_PATH, JSON.stringify(c, null, 2));
  markDirty(CONFIG_PATH, null);
}

// ------------------------------------------------------------- favorites

export function cachedFavorites(): FavoritesFile {
  const raw = readCache(FAVORITES_PATH);
  return raw ? (JSON.parse(raw) as FavoritesFile) : emptyFavorites();
}

export async function refreshFavorites(): Promise<void> {
  const remote = await getFile(settings(), FAVORITES_PATH);
  if (remote) writeCache(FAVORITES_PATH, remote.text);
}

export function saveFavorites(f: FavoritesFile): void {
  writeCache(FAVORITES_PATH, JSON.stringify(f, null, 2));
  markDirty(FAVORITES_PATH, null);
}

// ---------------------------------------------------------------- sync

async function flushPath(path: string, dirtyDays: DayKey[] | null): Promise<void> {
  const localText = readCache(path);
  if (localText === null) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = await getFile(settings(), path);
    let text: string;

    if (dirtyDays === null) {
      text = localText;
    } else {
      const local = JSON.parse(localText) as MonthFile;
      const merged = remote ? (JSON.parse(remote.text) as MonthFile) : emptyMonth();
      for (const day of dirtyDays) {
        const value = local.days[day];
        if (value) merged.days[day] = value;
        else delete merged.days[day];
      }
      merged.days = Object.fromEntries(Object.entries(merged.days).sort(([a], [b]) => a.localeCompare(b)));
      text = JSON.stringify(merged, null, 2);
      writeCache(path, text);
    }

    try {
      await putFile(settings(), path, text, remote?.sha ?? null, `update ${path}`);
      return;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 409 && status !== 422) throw e;
      // Someone else wrote between our GET and PUT. Re-read and retry.
    }
  }
  throw new Error(`Could not sync ${path} after 3 attempts`);
}

/** Drains the outbox. Safe to call repeatedly; a failure leaves work queued. */
export async function flush(): Promise<void> {
  if (!loadSettings()) return;
  for (const [path, days] of Object.entries(readOutbox())) {
    await flushPath(path, days);
    const o = readOutbox();
    delete o[path];
    writeOutbox(o);
  }
}
