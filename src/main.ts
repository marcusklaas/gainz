import { at, defaultConfig, FIELDS, put, withDefaults } from "./config.js";
import { addDays, atTime, byAt, humanDay, monthOf, nowStamp, todayKey } from "./dates.js";
import {
  dayKcal,
  dayProtein,
  estimate,
  WEEK_DAYS,
  weekSummary,
  type Estimate,
} from "./estimate.js";
import { buildContext, contextFrom } from "./export.js";
import { checkAccess } from "./github.js";
import {
  confirmedSets,
  draftOf,
  exerciseKey,
  exerciseNames,
  finish,
  fitTotal,
  lastSessionNamed,
  moved,
  newDraft,
  sessionsOf,
  strengthOf,
  summarise,
  templateNames,
  type DatedSession,
  type Fit,
  type Strength,
} from "./lifts.js";
import { estimateFood } from "./llm.js";
import { requestReminders, updatePlan } from "./notify.js";
import {
  isConfigured,
  loadSettings,
  parseRepo,
  repoUrl,
  saveSettings,
  type Settings,
} from "./settings.js";
import {
  cachedConfig,
  clearDraft,
  flush,
  invalidateMonths,
  pendingWrites,
  readDay,
  readDraft,
  readRange,
  refreshConfig,
  saveConfig,
  type Source,
  updateDay,
  writeDraft,
} from "./store.js";
import type { Config, Day, DayKey, Draft, FoodItem } from "./types.js";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

const val = (id: string) => $<HTMLInputElement>(id).value.trim();
const num = (id: string) => Number($<HTMLInputElement>(id).value);
const checked = (id: string) => $<HTMLInputElement>(id).checked;

/** Pending flash() clears, one per element, so a new message cancels the old
 *  one's timer instead of being wiped by it. */
const clears = new Map<string, number>();

function msg(id: string, text: string, kind: "ok" | "err" | "" = ""): void {
  clearTimeout(clears.get(id));
  clears.delete(id);
  const e = $(id);
  e.textContent = text;
  e.className = `msg ${kind}`;
}

/** Confirmation that has been read once it has been seen. Left up, a "Saved."
 *  from an hour ago still reads as news about whatever was just typed. */
function flash(id: string, text: string, kind: "ok" | "err" = "ok"): void {
  msg(id, text, kind);
  clears.set(id, setTimeout(() => msg(id, ""), 4000));
}

let day = todayKey();

// ------------------------------------------------------------------- boot

/**
 * Two passes on purpose. The first is pure localStorage and paints the day that
 * was on screen last time before a single request goes out; the second is the
 * authoritative one and corrects it. GitHub is a slow data store and always will
 * be, so the fix is to stop the UI waiting on it to draw anything at all.
 *
 * The order of the network half is load-bearing: queued writes have to land
 * before the months are re-read, or fetchMonth would overwrite the cache that
 * holds them. flush() is a no-op with an empty outbox, which is the normal case.
 */
async function boot(): Promise<void> {
  if (!isConfigured()) {
    $("setup").hidden = false;
    return;
  }
  $("app").hidden = false;
  show("today");

  fillSettingsForms();
  await render("cache");

  try {
    await flush();
    const cfg = await refreshConfig();
    if (!cfg) needsConfig();
  } catch {
    // Offline is fine; cached data still renders and writes stay queued.
  }
  fillSettingsForms();
  await render();
  syncStatus();
}

function needsConfig(): void {
  const banner = $("config-banner");
  banner.hidden = false;
  banner.textContent = "No config.json in the repo yet. Review these values and save.";
  banner.className = "msg err";
  // Asking someone to review values behind five folded headings is asking them
  // not to. This is the one visit where all of it is the point.
  for (const d of sections()) d.open = true;
  show("settings");
}

/** The folded settings, which is not every folded section on the screen. The
 *  export sits among them but holds no values to review, and unfolding it would
 *  fire a build against a repo that has not been configured yet. */
const sections = () =>
  document.querySelectorAll<HTMLDetailsElement>("#settings details:not(#export)");

// ----------------------------------------------------------------- screens

/** "lift" is the session editor. It has no nav button — it is reached by
 *  starting or opening a session, and leaves by going back to the list. */
type Screen = "today" | "lifts" | "lift" | "trend" | "settings";

const SCREENS = ["today", "lifts", "lift", "trend", "settings"] as const;

/** Latest estimate, kept so the chart can be drawn when Trend becomes visible. */
let latest: Estimate | null = null;

/** The same, for the strength index: both charts on Trend are drawn from what
 *  the last render worked out, whenever the screen is next on show. */
let latestStrength: Strength | null = null;

/**
 * uPlot is by far the largest thing the app loads and Today never shows it, so
 * it is fetched the first time Trend is actually looked at rather than being
 * parsed on the critical path of every start.
 */
let chartModule: Promise<typeof import("./chart.js")> | null = null;

/**
 * Always draws the newest estimate rather than one captured at call time, so
 * two paints racing across the dynamic import settle on the same picture.
 */
async function paintChart(): Promise<void> {
  const { drawStrength, drawTrend } = await (chartModule ??= import("./chart.js"));
  // Both views open on exactly what the headline under them is built from: for
  // weight, the days of intake the TDEE fit averaged plus the week the slope
  // says comes next; for strength, the window the panel fit is computed over.
  const cfg = cachedConfig();
  const e = cfg?.estimator;
  drawTrend($("chart"), latest?.samples ?? [], latest?.trendLine ?? [], {
    historyDays: e?.tdeeWindowDays ?? 21,
    projectionDays: e?.projectionDays ?? 0,
  });
  drawStrength($("strength-chart"), latestStrength?.index ?? [], cfg?.strength.windowDays ?? 42);
}

