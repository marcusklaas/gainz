// The Trend screen: rolling 7-day summary, weight trend, strength index/e1RM
// with exercise picker, and intake vs TDEE.
import { todayKey } from "../core/dates.js";
import { $, DASH, plural, round } from "./dom.js";
import {
  calorieSeries,
  WEEK_DAYS,
  weekSummary,
  type CaloriePoint,
  type Estimate,
} from "../core/estimate.js";
import {
  e1rmPoints,
  exerciseKey,
  exerciseNames,
  fitTotal,
  selectExercises,
  sessionsOf,
  singleKey,
  strengthOf,
  templateExercises,
  templateNames,
  type DatedSession,
  type Fit,
  type Strength,
} from "../core/lifts.js";
import { cachedConfig } from "../services/store.js";
import type { Config, Day, DayKey } from "../core/types.js";

/** Latest estimate, kept so the chart can be drawn when Trend becomes visible. */
let latest: Estimate | null = null;

/** The same, for the strength index: all three charts on Trend are drawn from
 *  what the last render worked out, whenever the screen is next on show. */
let latestStrength: Strength | null = null;

/**
 * What the strength picture is built from: every session in the loaded
 * history, the picker-narrowed subset of it, and the one key in that subset
 * when it holds exactly one — which is what switches the chart from the
 * pooled index to that movement's own e1RM.
 */
let latestSessions: DatedSession[] = [];
let latestFiltered: DatedSession[] = [];
let latestSingle: string | null = null;

/** The day the latest history was rendered against, for strength picker redraws. */
let latestDay: DayKey = todayKey();

/**
 * Null is everything: the default, and what All restores. An explicit set the
 * moment anything is unchecked, so the boxes always show exactly what the
 * chart is built from. In memory only — a fresh visit opens on the default,
 * like every other view on this screen.
 */
let strengthKeys: Set<string> | null = null;

/** The same, for intake vs TDEE: the third chart on Trend. */
let latestCalories: CaloriePoint[] | null = null;

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
export async function paintChart(): Promise<void> {
  const { drawCalories, drawE1rm, drawStrength, drawTrend } = await (chartModule ??= import("./chart.js"));
  // Every view opens on the same stretch of time: the strength window. For
  // strength it is the window the panel fit is computed over; for calories it
  // shares that window by design; and the weight chart now opens on it too —
  // the TDEE fit no longer has a window of its own to open on, since the joint
  // filter runs over the whole loaded history.
  const cfg = cachedConfig();
  const e = cfg?.estimator;
  const windowDays = cfg?.strength.windowDays ?? 42;
  drawTrend($("chart"), latest?.samples ?? [], latest?.trendLine ?? [], {
    historyDays: windowDays,
    projectionDays: e?.projectionDays ?? 0,
  });
  // One movement in the basket shows its own e1RM in kg; anything else shows
  // the pooled index. The kg class widens the legend slot, which reads
  // "250.0 kg" where the index reads "248.3".
  const single = latestSingle;
  $("strength-chart").classList.toggle("kg", single !== null);
  if (single !== null) {
    drawE1rm(
      $("strength-chart"),
      e1rmPoints(latestFiltered).filter((p) => p.key === single),
      windowDays,
    );
  } else {
    drawStrength($("strength-chart"), latestStrength?.index ?? [], windowDays);
  }
  drawCalories($("calorie-chart"), latestCalories ?? [], windowDays);
}

/** Updates the weight trend headline and cached estimate for the Trend charts. */
export function updateTrendWeight(est: Estimate | null): void {
  latest = est;
  if (!est) {
    $("trend-note").textContent = "No weigh-ins yet. Save one on Today to get started.";
  } else {
    $("trend-note").textContent =
      est.kgPerWeek === null
        ? `${est.samples.length} weigh-in so far — two are needed to draw a chart.`
        : `${est.trendKg.toFixed(1)} kg · ${est.kgPerWeek >= 0 ? "↑" : "↓"}` +
          `${Math.abs(est.kgPerWeek).toFixed(2)} kg/wk`;
  }
  if (!$("trend").hidden) void paintChart();
}

