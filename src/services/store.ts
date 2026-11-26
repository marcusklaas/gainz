// Local cache + outbox over the GitHub repo.
//
// Writes are optimistic: they land in localStorage immediately and are queued
// for sync. Logging on mobile with poor signal is the normal case, so this is
// the only write path in the app.
//
// Conflicts resolve per item, not per day. The outbox records which day keys
// changed locally; on flush we try a single optimistic PUT against the last
// known server SHA (one round trip, no GET-after-PUT race on back-to-back
// edits), and on a 409/422 conflict fall back to re-reading the remote month
// and three-way merging each dirty day against the last state we know the
// server had. Two devices adding food to the same day both keep their items.
//
// Reads pull from the server once per month per session and fall back to the
// cache when that fails. localStorage is an offline fallback, never the source
// of truth — treating it as the latter is what let two devices drift apart.
//
// Every change to cached data — local edit, config save, server pull, or sync
// merge — flows through writeCache(), which bumps a monotonic revision counter
// and notifies subscribers on a coalesced microtask. Screens pull from the
// cache and key their derived work on revision(), so no write path ever has to
// remember which other screens depend on what it touched.
import { withDefaults } from "../core/config.js";
import { getFile, putFile } from "./github.js";
import { loadSettings, type Settings } from "./settings.js";
import { addDays, byAt, monthOf } from "../core/dates.js";
import {
  emptyDay,
  emptyMonth,
  type Config,
  type Day,
  type DayKey,
  type Draft,
  type MonthFile,
  type MonthKey,
} from "../core/types.js";

const CACHE = "gainz.cache.";
const OUTBOX = "gainz.outbox";
/** The session being edited. Local only — see the note in types.ts. */
const DRAFT = "gainz.draft";
/** Last state we know the server had, kept so merges can tell a local deletion
 *  apart from an item another device just added. */
const BASE = "gainz.base.";
/** Server blob SHA matching BASE, so flushPath() can push in one optimistic
 *  PUT and only pay for a GET + merge when another device actually raced us. */
const SHA = "gainz.sha.";
/** Per-path ETag, so a re-read of an unchanged month costs a bodyless 304. */
const ETAG = "gainz.etag.";

/** path -> changed day keys, or null meaning "replace the whole file". */
type Outbox = Record<string, DayKey[] | null>;

export const CONFIG_PATH = "config.json";

export function monthPath(m: MonthKey): string {
  return `data/${m.slice(0, 4)}/${m}.json`;
}

// ------------------------------------------------------------ revision / sub

let rev = 0;
const listeners = new Set<() => void>();
let notifyQueued = false;

/** Monotonic version of all cached store data (months + config). */
export function revision(): number {
  return rev;
}

/**
 * Fires on a coalesced microtask whenever any cached month or config actually
 * changes — whether from a local write, a server pull, or a sync merge.
 */
export function onChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function bumpRevision(): void {
  rev++;
  if (!listeners.size || notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const fn of listeners) fn();
  });
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
  const changed = readCache(path) !== text;
  localStorage.setItem(CACHE + path, text);
  writeEtag(path, null);
  if (changed) bumpRevision();
}

function readBase(path: string): MonthFile | null {
  const raw = localStorage.getItem(BASE + path);
  return raw ? (JSON.parse(raw) as MonthFile) : null;
}

function writeBase(path: string, text: string): void {
  localStorage.setItem(BASE + path, text);
}

function readSha(path: string): string | null {
  return localStorage.getItem(SHA + path);
}