function show(name: Screen): void {
  // Leaving the editor ends an edit of a past session, whether that was the
  // back button, the nav, or a save. One place rather than each of them, so
  // there is no route out that forgets. A session in progress is untouched:
  // its whole contract is that it survives this.
  if (name !== "lift") edit = null;
  for (const s of SCREENS) $(s).hidden = s !== name;
  // The editor is part of Lifts as far as the nav is concerned; nothing else
  // would be lit while it is open.
  const tab = name === "lift" ? "lifts" : name;
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    b.setAttribute("aria-current", String(b.dataset["screen"] === tab));
  }
  // uPlot sizes from the container, which measures zero while hidden, so the
  // chart can only be built once its section is on screen.
  // Unconditional: the two charts are independent, and a log with sessions but
  // no weigh-ins still has a strength index to draw.
  if (name === "trend") void paintChart();
  if (name === "lifts") void renderLifts();
}

for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
  b.addEventListener("click", () => show(b.dataset["screen"] as Screen));
}

function syncStatus(): void {
  const n = pendingWrites();
  $("sync").textContent = n ? `${n} pending` : "";
}

async function sync(): Promise<void> {
  try {
    await flush();
  } catch {
    // Stays queued.
  }
  syncStatus();
}

/**
 * Every change to the day on screen goes through here. Write, redraw, push — in
 * that order, and the push last because it is the only step allowed to fail.
 */
async function commit(fn: (d: Day) => void): Promise<void> {
  await updateDay(day, fn);
  await render();
  await sync();
}

// ------------------------------------------------------------------- setup

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  msg("setup-msg", "Checking...");
  let s: Settings;
  try {
    s = {
      repo: parseRepo(val("s-repo")),
      branch: val("s-branch"),
      pat: val("s-pat"),
      anthropicKey: "",
      openaiKey: "",
    };
    await checkAccess(s);
  } catch (err) {
    msg("setup-msg", String((err as Error).message), "err");
    return;
  }
  saveSettings(s);
  $("setup").hidden = true;
  await boot();
});

// -------------------------------------------------------------------- today

$("prev-day").addEventListener("click", () => {
  day = addDays(day, -1);
  void render();
});

$("next-day").addEventListener("click", () => {
  if (day === todayKey()) return;
  day = addDays(day, 1);
  void render();
});

$("weight-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kg = num("f-weight");
  if (!kg) return;
  await commit((d) => {
    d.weight_kg = kg;
  });
});

// ---------------------------------------------------------------- food entry

/**
 * One description is one entry. Estimate only fills the two number fields, so
 * the model is a convenience over the manual path rather than a separate flow
 * with its own review step — and anything it gets wrong is fixed by typing over
 * it before pressing Add.
 */

/** Set when the numbers currently in the boxes came from the model. */
let estimatedBy: string | null = null;

const desc = () => $<HTMLTextAreaElement>("f-desc").value.trim();

for (const id of ["f-kcal", "f-protein"]) {
  // Typing over an estimate makes it the user's number, not the model's.
  $(id).addEventListener("input", () => (estimatedBy = null));
}

$("f-estimate").addEventListener("click", async () => {
  const text = desc();
  if (!text) return msg("food-msg", "Describe the food first.", "err");

  const cfg = cachedConfig();
  if (!cfg) return msg("food-msg", "Save your config first.", "err");

  const s = loadSettings();
  const provider = cfg.llm.provider;
  const key = provider === "openai" ? s?.openaiKey : s?.anthropicKey;
  if (!key) return msg("food-msg", `No ${provider} API key yet — add one in Settings.`, "err");

  const button = $<HTMLButtonElement>("f-estimate");
  button.disabled = true;
  msg("food-msg", "Estimating…");
  try {
    const est = await estimateFood(text, { provider, model: cfg.llm.model, key });
    $<HTMLInputElement>("f-kcal").value = String(est.kcal);
    $<HTMLInputElement>("f-protein").value = String(est.protein_g);
    estimatedBy = cfg.llm.model;
    msg("food-msg", "Estimated — edit either number, then Add.", "ok");
  } catch (err) {
    msg("food-msg", (err as Error).message, "err");
  } finally {
    button.disabled = false;
  }
});

$("food-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item: FoodItem = {
    id: crypto.randomUUID(),
    at: nowStamp(),
    name: desc(),
    kcal: num("f-kcal"),
    protein_g: num("f-protein"),
    ...(estimatedBy ? { model: estimatedBy } : {}),
  };
  ($("food-form") as HTMLFormElement).reset();
  estimatedBy = null;
  msg("food-msg", "");
  $("f-desc").focus();
  await commit((d) => {
    d.items.push(item);
  });
});

$("f-logging").addEventListener("change", async () => {
  const on = $<HTMLInputElement>("f-logging").checked;
  await commit((d) => {
    if (on) d.logging = "complete";
    else delete d.logging;
  });
});

/** Detached from render(), so a failure here cannot surface as an unhandled rejection. */
async function planReminders(cfg: Config | null, d: Day, src: Source): Promise<void> {
  try {
    await updatePlan(cfg, day === todayKey() ? d : await readDay(todayKey(), src));
  } catch {
    // Reminders are best effort by design; see the note under Settings.
  }
}

