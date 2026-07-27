// Local cache + outbox over the GitHub repo.
//
// Writes are optimistic: they land in localStorage immediately and are queued
// for sync. Logging on mobile with poor signal is the normal case, so this is
// the only write path in the app.
//
// Conflicts resolve per item, not per day. The outbox records which day keys
// changed locally; on flush we re-read the remote month and three-way merge
// each dirty day against the last state we know the server had. Two devices
// adding food to the same day both keep their items.
//
// Reads pull from the server once per month per session and fall back to the
// cache when that fails. localStorage is an offline fallback, never the source
// of truth — treating it as the latter is what let two devices drift apart.
import { getFile, putFile } from "./github.js";
import { loadSettings, type Settings } from "./settings.js";
import { addDays, monthOf } from "./dates.js";
import {
  emptyDay,
  emptyMonth,
  type Config,
  type Day,
  type DayKey,
  type MonthFile,
  type MonthKey,
} from "./types.js";

const CACHE = "gainz.cache.";
const OUTBOX = "gainz.outbox";
/** Last state we know the server had, kept so merges can tell a local deletion
 *  apart from an item another device just added. */
const BASE = "gainz.base.";
/** Per-path ETag, so a re-read of an unchanged month costs a bodyless 304. */
const ETAG = "gainz.etag.";

/** path -> changed day keys, or null meaning "replace the whole file". */
type Outbox = Record<string, DayKey[] | null>;

export const CONFIG_PATH = "config.json";

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

/**
 * Drops the etag: it certifies that the cached body is the server's, and any
 * write through here is either a local edit or a fresh copy whose own etag the
 * caller sets immediately after. Getting this backwards would let a conditional
 * read answer 304 and quietly bless an unsynced local edit as server truth.
 */
function writeCache(path: string, text: string): void {
  localStorage.setItem(CACHE + path, text);
  writeEtag(path, null);
}

function readBase(path: string): MonthFile | null {
  const raw = localStorage.getItem(BASE + path);
  return raw ? (JSON.parse(raw) as MonthFile) : null;
}

function writeBase(path: string, text: string): void {
  localStorage.setItem(BASE + path, text);
}

/** Only offered when we still hold the body it describes. */
function readEtag(path: string): string | null {
  return readCache(path) === null ? null : localStorage.getItem(ETAG + path);
}

function writeEtag(path: string, etag: string | null): void {
  if (etag) localStorage.setItem(ETAG + path, etag);
  else localStorage.removeItem(ETAG + path);
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
  const path = monthPath(m);
  const remote = await getFile(settings(), path, readEtag(path));
  if (remote.kind === "unchanged") return cachedMonth(m) ?? emptyMonth();

  const text = remote.kind === "file" ? remote.text : JSON.stringify(emptyMonth());
  writeCache(path, text);
  writeBase(path, text);
  if (remote.kind === "file") writeEtag(path, remote.etag);
  return JSON.parse(text) as MonthFile;
}

function cachedMonth(m: MonthKey): MonthFile | null {
  const raw = readCache(monthPath(m));
  return raw ? (JSON.parse(raw) as MonthFile) : null;
}

/** Months already pulled from the server during this page session. */
const fetched = new Set<MonthKey>();

/** In-flight fetches, so overlapping reads of one month share a request. */
const inFlight = new Map<MonthKey, Promise<MonthFile>>();

/**
 * Forces the next read of these months to go to the server. Called when the app
 * regains focus, which is the moment another device's changes should appear.
 */
export function invalidateMonths(...months: MonthKey[]): void {
  for (const m of months) fetched.delete(m);
}

/**
 * Where a read is allowed to get its answer. "cache" never touches the network,
 * which is what the first paint uses: it puts the last known numbers on screen
 * in the same frame, and the server read that follows corrects them.
 */
export type Source = "server" | "cache";

/**
 * Server first, once per month per session, then cached. Fetching on first use
 * also means a write is applied to fresh state rather than to whatever this
 * device happened to have cached.
 */
export async function readMonth(m: MonthKey, src: Source = "server"): Promise<MonthFile> {
  if (src === "server" && !fetched.has(m)) {
    let pending = inFlight.get(m);
    if (!pending) {
      pending = fetchMonth(m).finally(() => inFlight.delete(m));
      inFlight.set(m, pending);
    }
    try {
      const file = await pending;
      fetched.add(m);
      return file;
    } catch {
      // Offline, or the token is unhappy. The cache below still renders.
    }
  }
  return cachedMonth(m) ?? emptyMonth();
}