/** Recomputes strength and calorie chart inputs from the loaded history. */
export function updateTrendHistory(day: DayKey, past: Map<DayKey, Day>, cfg: Config): void {
  latestDay = day;
  latestSessions = sessionsOf(past);
  refreshStrength();
  renderStrengthPicker(latestSessions);

  // The same window as the strength verdict above it, over the same history.
  latestCalories = calorieSeries(cfg, past, day, cfg.strength.windowDays);
  renderCalories(latestCalories);
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
function renderStrength(s: Strength | null, nothingThere = false): void {
  const note = $("strength-note");
  const from = $("strength-from");
  const fit = s?.fit ?? null;

  if (!fit) {
    note.textContent = nothingThere
      ? "Nothing in this selection — tick an exercise, or All to restore everything."
      : s && s.index.length
        ? "Not enough logged yet to fit a trend — an exercise has to be repeated to say anything."
        : "No sessions logged yet. The index is built from your best set of each exercise.";
    from.textContent = "";
    return;
  }

  // No "Strength" prefix — the section heading already said it, and the arrow
  // carries the direction on its own.
  note.textContent = `${pct(fitTotal(fit))} ${plusMinus(fit)} over ${fit.windowDays} days`;
  from.textContent = `from ${plural(fit.points, "exercise-session")} across ${plural(fit.exercises, "exercise")}`;
}

// -------------------------------------------------------- strength picker
//
// One tap between everything and one thing. Chips set the basket — All plus
// every template name, each checking the exercises trained under it — and the
// checkboxes tune it, with "only" soloing a row. A single-exercise basket
// switches the chart to that movement's e1RM; the headline never changes
// shape, because panelFit on one series is the same fit.

/** Rebuilds the picture from the current selection, without touching the picker. */
function refreshStrength(): void {
  const cfg = cachedConfig();
  if (!cfg) return;
  latestFiltered = selectExercises(latestSessions, strengthKeys);
  latestSingle = singleKey(latestFiltered);
  latestStrength = strengthOf(latestFiltered, latestDay, cfg.strength.windowDays, cfg.strength.rampHalfLife);
  renderStrength(latestStrength, latestFiltered.length === 0 && latestSessions.length > 0);
  if (!$("trend").hidden) void paintChart();
}

/** Every key in the loaded history — what the first untick subtracts from. */
function allStrengthKeys(): Set<string> {
  const out = new Set<string>();
  for (const { session } of latestSessions) {
    for (const e of session.exercises) out.add(exerciseKey(e.name));
  }
  return out;
}

function setStrengthKeys(keys: Set<string> | null): void {
  strengthKeys = keys;
  syncStrengthPicker();
  refreshStrength();
}

function toggleStrengthKey(key: string, on: boolean): void {
  const next = new Set(strengthKeys ?? allStrengthKeys());
  if (on) next.add(key);
  else next.delete(key);
  strengthKeys = next;
  // The tapped box already shows the new state and the rows are not rebuilt,
  // so the tap never costs focus.
  refreshStrength();
}

/** Checks follow state after a chip or "only" tap. Rows rebuild on render()
 *  only, never under the cursor. */
function syncStrengthPicker(): void {
  for (const box of document.querySelectorAll<HTMLInputElement>("#strength-rows input")) {
    box.checked = strengthKeys === null || strengthKeys.has(box.dataset["key"]!);
  }
}

/** Chips plus checkbox rows, rebuilt whenever the history behind them moves. */
function renderStrengthPicker(sessions: DatedSession[]): void {
  $("strength-filter").hidden = sessions.length === 0;

  const presets = $("strength-presets");
  presets.replaceChildren();
  const all = document.createElement("button");
  all.textContent = "All";
  all.className = "chip";
  all.addEventListener("click", () => setStrengthKeys(null));
  presets.append(all);
  for (const name of templateNames(sessions)) {
    const b = document.createElement("button");
    b.textContent = name;
    b.className = "chip";
    b.addEventListener("click", () => setStrengthKeys(templateExercises(sessions, name)));
    presets.append(b);
  }

  const rows = $("strength-rows");
  rows.replaceChildren();
  for (const name of exerciseNames(sessions)) {
    const key = exerciseKey(name);
    const row = document.createElement("div");
    row.className = "srow";

    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset["key"] = key;
    box.checked = strengthKeys === null || strengthKeys.has(key);
    box.addEventListener("change", () => toggleStrengthKey(key, box.checked));
    const span = document.createElement("span");
    span.textContent = name;
    label.append(box, span);

    const only = document.createElement("button");
    only.type = "button";
    only.textContent = "only";
    only.className = "only";
    only.addEventListener("click", () => setStrengthKeys(new Set([key])));

    row.append(label, only);
    rows.append(row);
  }
}

// ---------------------------------------------------------------- calories
//
// No verdict under this one: unlike strength there is no fit to report, only
// the two lines. The note speaks solely when there is nothing to draw —
// otherwise it stays out of the way.

/** Empty unless the series has nothing to draw, so the note never narrates. */
function renderCalories(points: CaloriePoint[] | null): void {
  const note = $("calorie-note");
  const usable = (points ?? []).filter((p) => p.kcal !== null || p.tdee !== null);
  note.textContent =
    usable.length >= 2
      ? ""
      : "Not enough logged yet to draw intake against TDEE — tick a day complete and weigh in.";
}

/**
 * The week as it happened. Every line survives a missing estimate except
 * protein, whose target needs a weight to exist — so the block is never hidden,
 * and on a fresh install it still reports what has been logged and trained.
 */
export function renderWeek(days: Map<DayKey, Day>, est: Estimate | null): void {
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