async function render(src: Source = "server"): Promise<void> {
  const cfg = cachedConfig();

  // Started before the first await so that the month holding the day on screen
  // and the months behind the estimator window go out together. readMonth
  // collapses the overlap between the two into one request.
  const history = cfg ? readRange(addDays(day, -cfg.estimator.historyDays), day, src) : null;

  // Always about now, whichever day is on screen — so it cannot read from the
  // history above, which ends at `day` and would be missing the last few days
  // whenever you have browsed backwards. Its months are almost always already
  // inside that range, and readMonth collapses the overlap into no new request.
  const today = todayKey();
  const week = readRange(addDays(today, -(WEEK_DAYS - 1)), today, src);

  const d = await readDay(day, src);
  $("day-label").textContent = humanDay(day);
  $<HTMLButtonElement>("next-day").disabled = day === todayKey();
  $<HTMLInputElement>("f-weight").value = d.weight_kg ? String(d.weight_kg) : "";
  $<HTMLInputElement>("f-logging").checked = d.logging === "complete";
  renderItems(d);

  // Reminders are always about today, whichever day happens to be on screen,
  // and are re-planned here so that saving a weight silences one immediately.
  // Not awaited: it is a Cache API round trip plus, on an older day, a month
  // read, and nothing on screen waits on the answer.
  void planReminders(cfg, d, src);
  if (!cfg) return;

  const past = await history!;
  const est = estimate(cfg, past, day);

  // Read over the same history and dated to the same day as the weight chart
  // beside it, so browsing back moves both pictures together rather than one.
  latestStrength = strengthOf(sessionsOf(past), day, cfg.strength.windowDays);
  renderStrength(latestStrength);

  // Only ever pinned from a server read. The cache pass exists to put something
  // on screen fast, and a number derived from a stale month is not one to write
  // down permanently as what today was judged against.
  if (est && src === "server") await recordGoal(d, est);
  renderGoals(d, est);
  renderWeek(await week, est);
}

// ---------------------------------------------------------------- strength
//
// The verdict is the panel fit and its two-sigma interval; the chart is the
// chained index. They do not agree at the endpoints, because the fit uses every
// session in the window and the index only chains — the same relationship the
// weight chart has between its trend line and any two weigh-ins.

/** A proportion as a percentage with the direction as an arrow: 0.45 reads
 *  "↑45%", matching how the weight trend states its rate. */
const pct = (p: number): string => `${p < 0 ? "↓" : "↑"}${Math.round(Math.abs(p) * 100)}%`;

/** Half the two-sigma interval, as a percentage — the "± 7%" of the headline.
 *  The interval is asymmetric because the fit is exponential, so this is its
 *  half-width rather than either end of it. */
const plusMinus = (f: Fit): string =>
  `± ${Math.round(((fitTotal(f, 2) - fitTotal(f, -2)) / 2) * 100)}%`;

/**
 * The headline: the total over the window with its interval attached, the same
 * shape the weight trend uses. The interval is the point — where it covers zero
 * the number is not a finding, and reading "↑3% ± 9%" as progress is the
 * failure this whole design is arranged against. At an ordinary rate of
 * progress it takes eight or twelve weeks of window before the ± clears.
 */
function renderStrength(s: Strength | null): void {
  const note = $("strength-note");
  const from = $("strength-from");
  const fit = s?.fit ?? null;

  if (!fit) {
    note.textContent =
      s && s.index.length
        ? "Not enough logged yet to fit a trend — an exercise has to be repeated to say anything."
        : "No sessions logged yet. The index is built from your best set of each exercise.";
    from.textContent = "";
    return;
  }

  // No "Strength" prefix — the section heading already said it, and the arrow
  // carries the direction on its own.
  note.textContent = `${pct(fitTotal(fit))} ${plusMinus(fit)} over ${fit.windowDays} days`;

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  from.textContent = `from ${plural(fit.points, "exercise-session")} across ${plural(fit.exercises, "exercise")}`;
}

/**
 * The week as it happened. Every line survives a missing estimate except
 * protein, whose target needs a weight to exist — so the block is never hidden,
 * and on a fresh install it still reports what has been logged and trained.
 */
function renderWeek(days: Map<DayKey, Day>, est: Estimate | null): void {
  const w = weekSummary(days, todayKey(), est?.proteinTarget ?? null);
  const dl = $("week");
  dl.replaceChildren();

  const row = (label: string, value: string) => {
    const line = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    line.append(dt, dd);
    dl.append(line);
  };

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  row("Logged", `${w.logged} of ${WEEK_DAYS} days`);
  // Two plain numbers rather than a signed difference. "60 under" reads as a
  // miss at a distance that is noise, and a signed weekly total is one step
  // from an allowance to spend — which is the banking this app does not do.
  row(
    "Calories",
    w.intake ? `${round(w.intake.kcal)} avg (${round(w.intake.goal)} target)` : DASH,
  );
  row("Protein", est ? `hit on ${w.proteinHit} of ${WEEK_DAYS}` : DASH);
  row("Weigh-ins", `${w.weighed} of ${WEEK_DAYS}`);
  row("Training", w.sessions ? `${plural(w.sessions, "session")} · ${plural(w.sets, "set")}` : "none");
}

/**
 * Pins today's goal the first time the day is opened, and never touches it
 * again. The bias accumulator needs the number that was in force that day;
 * re-deriving it later from more data would fabricate deviations every time
 * the estimate moved.
 *
 * The correction itself stays out of the UI — the band moving is the whole of
 * what the user sees. The log is here so that when it moves, there is somewhere
 * to look and find out why.
 */