function writeSha(path: string, sha: string | null): void {
  if (sha) localStorage.setItem(SHA + path, sha);
  else localStorage.removeItem(SHA + path);
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

function isDirty(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(readOutbox(), path);
}

/** Monotonic per-path edit counter, so flush() can tell whether a newer local
 *  write landed while a PUT was in flight and avoid clearing the outbox entry. */
const pathGen = new Map<string, number>();
const gen = (path: string): number => pathGen.get(path) ?? 0;

function markDirty(path: string, day: DayKey | null): void {
  pathGen.set(path, gen(path) + 1);
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
  if (isDirty(path)) return cachedMonth(m) ?? emptyMonth();
  const remote = await getFile(settings(), path, readEtag(path));
  // A local edit may have landed while the GET was in flight; never clobber it.
  if (isDirty(path)) return cachedMonth(m) ?? emptyMonth();
  if (remote.kind === "unchanged") return cachedMonth(m) ?? emptyMonth();

  const text = remote.kind === "file" ? remote.text : JSON.stringify(emptyMonth());
  writeCache(path, text);
  writeBase(path, text);
  writeSha(path, remote.kind === "file" ? remote.sha : null);
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
  const path = monthPath(m);
  if (src === "server" && !fetched.has(m) && !isDirty(path)) {
    let pending = inFlight.get(m);
    if (!pending) {
      pending = fetchMonth(m).finally(() => inFlight.delete(m));
      inFlight.set(m, pending);
    }
    try {
      const file = await pending;
      if (!isDirty(path)) fetched.add(m);
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

/** Synchronous cache read for screen rendering. Never touches the network. */
export function cachedDay(day: DayKey): Day {
  return cachedMonth(monthOf(day))?.days[day] ?? emptyDay();
}

function monthsIn(from: DayKey, to: DayKey): MonthKey[] {
  const months = new Set<MonthKey>();
  for (let d = from; d <= to; d = addDays(d, 1)) months.add(monthOf(d));
  return [...months];
}

/** Synchronous cache read across [from, to]. Never touches the network. */
export function cachedRange(from: DayKey, to: DayKey): Map<DayKey, Day> {
  const out = new Map<DayKey, Day>();
  for (const m of monthsIn(from, to)) {
    const file = cachedMonth(m);
    if (!file) continue;
    for (const [day, value] of Object.entries(file.days)) {
      if (day >= from && day <= to) out.set(day, value);
    }
  }
  return out;
}

/**
 * Pulls any unfetched, non-dirty months covering [from, to] from the server in
 * parallel. Any month whose body changed updates the cache, bumps revision(),
 * and notifies onChange subscribers automatically.
 */
export async function ensureRange(from: DayKey, to: DayKey): Promise<void> {
  await Promise.all(monthsIn(from, to).map((m) => readMonth(m, "server")));
}

/**
 * Every logged day in [from, to], across however many month files that spans.
 * The months go out together: a 180-day history is seven files, and fetching
 * them one after another is seven round trips of latency stacked end to end.
 */
export async function readRange(from: DayKey, to: DayKey, src: Source = "server"): Promise<Map<DayKey, Day>> {
  const files = await Promise.all(monthsIn(from, to).map((m) => readMonth(m, src)));

  const out = new Map<DayKey, Day>();
  for (const file of files) {
    for (const [day, value] of Object.entries(file.days)) {
      if (day >= from && day <= to) out.set(day, value);
    }
  }
  return out;
}

export async function updateDay(day: DayKey, fn: (d: Day) => void): Promise<void> {
  const m = monthOf(day);
  await readMonth(m);
  // Re-read synchronously after the await so two concurrent updates in the same
  // tick compose against the latest cache rather than clobbering each other.
  const month = cachedMonth(m) ?? emptyMonth();
  const current = month.days[day] ?? emptyDay();
  fn(current);
  month.days[day] = current;
  writeCache(monthPath(m), JSON.stringify(month));
  markDirty(monthPath(m), day);
}

// ----------------------------------------------------------------- draft

/**
 * One at a time. A second in-progress session is not a real scenario, and the
 * single slot is what lets the Lifts screen offer "resume" without having to
 * ask which one.
 */
export function readDraft(): Draft | null {
  const raw = localStorage.getItem(DRAFT);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Draft;
  } catch {
    // A half-written or hand-mangled draft should cost the session, not the app.
    return null;
  }
}

export function writeDraft(d: Draft): void {
  localStorage.setItem(DRAFT, JSON.stringify(d));
}

export function clearDraft(): void {
  localStorage.removeItem(DRAFT);
}

// ---------------------------------------------------------------- config

/**
 * Null only when there is no config at all. Anything that is there is merged
 * over the defaults on the way out, so callers never see a missing key.
 */
export function cachedConfig(): Config | null {
  const raw = readCache(CONFIG_PATH);
  return raw ? withDefaults(JSON.parse(raw)) : null;
}

export async function refreshConfig(): Promise<Config | null> {
  if (isDirty(CONFIG_PATH)) return cachedConfig();
  const remote = await getFile(settings(), CONFIG_PATH, readEtag(CONFIG_PATH));
  if (isDirty(CONFIG_PATH)) return cachedConfig();
  if (remote.kind === "missing") {
    writeSha(CONFIG_PATH, null);
    return null;
  }
  if (remote.kind === "unchanged") return cachedConfig();
  writeCache(CONFIG_PATH, remote.text);
  writeSha(CONFIG_PATH, remote.sha);
  writeEtag(CONFIG_PATH, remote.etag);
  return withDefaults(JSON.parse(remote.text));
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
export function mergeDay(base: Day | undefined, local: Day, remote: Day | undefined): Day {
  // Remote records we have never seen are the other device's additions. Anything
  // remote that we did know about but no longer hold was deleted here.
  const union = <T extends { id: string }>(b: T[] = [], l: T[] = [], r: T[] = []): T[] => {
    const known = new Set(b.map((x) => x.id));
    const mine = new Set(l.map((x) => x.id));
    return [...l, ...r.filter((x) => !known.has(x.id) && !mine.has(x.id))];
  };

  const items = union(base?.items, local.items, remote?.items);
  // Sessions merge by the same rule as items, one level up: two devices adding
  // different sessions to a day both keep theirs, and two editing the same one
  // resolve last-writer-wins over the whole session. Mid-session editing on two
  // phones at once is not a real scenario; two devices logging food on one day
  // very much is, which is why that case gets the finer-grained treatment.
  const sessions = union(base?.sessions, local.sessions, remote?.sessions);

  // A scalar edited here wins; otherwise defer to the server.
  const pick = <T>(l: T | undefined, b: T | undefined, r: T | undefined) => (l !== b ? l : r);
  const weight = pick(local.weight_kg, base?.weight_kg, remote?.weight_kg);
  const logging = pick(local.logging, base?.logging, remote?.logging);
  // Write-once, so whichever side has it wins and the two can never disagree.
  const goal = local.goal_kcal ?? remote?.goal_kcal;

  // Built in field order so the JSON diffs stay readable.
  //
  // Both lists are ordered by when their entries were made, which is the order
  // they were shown in before the merge and has to survive it — `union` appends
  // the other device's records, so without this a merge would file them all
  // last however long ago they were entered.
  const day = {} as Day;
  if (weight !== undefined) day.weight_kg = weight;
  if (goal !== undefined) day.goal_kcal = goal;
  day.items = items.sort(byAt);
  // Absent rather than empty, so a day that never held one does not gain a key.
  if (sessions.length) day.sessions = sessions.sort(byAt);
  if (logging !== undefined) day.logging = logging;
  return day;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function flushPath(path: string): Promise<void> {
  // Up to 3 full GET + merge attempts, plus 1 free optimistic PUT upfront when
  // we already know the server blob SHA.
  let mergeAttempts = 0;
  while (mergeAttempts < 3) {
    const preDirty = readOutbox()[path];
    if (preDirty === undefined) return;

    const knownSha = readSha(path);
    const optimistic = knownSha !== null && (preDirty === null || readBase(path) !== null);
    let current: { text: string; sha: string } | null = null;

    if (!optimistic) {
      if (mergeAttempts > 0) await delay(300 * 3 ** (mergeAttempts - 1));
      mergeAttempts++;
      // Unconditional: this needs the remote body to merge against and its sha
      // to write with, so there is nothing a 304 could save here.
      const remote = await getFile(settings(), path);
      current = remote.kind === "file" ? remote : null;
    }

    // Snapshot local state *after* any async GET so edits that landed while
    // GET was in flight are folded into this push and never overwritten.
    const snapGen = gen(path);
    const dirtyDays = readOutbox()[path];
    if (dirtyDays === undefined) return;
    const localText = readCache(path);
    if (localText === null) {
      // Orphaned outbox entry with no cached body; drop it so drainOutbox
      // cannot spin forever.
      const o = readOutbox();
      delete o[path];
      writeOutbox(o);
      return;
    }

    let text: string;
    let targetSha: string | null;
    if (optimistic) {
      targetSha = knownSha;
      if (dirtyDays === null) {
        text = localText;
      } else {
        const local = JSON.parse(localText) as MonthFile;
        local.days = Object.fromEntries(
          Object.entries(local.days).sort(([a], [b]) => a.localeCompare(b)),
        );
        text = JSON.stringify(local, null, 2);
      }
    } else {
      targetSha = current?.sha ?? null;
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
        merged.days = Object.fromEntries(
          Object.entries(merged.days).sort(([a], [b]) => a.localeCompare(b)),
        );
        text = JSON.stringify(merged, null, 2);
        // Persist the merged month before yielding to PUT, so any edit that lands
        // while PUT is in flight builds on top of the merged items rather than
        // losing remote additions once base advances to `text` below.
        writeCache(path, text);
      }
    }

    try {
      const newSha = await putFile(settings(), path, text, targetSha, `update ${path}`);
      // What we just pushed is now the agreed state, so it becomes the base and
      // SHA for the next edit/merge. The PUT reply carries no etag we can reuse,
      // so the next read of this path goes out unconditional.
      writeBase(path, text);
      writeSha(path, newSha);
      writeEtag(path, null);
      // Only clear the outbox entry when nothing newer arrived during the PUT;
      // otherwise leave it dirty so drainOutbox() pushes the newer edit next.
      if (gen(path) === snapGen) {
        const o = readOutbox();
        delete o[path];
        writeOutbox(o);
      }
      return;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 409 && status !== 422) throw e;
      // Someone else wrote (or our stored SHA was stale). Clear the stored SHA
      // so the next iteration does a full GET + three-way merge.
      writeSha(path, null);
    }
  }
  throw new Error(`Could not sync ${path} after 3 attempts`);
}

/** Single-flight lock so overlapping callers share one drain pass. */
let flushing: Promise<void> | null = null;

async function drainOutbox(): Promise<void> {
  try {
    while (true) {
      const entries = Object.keys(readOutbox());
      if (!entries.length) return;
      for (const path of entries) {
        await flushPath(path);
      }
    }
  } finally {
    flushing = null;
  }
}

/** Drains the outbox. Safe to call concurrently; a failure leaves work queued. */
export function flush(): Promise<void> {
  if (!loadSettings()) return Promise.resolve();
  flushing ??= drainOutbox();
  return flushing;
}