export async function readDay(day: DayKey, src: Source = "server"): Promise<Day> {
  const month = await readMonth(monthOf(day), src);
  return month.days[day] ?? emptyDay();
}

/**
 * Every logged day in [from, to], across however many month files that spans.
 * The months go out together: a 180-day history is seven files, and fetching
 * them one after another is seven round trips of latency stacked end to end.
 */
export async function readRange(from: DayKey, to: DayKey, src: Source = "server"): Promise<Map<DayKey, Day>> {
  const months = new Set<MonthKey>();
  for (let d = from; d <= to; d = addDays(d, 1)) months.add(monthOf(d));

  const files = await Promise.all([...months].map((m) => readMonth(m, src)));

  const out = new Map<DayKey, Day>();
  for (const file of files) {
    for (const [day, value] of Object.entries(file.days)) {
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
  const remote = await getFile(settings(), CONFIG_PATH, readEtag(CONFIG_PATH));
  if (remote.kind === "missing") return null;
  if (remote.kind === "unchanged") return cachedConfig();
  writeCache(CONFIG_PATH, remote.text);
  writeEtag(CONFIG_PATH, remote.etag);
  return JSON.parse(remote.text) as Config;
}

export function saveConfig(c: Config): void {
  writeCache(CONFIG_PATH, JSON.stringify(c, null, 2));
  markDirty(CONFIG_PATH, null);
}

// ---------------------------------------------------------------- sync

/**
 * Three-way merge of a single day. The base is the last state we know the
 * server had; without it a locally deleted item is indistinguishable from one
 * the other device just added, and one of the two behaves wrongly.
 */
function mergeDay(base: Day | undefined, local: Day, remote: Day | undefined): Day {
  const known = new Set((base?.items ?? []).map((i) => i.id));
  const mine = new Set(local.items.map((i) => i.id));
  // Remote items we have never seen are the other device's additions. Anything
  // remote that we did know about but no longer hold was deleted here.
  const added = (remote?.items ?? []).filter((i) => !known.has(i.id) && !mine.has(i.id));

  // A scalar edited here wins; otherwise defer to the server.
  const pick = <T>(l: T | undefined, b: T | undefined, r: T | undefined) => (l !== b ? l : r);
  const weight = pick(local.weight_kg, base?.weight_kg, remote?.weight_kg);
  const logging = pick(local.logging, base?.logging, remote?.logging);
  // Write-once, so whichever side has it wins and the two can never disagree.
  const goal = local.goal_kcal ?? remote?.goal_kcal;

  // Built in field order so the JSON diffs stay readable.
  const day = {} as Day;
  if (weight !== undefined) day.weight_kg = weight;
  if (goal !== undefined) day.goal_kcal = goal;
  day.items = [...local.items, ...added].sort((a, b) => a.at.localeCompare(b.at));
  if (logging !== undefined) day.logging = logging;
  return day;
}

async function flushPath(path: string, dirtyDays: DayKey[] | null): Promise<void> {
  const localText = readCache(path);
  if (localText === null) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    // Unconditional: this needs the remote body to merge against and its sha to
    // write with, so there is nothing a 304 could save here.
    const remote = await getFile(settings(), path);
    const current = remote.kind === "file" ? remote : null;
    let text: string;

    if (dirtyDays === null) {
      text = localText;
    } else {
      const local = JSON.parse(localText) as MonthFile;
      const base = readBase(path);
      const merged = current ? (JSON.parse(current.text) as MonthFile) : emptyMonth();
      for (const day of dirtyDays) {
        const value = local.days[day];
        if (value) merged.days[day] = mergeDay(base?.days[day], value, merged.days[day]);
        else delete merged.days[day];
      }
      merged.days = Object.fromEntries(Object.entries(merged.days).sort(([a], [b]) => a.localeCompare(b)));
      text = JSON.stringify(merged, null, 2);
      writeCache(path, text);
    }

    try {
      await putFile(settings(), path, text, current?.sha ?? null, `update ${path}`);
      // What we just pushed is now the agreed state, so it becomes the base for
      // the next merge. The PUT reply carries no etag we can reuse, so the next
      // read of this path goes out unconditional.
      writeBase(path, text);
      writeEtag(path, null);
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