async function recordGoal(d: Day, est: Estimate): Promise<void> {
  if (day === todayKey() && d.goal_kcal === undefined) {
    d.goal_kcal = Math.round(est.goalKcal);
    await updateDay(day, (x) => {
      x.goal_kcal ??= d.goal_kcal;
    });
  }
  console.info(
    `bias E=${round(est.bias.kcal)} over ${est.bias.days} d ·` +
      ` goal ${round(est.goalKcal)} shown as ${round(est.targetKcal)}`,
  );
}

const round = (n: number) => String(Math.round(n));

const DASH = "—";

/**
 * Back to the state the markup ships in: both trackers present, both empty.
 *
 * The bars are laid out from the first frame and stay laid out — an estimate
 * arriving fills them in rather than making them appear. Waiting on seven month
 * files before drawing the shape of the screen is what made a slow start read as
 * a broken one.
 */
function resetGoals(): void {
  $("goals").classList.add("pending");
  $("p-nums").textContent = `${DASH} / ${DASH} g`;
  $("k-nums").textContent = `${DASH} kcal`;
  $("p-note").textContent = "";
  $("k-note").textContent = "";
  for (const id of ["p-fill", "k-fill"]) bar(id, 0, "");
  $("k-band").style.width = "0%";
}

function bar(id: string, fraction: number, state: string): void {
  const e = $(id);
  e.style.width = `${Math.min(Math.max(fraction, 0), 1) * 100}%`;
  e.className = state;
}

function renderGoals(d: Day, est: Estimate | null): void {
  latest = est;
  if (!$("trend").hidden) void paintChart();

  if (!est) {
    resetGoals();
    $("stats").textContent = "Log a weight to get targets.";
    $("trend-note").textContent = "No weigh-ins yet. Save one on Today to get started.";
    return;
  }
  $("goals").classList.remove("pending");

  const protein = dayProtein(d);
  const hit = protein >= est.proteinTarget;
  $("p-nums").textContent = `${round(protein)} / ${round(est.proteinTarget)} g`;
  bar("p-fill", protein / est.proteinTarget, hit ? "hit" : "");
  $("p-note").textContent = hit ? "Protein hit ✓" : `${round(est.proteinTarget - protein)} g to go`;

  const kcal = dayKcal(d);
  const scale = Math.max(est.kcalUpper * 1.15, kcal * 1.05);
  $("k-nums").textContent = `${round(kcal)}  [${round(est.kcalLower)} – ${round(est.kcalUpper)}]`;
  bar("k-fill", kcal / scale, kcal > est.kcalUpper ? "over" : kcal >= est.kcalLower ? "hit" : "");
  $("k-band").style.left = `${(est.kcalLower / scale) * 100}%`;
  $("k-band").style.width = `${((est.kcalUpper - est.kcalLower) / scale) * 100}%`;

  // Over the top of the range says so and stops. No deficit is carried and no
  // catch-up is suggested — a cheat day is just a cheat day. See spec.md.
  $("k-note").textContent =
    kcal > est.kcalUpper
      ? "Over for today. Reset tomorrow."
      : kcal >= est.kcalLower
        ? `In range · room for ${round(est.kcalUpper - kcal)} more`
        : `${round(est.kcalLower - kcal)} more to reach range · ${round(est.kcalUpper - kcal)} to spare`;

  // Today carries only what bears on today's targets; the trend lives on Trend.
  $("stats").textContent =
    `TDEE ${round(est.tdee)} · from ${est.countedDays} of ${est.windowDays} days`;

  $("trend-note").textContent =
    est.kgPerWeek === null
      ? `${est.samples.length} weigh-in so far — two are needed to draw a chart.`
      : `${est.trendKg.toFixed(1)} kg · ${est.kgPerWeek >= 0 ? "↑" : "↓"}` +
        `${Math.abs(est.kgPerWeek).toFixed(2)} kg/wk`;
}

function renderItems(d: Day): void {
  const ul = $("items");
  ul.replaceChildren();
  for (const item of d.items) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.name;

    const macros = document.createElement("span");
    macros.className = "macros";
    macros.textContent = `${item.kcal} kcal / ${item.protein_g} g`;

    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", () =>
      commit((x) => {
        x.items = x.items.filter((i) => i.id !== item.id);
      }),
    );

    li.append(name, macros, del);
    ul.append(li);
  }
}

// -------------------------------------------------------------------- lifts
//
// Two screens: the list of what has been done, and the editor for one session.
// The editor is not a tab because it is not a place — it is a session, opened
// from the list and left when it is saved or thrown away.
//
// Nothing here writes to the repo until Save. Until then the whole session is a
// draft in localStorage, which is what makes leaving mid-workout free: there is
// no unsaved state in memory to warn about, and the list offers to resume.

/** The window Lifts reads, kept in step with the estimator's own history so the
 *  months are already fetched and the screen costs no extra requests. */
const historyDays = () => cachedConfig()?.estimator.historyDays ?? 180;

/** Sessions in that window, newest first. Re-read whenever one is written. */
let sessions: DatedSession[] = [];

async function loadSessions(src: Source = "cache"): Promise<void> {
  const today = todayKey();
  sessions = sessionsOf(await readRange(addDays(today, -historyDays()), today, src));
}

/**
 * Two ways into the editor, and they are deliberately not the same thing.
 *
 * A session in progress is a `draft`: mirrored to localStorage on every change,
 * offered as "resume" on the list, and outliving the screen and the app itself.
 * A workout is logged over an hour with the phone going in and out of a pocket,
 * so nothing about leaving may cost anything.
 *
 * A past session opened from the list is an `edit`: held in memory and nowhere
 * else. It is already saved, so there is nothing to protect it from — backing
 * out by any route drops the changes, which is what leaving an edit without
 * saving means everywhere else. Keeping the two apart is also what stops an
 * edit from presenting itself as the session you are currently doing, and what
 * lets one be opened mid-workout without the session in progress noticing.
 */
let draft: Draft | null = null;
let edit: Draft | null = null;

/** Whichever of the two the editor is showing. */
const current = (): Draft | null => edit ?? draft;

function editDraft(fn: (d: Draft) => void): void {
  const d = current();
  if (!d) return;
  fn(d);
  if (d === draft) writeDraft(d);
  renderEditor();
}

async function renderLifts(): Promise<void> {
  await loadSessions();
  draft ??= readDraft();

  const names = templateNames(sessions);
  const chips = $("templates");
  chips.replaceChildren();
  for (const name of [...names, ""]) {
    const b = document.createElement("button");
    b.textContent = name || "Blank";
    b.className = name ? "chip" : "chip blank";
    b.addEventListener("click", () => start(name));
    chips.append(b);
  }

  // One or the other. Offering to start a second session while one is open is
  // the only way to lose a draft, so the offer is simply not made.
  const resume = $<HTMLButtonElement>("lift-resume");
  $("lift-new").hidden = draft !== null;
  resume.hidden = draft === null;
  // Only ever a session in progress, and so only ever one wording: a draft is
  // now something you started and have not finished, never a past session you
  // happened to open.
  if (draft) {
    resume.textContent =
      `Resume — ${draft.name || "Unnamed session"} · started ${atTime(draft.at)}`;
  }

  const ul = $("sessions");
  ul.replaceChildren();
  for (const { day: on, session } of sessions) {
    const li = document.createElement("li");
    const row = document.createElement("button");
    row.className = "row";

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = humanDay(on);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = session.name ?? "Unnamed";

    const sum = document.createElement("span");
    sum.className = "macros";
    sum.textContent = summarise(session);

    row.append(when, name, sum);
    row.addEventListener("click", () => open(on, session.id));
    li.append(row);
    ul.append(li);
  }

  $("lifts-note").textContent = sessions.length
    ? `Last ${historyDays()} days.`
    : "No sessions yet. Start one above — name it, and the name becomes a template.";
}

function start(name: string): void {
  const from = name ? lastSessionNamed(sessions, name) : null;
  draft = newDraft(todayKey(), nowStamp(), name, from);
  writeDraft(draft);
  enter();
}

/**
 * Always a fresh read from history rather than anything held over. Nothing an
 * edit does is kept once it is left, so there is never a newer copy to prefer —
 * which is exactly why opening one no longer has to refuse while a session is
 * in progress.
 */
function open(on: DayKey, id: string): void {
  const found = sessions.find((s) => s.day === on && s.session.id === id);
  if (!found) return;
  edit = draftOf(on, found.session);
  enter();
}

/** Opens the editor on whichever of the two is now set. */
function enter(): void {
  const d = current();
  if (!d) return;
  $<HTMLInputElement>("l-name").value = d.name;
  msg("lift-msg", "");
  show("lift");
  renderEditor();
}

/**
 * The set grid. Rebuilt whole on every change, which is what the items list
 * does and is affordable at this size — and the two inputs worth keeping focus
 * in, the session name and the add-exercise box, live outside it in the markup.
 */
function renderEditor(): void {
  const d = current();
  if (!d) return;

  $("lift-when").textContent = `${humanDay(d.day)} · started ${atTime(d.at)}`;
  // Delete removes the session from the repo and so is only ever offered for one
  // that is in it. Discard says which of the two it throws away, because in an
  // edit it sits next to Delete and the difference is the whole point.
  $<HTMLButtonElement>("l-delete").hidden = edit === null;
  $("l-discard").textContent = edit ? "Discard changes" : "Discard";

  const list = $("l-exercises");
  list.replaceChildren();

  d.exercises.forEach((ex, ei) => {
    const block = document.createElement("div");
    block.className = "exercise";

    const head = document.createElement("h3");
    const title = document.createElement("span");
    title.className = "ex-name";
    title.textContent = ex.name;
    const drop = document.createElement("button");
    drop.textContent = "×";
    drop.title = "Remove exercise";
    drop.addEventListener("click", () =>
      editDraft((x) => {
        x.exercises.splice(ei, 1);
      }),
    );
    head.append(title, drop);
    block.append(head);

    ex.sets.forEach((set, si) => {
      const row = document.createElement("div");
      // A set that has not been confirmed is last session's number, not this
      // one's. It is shown so it can be agreed with in one tap, and dropped on
      // save if it never was.
      row.className = set.done ? "set" : "set ghost";

      const number = (value: number, step: string, unit: string, apply: (n: number) => void) => {
        const i = document.createElement("input");
        i.type = "number";
        i.inputMode = "decimal";
        i.min = "0";
        i.step = step;
        i.className = unit;
        i.setAttribute("aria-label", unit === "kg" ? "Weight in kilograms" : "Repetitions");
        // Zero shows as empty, which is what a bodyweight set is: no added load.
        i.value = value ? String(value) : "";
        // Typing a number *is* saying you did it that way, so an edit confirms
        // the row. Reps decide, because a set with none did not happen.
        i.addEventListener("change", () =>
          editDraft(() => {
            apply(Number(i.value));
            set.done = set.reps > 0;
          }),
        );
        return i;
      };

      // Same .field pairing the weight and food boxes use: the unit sits beside
      // the input rather than in its placeholder, so it is still there once the
      // box has a number in it — which is the whole of when you need it. Read
      // together the row is the sentence said out loud: "24 kilos times 10".
      const field = (input: HTMLInputElement, text: string) => {
        const wrap = document.createElement("span");
        wrap.className = "field";
        const unit = document.createElement("span");
        unit.className = "unit";
        unit.textContent = text;
        wrap.append(input, unit);
        return wrap;
      };

      const by = document.createElement("span");
      by.className = "by";
      by.textContent = "×";

      const act = document.createElement("button");
      act.textContent = set.done ? "×" : "✓";
      act.title = set.done ? "Remove set" : "Confirm as it stands";
      act.disabled = !set.done && set.reps <= 0;
      act.addEventListener("click", () =>
        editDraft((x) => {
          if (set.done) x.exercises[ei]!.sets.splice(si, 1);
          else set.done = true;
        }),
      );

      row.append(
        field(number(set.weight_kg, "0.5", "kg", (n) => (set.weight_kg = n)), "kg"),
        by,
        field(number(set.reps, "1", "reps", (n) => (set.reps = n)), "reps"),
        act,
      );
      block.append(row);
    });

    const add = document.createElement("button");
    add.className = "add-set";
    add.textContent = "+ set";
    // Cloned from the last row and confirmed on arrival: a set you deliberately
    // added is one you did, and the common case is that it repeats the last.
    add.addEventListener("click", () =>
      editDraft((x) => {
        const sets = x.exercises[ei]!.sets;
        const last = sets[sets.length - 1];
        sets.push({ weight_kg: last?.weight_kg ?? 0, reps: last?.reps ?? 0, done: true });
      }),
    );

    // The arrows share the row rather than taking one of their own, and share it
    // with `+ set` rather than crowding the h3, because both are things done to
    // the exercise as a whole — which is what this row already was. Sized to the
    // same box as the set buttons, they also land in the one right-hand column
    // every other control on this screen keeps to.
    const foot = document.createElement("div");
    foot.className = "ex-foot";
    foot.append(add);

    // An arrow with nowhere to go is not drawn at all, which is also the whole of
    // why a single exercise needs no saying: it is both the first and the last, so
    // both directions fall out and `+ set` takes back the full width.
    for (const dir of [-1, 1] as const) {
      const to = ei + dir;
      if (to < 0 || to >= d.exercises.length) continue;

      const move = document.createElement("button");
      move.className = "move";
      move.textContent = dir < 0 ? "↑" : "↓";
      move.title = dir < 0 ? "Move up" : "Move down";
      move.setAttribute("aria-label", `Move ${ex.name} ${dir < 0 ? "up" : "down"}`);
      move.addEventListener("click", () =>
        editDraft((x) => {
          x.exercises = moved(x.exercises, ei, to);
        }),
      );
      foot.append(move);
    }

    block.append(foot);
    list.append(block);
  });

  const names = exerciseNames(sessions);
  const dl = $("exercise-names");
  dl.replaceChildren();
  for (const name of names) {
    const o = document.createElement("option");
    o.value = name;
    dl.append(o);
  }

  $<HTMLButtonElement>("l-save").disabled = confirmedSets(d) === 0;
}

$("lift-resume").addEventListener("click", () => enter());

$("lift-back").addEventListener("click", () => show("lifts"));

$("l-name").addEventListener("input", () => {
  // Not through editDraft: the grid does not depend on the name, and rebuilding
  // it under the cursor would be the one place that costs focus mid-word.
  const d = current();
  if (!d) return;
  d.name = $<HTMLInputElement>("l-name").value;
  if (d === draft) writeDraft(d);
});

$("l-add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = val("l-exercise");
  if (!name) return;
  ($("l-add-form") as HTMLFormElement).reset();
  // Prefilled from the last time this movement was done in *any* session, not
  // just this template — which is the answer to "what did I lift last time" no
  // matter which day it was on.
  const previous = sessions
    .flatMap((s) => s.session.exercises)
    .find((x) => exerciseKey(x.name) === exerciseKey(name));
  editDraft((d) => {
    d.exercises.push({
      name,
      sets: previous
        ? previous.sets.map((s) => ({ weight_kg: s.weight_kg, reps: s.reps }))
        : [{ weight_kg: 0, reps: 0 }],
    });
  });
});

$("l-save").addEventListener("click", async () => {
  const d = current();
  if (!d) return;
  const session = finish(d);
  if (!session) return msg("lift-msg", "Confirm at least one set first.", "err");

  await updateDay(d.day, (x) => {
    const list = x.sessions ?? [];
    const i = list.findIndex((s) => s.id === session.id);
    if (i === -1) list.push(session);
    else list[i] = session;
    x.sessions = list.sort(byAt);
  });
  // Saving an edit finishes nothing: a session left in progress is still in
  // progress afterwards, and show() below is what ends the edit itself.
  if (!edit) {
    clearDraft();
    draft = null;
  }
  await sync();
  show("lifts");
  flash("lifts-msg", "Session saved.");
});

$("l-discard").addEventListener("click", () => {
  // For an edit this throws away the changes only — the session it was opened
  // from stays in the repo, and any session in progress stays in the outbox.
  if (!edit) {
    clearDraft();
    draft = null;
  }
  show("lifts");
});

$("l-delete").addEventListener("click", async () => {
  // Hidden unless this is an edit, so it can only ever be a session on disk.
  if (!edit) return;
  const { day: on, id } = edit;
  await updateDay(on, (x) => {
    const left = (x.sessions ?? []).filter((s) => s.id !== id);
    if (left.length) x.sessions = left;
    else delete x.sessions;
  });
  await sync();
  show("lifts");
  flash("lifts-msg", "Session deleted.");
});

// ----------------------------------------------------------------- settings

/**
 * The ⓘ next to each setting, built from the label's data-tip so the markup
 * carries the words and nothing else. Hover shows it where there is a mouse;
 * a tap opens it and the next tap anywhere closes it, which is the nearest
 * thing to hovering that a finger has.
 */
function buildTips(): void {
  for (const label of document.querySelectorAll<HTMLElement>("#settings label[data-tip]")) {
    const text = label.dataset["tip"]!;
    const tip = document.createElement("button");
    tip.type = "button";
    tip.className = "tip";
    tip.textContent = "ⓘ";
    tip.setAttribute("aria-label", text);

    const bubble = document.createElement("span");
    bubble.className = "bubble";
    bubble.textContent = text;
    tip.append(bubble);

    // Inside a label, a click on anything reaches the control — on a checkbox
    // row it would toggle the box. Cancelling the default is what stops that.
    tip.addEventListener("click", (e) => {
      e.preventDefault();
      const wasOpen = tip.classList.contains("open");
      closeTips();
      tip.classList.toggle("open", !wasOpen);
    });

    // The control comes first on a checkbox row and last everywhere else, and
    // the ⓘ belongs after the words either way.
    const control = label.querySelector("input, select");
    if (control && !label.classList.contains("check")) label.insertBefore(tip, control);
    else label.append(tip);
  }
}

function closeTips(): void {
  for (const t of document.querySelectorAll(".tip.open")) t.classList.remove("open");
}

// Runs after the tip's own handler, which is why an open one survives its own
// click.
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".tip")) closeTips();
});

// A required field in a folded section still blocks the save, and the browser
// cannot focus what it cannot show — so the section holding it is unfolded.
// invalid does not bubble; capture is how one listener covers every field.
$("settings-form").addEventListener(
  "invalid",
  (e) => {
    (e.target as HTMLElement).closest("details")?.setAttribute("open", "");
  },
  true,
);

buildTips();

function fillSettingsForms(): void {
  const s = loadSettings();
  if (s) {
    $<HTMLInputElement>("c-repo").value = repoUrl(s);
    $<HTMLInputElement>("c-branch").value = s.branch;
    $<HTMLInputElement>("c-pat").value = s.pat;
    $<HTMLInputElement>("c-anthropic").value = s.anthropicKey ?? "";
    $<HTMLInputElement>("c-openai").value = s.openaiKey ?? "";
  }

  // Already merged over the defaults by the store, so every field has a value
  // whether or not the stored config mentions it.
  const c = cachedConfig() ?? defaultConfig();
  for (const [id, path] of FIELDS) {
    const value = at(c, path);
    if (typeof value === "boolean") $<HTMLInputElement>(id).checked = value;
    else $<HTMLInputElement>(id).value = String(value);
  }

  $("notify-note").textContent =
    "Best effort: the device has to allow notifications, and one can arrive late" +
    " or, if gainz is closed and the browser will not wake it, not at all.";
}

/**
 * The inverse. A select answers to .value just like an input, so one loop reads
 * both. Anything unreadable falls back to its default rather than being saved
 * as NaN, which is the same guarantee the store gives on the way in.
 */
function readConfigForm(): Config {
  const raw: Record<string, unknown> = {};
  for (const [id, path, fallback] of FIELDS) {
    const value =
      typeof fallback === "boolean" ? checked(id) : typeof fallback === "number" ? num(id) : val(id);
    put(raw, path, value);
  }
  return withDefaults(raw);
}

function readConnForm(): Settings {
  return {
    repo: parseRepo(val("c-repo")),
    branch: val("c-branch"),
    pat: val("c-pat"),
    anthropicKey: val("c-anthropic"),
    openaiKey: val("c-openai"),
  };
}

const sameSettings = (a: Settings | null, b: Settings): boolean =>
  !!a && (Object.keys(b) as (keyof Settings)[]).every((k) => a[k] === b[k]);

/**
 * One save for both halves of the screen. They still land in two different
 * places — the config in the repo, the credentials in localStorage — but that
 * is a storage detail, and making the user press two buttons to act on it was
 * letting it leak into the UI.
 *
 * The config is written first and unconditionally: it is a local write behind
 * an outbox, so it cannot fail, and holding it hostage to a network check on
 * credentials that may not even have changed would be the wrong trade.
 */
$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  let s: Settings;
  try {
    s = readConnForm();
  } catch (err) {
    msg("settings-msg", (err as Error).message, "err");
    return;
  }

  const c = readConfigForm();
  saveConfig(c);

  // Permission is asked for here rather than on the toggle: this is the point
  // where the times are settled, and a prompt that appears mid-edit gets
  // dismissed. render() below re-plans against whatever the answer was.
  const wanted = c.notifications.weight.enabled || c.notifications.nutrition.enabled;
  if (wanted) $("notify-note").textContent = await requestReminders();

  // Only worth a round trip when they actually changed — otherwise every edit
  // to a number would need the network to succeed, and saving offline is a
  // thing this app is supposed to be good at.
  if (!sameSettings(loadSettings(), s)) {
    msg("settings-msg", "Checking the connection…");
    try {
      await checkAccess(s);
    } catch (err) {
      // The config above is already saved and queued; only the credentials are
      // refused, so say which half did not land.
      msg("settings-msg", `Config saved. Connection not: ${(err as Error).message}`, "err");
      return;
    }
    saveSettings(s);
  }

  await sync();
  await render();
  $("config-banner").hidden = true;
  flash("settings-msg", "Saved.");
});

// -------------------------------------------------------------------- export
//
// The document is built here and handed straight to the platform: clipboard,
// share sheet, or a file. There is no upload and no third party — where it goes
// is whatever the user pastes it into, which is the only reason this is a
// button and not a feature with an API key behind it.

/** The last document built, and what all three buttons act on. */
let exported: string | null = null;

const exportFile = () => `gainz-context-${todayKey()}.md`;

/**
 * When the export was taken, and where in the world "today" means. Built by
 * hand rather than with toLocaleString, which renders 8/14/2026 in one locale
 * and 14-8-2026 in the next — an ambiguity the document spends a section
 * avoiding everywhere else. The zone is named because every day key below it is
 * a local calendar date and nothing else says which local.
 */
function stamp(): string {
  const t = new Date();
  const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return `${todayKey()} ${hhmm} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

const exportButtons = () => ["x-copy", "x-share", "x-download"].map((id) => $<HTMLButtonElement>(id));

/**
 * Rebuilt every time the section is opened rather than cached, so what gets
 * pasted is never a stale copy of this morning. It costs nothing after the
 * first: the months it reads are fetched once per session by the store, and
 * everything downstream is arithmetic.
 */
async function buildExport(): Promise<void> {
  const today = todayKey();
  for (const b of exportButtons()) b.disabled = true;
  msg("export-msg", "Building…");

  try {
    const days = await readRange(contextFrom(today), today);
    exported = buildContext(cachedConfig() ?? defaultConfig(), days, {
      today,
      generatedAt: stamp(),
    });
  } catch (e) {
    msg("export-msg", `Could not build the export: ${(e as Error).message}`, "err");
    return;
  }

  const text = $<HTMLTextAreaElement>("x-text");
  text.value = exported;
  text.hidden = false;
  // Both figures, because they answer different questions: kilobytes for
  // whether a paste box will take it, tokens for whether a chat will.
  $("export-size").textContent =
    `${Math.round(exported.length / 1024)} KB · roughly ${Math.round(exported.length / 4000)}k tokens`;
  msg("export-msg", "");
  for (const b of exportButtons()) b.disabled = false;
}

const exportSection = $<HTMLDetailsElement>("export");
exportSection.addEventListener("toggle", () => {
  if (exportSection.open) void buildExport();
});

$("x-copy").addEventListener("click", async () => {
  if (!exported) return;
  try {
    await navigator.clipboard.writeText(exported);
    flash("export-msg", "Copied. Paste it into a chat and ask your question.");
  } catch {
    // Denied, or an insecure context. The textarea below is already the answer.
    $<HTMLTextAreaElement>("x-text").select();
    msg("export-msg", "Clipboard refused — the text below is selected, copy it by hand.", "err");
  }
});

// The one that matters on a phone: the share sheet puts the document into the
// Claude or ChatGPT app directly. As a file where the platform will take one,
// since a composer handles an attachment better than a 30 KB paste, and as text
// where it will not. Hidden entirely where there is no sheet to open.
const shareButton = $<HTMLButtonElement>("x-share");
if (typeof navigator.share === "function") shareButton.hidden = false;

shareButton.addEventListener("click", async () => {
  if (!exported) return;
  const file = new File([exported], exportFile(), { type: "text/markdown" });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else await navigator.share({ text: exported });
  } catch (e) {
    // Dismissing the sheet rejects, and is not a failure worth reporting.
    if ((e as Error).name !== "AbortError") {
      msg("export-msg", `Share failed: ${(e as Error).message}`, "err");
    }
  }
});

$("x-download").addEventListener("click", () => {
  if (!exported) return;
  const url = URL.createObjectURL(new Blob([exported], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFile();
  a.click();
  // Revoked on the next turn rather than immediately: the click starts the save
  // asynchronously, and pulling the URL out from under it can cancel it.
  setTimeout(() => URL.revokeObjectURL(url));
  flash("export-msg", "Saved. Attach it to a chat and ask your question.");
});

// -------------------------------------------------------------------- start

addEventListener("online", () => void sync());

/**
 * Returning to the app is when another device's changes should show up. Only
 * the months on screen are re-read: older ones do not change in practice, and
 * on a phone every extra request is a visible delay.
 */
async function refresh(): Promise<void> {
  invalidateMonths(monthOf(day), monthOf(todayKey()));
  await sync();
  await render();
}

addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

// The path is relative, so the worker registers at whatever prefix the app is
// served from and its scope covers exactly the app. Failure is ignored: offline
// support is a bonus and must never keep the app from starting.
//
// A module worker, so it can import the reminder logic the page also uses
// rather than carrying a hand-synced copy of it.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { type: "module" }).catch(() => {});
}

void boot();
