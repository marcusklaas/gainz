// The AI context export: the log as one document to paste into a general
// chatbot, so the question can be asked there rather than built into this app.
//
// Pure, like the estimators it is built on — a `Map<DayKey, Day>` and a config
// in, a string out, nothing touched on the way. What it exports is *context*
// and never a question: the prompt is whatever the user types after pasting.
//
// Markdown carrying fenced CSV, rather than JSON. The prose is load-bearing —
// half the numbers here are unusual enough that a model reading them cold would
// misread them, and "How to read this" is the section that stops it. CSV is
// what makes the tables analysable: any chatbot with a code tool can lift a
// fenced block straight into a dataframe, and it costs roughly half the tokens
// of the same table drawn in Markdown pipes.
//
// One string, because the transfer is a paste. Everything else — copy, share
// sheet, download — is that same string handed to a different browser API.
import { addDays, atTime, monthOf, parseDay, toDayKey } from "./dates.js";
import {
  dayKcal,
  dayProtein,
  estimate,
  holtSeries,
  WEEK_DAYS,
  weekSummary,
  weightSamples,
  type Estimate,
} from "./estimate.js";
import {
  e1rmPoints,
  fitTotal,
  panelFit,
  sessionsOf,
  strengthIndex,
  strengthOf,
  type DatedSession,
  type IndexPoint,
  type LiftPoint,
} from "./lifts.js";
import { EPLEY_REPS, type Config, type Day, type DayKey } from "./types.js";

/**
 * How much of each thing goes in. Constants rather than config: these are the
 * shape of the document, not a personal preference, and four more knobs on the
 * Settings screen would cost more than they could ever buy for a button pressed
 * once a month.
 *
 * Sized to be generous rather than minimal. The whole document lands around
 * 30 KB — well under 10k tokens — so there is nothing here worth trimming, and
 * a window that is too short is a question that cannot be answered.
 */
export const WINDOW = {
  /** One row per day: where "what did I actually do" lives. */
  dailyDays: 90,
  /** Item-level food. The bulkiest section per day, and the most personal. */
  foodDays: 21,
  sessionDays: 90,
  weeks: 26,
  months: 24,
} as const;

/**
 * The earliest day the export reads, so the caller knows what to load. The
 * monthly rollups reach furthest back, and they start at the first of their
 * oldest month rather than a round number of days ago — a half month of days
 * averaged into a monthly row would read as a collapse in logging.
 */
export function contextFrom(today: DayKey): DayKey {
  const [y, m] = today.split("-").map(Number);
  return toDayKey(new Date(y!, m! - 1 - (WINDOW.months - 1), 1));
}

// ------------------------------------------------------------------- csv

/**
 * Whitespace is collapsed before anything else, which is what keeps a food
 * description typed over three lines from becoming three rows. Quoting is then
 * only ever about commas and quotes.
 */
function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (...cells: (string | number | null | undefined)[]): string => cells.map(cell).join(",");

/**
 * A number to fixed digits, or empty. Empty means "not recorded" everywhere in
 * this document, and never zero — which the header says out loud.
 *
 * A value that rounds to zero loses its sign: "-0.00" is a rate of nothing
 * wearing a direction it does not have, and a reader is entitled to take the
 * minus seriously.
 */
const n = (x: number | null | undefined, digits = 0): string => {
  if (x === null || x === undefined || !Number.isFinite(x)) return "";
  const s = x.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
};

/** A proportion as a signed percentage: 0.045 reads "+4.5". */
const pct = (p: number | null, digits = 1): string =>
  p === null || !Number.isFinite(p) ? "" : `${p < 0 ? "" : "+"}${(p * 100).toFixed(digits)}`;

function block(heading: string, header: string, rows: string[]): string {
  if (!rows.length) return `## ${heading}\n\nNothing in this window.\n`;
  return `## ${heading}\n\n\`\`\`csv\n${header}\n${rows.join("\n")}\n\`\`\`\n`;
}

// --------------------------------------------------------------- helpers

const mean = (ns: number[]): number | null =>
  ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;

/** Fully logged, by exactly the rule the estimator counts by. */
const isCounted = (d: Day): boolean => d.logging === "complete" && d.items.length > 0;

const setsIn = (d: Day): number =>
  (d.sessions ?? []).reduce((k, s) => k + s.exercises.reduce((m, e) => m + e.sets.length, 0), 0);

const topE1rm = (sets: { weight_kg: number; reps: number }[]): number | null => {
  const best = Math.max(
    0,
    ...sets.filter((s) => s.weight_kg > 0 && s.reps > 0).map((s) => s.weight_kg * (1 + s.reps / EPLEY_REPS)),
  );
  return best || null;
};

/** Days in [from, to] that exist, oldest first. */
function span(days: Map<DayKey, Day>, from: DayKey, to: DayKey): [DayKey, Day][] {
  return [...days.entries()]
    .filter(([k]) => k >= from && k <= to)
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The estimate as it would have read on the evening of `upto`, from data up to
 * and including that day and nothing after it. Both halves matter: the map is
 * truncated so the smoothed weight cannot see the future, and `today` is handed
 * the day *after*, because `estimate` excludes its own today as still in
 * progress and here the day in question is finished.
 *
 * This is what makes the TDEE column a trajectory rather than today's number
 * stamped on every row — a distinction the reader cannot make for itself, so
 * getting it wrong would quietly invent an adaptation story.
 */
function estimateAt(cfg: Config, days: Map<DayKey, Day>, upto: DayKey): Estimate | null {
  const sub = new Map([...days.entries()].filter(([k]) => k <= upto));
  return estimate(cfg, sub, addDays(upto, 1));
}

/** Monday of the week `day` falls in. */
function weekStart(day: DayKey): DayKey {
  return addDays(day, -((parseDay(day).getDay() + 6) % 7));
}

interface Period {
  from: DayKey;
  to: DayKey;
}

interface Rollup {
  complete: number;
  kcal: number | null;
  protein: number | null;
  /** Counted days whose intake landed inside the band around that day's
   *  recorded goal. Days with no recorded goal cannot be judged and are out. */
  inBand: number;
  weightStart: number | null;
  weightEnd: number | null;
  kgPerWeek: number | null;
  tdee: number | null;
  sessions: number;
  sets: number;
  si: number | null;
}

function rollup(
  cfg: Config,
  days: Map<DayKey, Day>,
  p: Period,
  today: DayKey,
  trend: Map<DayKey, number>,
  index: IndexPoint[],
): Rollup {
  const half = cfg.goal.kcalWindow / 2;
  const inRange = span(days, p.from, p.to);

  const kcals: number[] = [];
  const proteins: number[] = [];
  let inBand = 0;
  let sessions = 0;
  let sets = 0;

  for (const [, d] of inRange) {
    sessions += (d.sessions ?? []).length;
    sets += setsIn(d);
    if (!isCounted(d)) continue;
    const kcal = dayKcal(d);
    kcals.push(kcal);
    proteins.push(dayProtein(d));
    if (d.goal_kcal !== undefined && Math.abs(kcal - d.goal_kcal) <= half) inBand++;
  }

  // Smoothed weight, not the raw scale reading: the endpoints of a period are
  // otherwise two arbitrary weigh-ins and their difference is mostly water.
  const weights = inRange.map(([k]) => trend.get(k)).filter((x): x is number => x !== undefined);

  const end = p.to <= today ? p.to : today;
  const est = estimateAt(cfg, days, end);

  return {
    complete: kcals.length,
    kcal: mean(kcals),
    protein: mean(proteins),
    inBand,
    weightStart: weights[0] ?? null,
    weightEnd: weights[weights.length - 1] ?? null,
    kgPerWeek: est?.trend?.kgPerWeek ?? null,
    tdee: est?.tdee ?? null,
    sessions,
    sets,
    si: [...index].reverse().find((q) => q.day <= end)?.x ?? null,
  };
}

// -------------------------------------------------------------- sections

function preamble(cfg: Config, today: DayKey, generatedAt: string): string {
  const age = (Date.parse(today) - Date.parse(cfg.bio.birth)) / (365.2425 * 864e5);
  const g = cfg.goal;
  const e = cfg.estimator;
  const direction = g.kcalOffset < 0 ? "deficit" : g.kcalOffset > 0 ? "surplus" : "maintenance";

  return [
    `# gainz export — generated ${generatedAt}`,
    "",
    "A personal weight, nutrition and lifting log. Weights are kilograms, energy",
    "is kilocalories, protein is grams. Dates are local calendar dates.",
    "",
    "## Profile and goal",
    "",
    `- ${cfg.bio.sex === "m" ? "Male" : "Female"}, ${age.toFixed(0)}, ${cfg.bio.heightCm} cm`,
    `- Calorie goal: estimated TDEE ${g.kcalOffset >= 0 ? "+" : ""}${g.kcalOffset} kcal (a ${direction}),` +
      ` with a ${g.kcalWindow} kcal band around it — ±${g.kcalWindow / 2}.`,
    `- Protein goal: ${g.proteinGPerKg} g per kg of smoothed body weight.`,
    `- TDEE is fitted over ${e.tdeeWindowDays} days and fully trusted at` +
      ` ${e.blendFullConfidenceDays} counted days; below that it is blended with a` +
      ` Mifflin–St Jeor estimate at activity factor ${e.activityFactor}.`,
    `- The strength verdict is fitted over ${cfg.strength.windowDays} days.`,
    "",
    "## How to read this",
    "",
    "- **An empty cell means not recorded, never zero.** Averages skip them.",
    "- `complete` is the user confirming the day was fully logged. Days without it",
    "  are under-logged rather than low-intake, and no intake average in this",
    "  document includes them. Treat a missing day as no information at all.",
    "- `goal_kcal` is the calorie target the app displayed that day, written once",
    "  and never revised. It is history, not an aspiration restated.",
    "- `tdee` is re-derived at each row's own date, from data up to that date only.",
    "  Reading down the column is therefore a trajectory: it shows metabolic",
    "  adaptation and logging quality changing over time, not one number repeated.",
    "- `kg_per_wk` is an OLS fit of weigh-ins over the estimator window ending at",
    `  that row, so it lags a turn by about ${Math.round(e.tdeeWindowDays / 2)} days.`,
    "- `weight_trend_kg` is Holt-smoothed, not the scale reading. It exists only on",
    "  days that were weighed.",
    "- `in_band_days` is measured against that day's stored `goal_kcal`. The band",
    "  actually shown in the app is shifted by a slow bias correction, so the two",
    "  can differ while intake is persistently off target.",
    "- `top_e1rm_kg` is Epley (`weight × (1 + reps/30)`) on the best set of that",
    "  exercise that day. It is a proxy, not a tested max.",
    "- `pct_per_wk` is percent per week of estimated one-rep max, fitted over that",
    "  exercise's whole history, and blank where there are too few appearances to",
    "  fit one.",
    "- `si` is a chained strength index in **log points**, pooled across whatever",
    "  was trained. Only differences mean anything — `exp(Δ) − 1` is the",
    "  proportional change, so +0.10 is about +10.5%. The level is arbitrary and",
    "  the first point is zero by construction. A new exercise can join the index",
    "  but cannot move it, so adding movements never inflates progress.",
    "- Food `kcal` and `protein_g` are a language model's estimate from the",
    "  description, except where `source` is `manual`. They are rough per item and",
    "  only useful in aggregate.",
    "- The windows below differ by section, and there is older data in the app",
    "  than appears here. Say so rather than concluding a period was empty.",
    "",
  ].join("\n");
}

function now(cfg: Config, days: Map<DayKey, Day>, today: DayKey): string {
  const est = estimate(cfg, days, today);
  const list = sessionsOf(days);
  const s = strengthOf(list, today, cfg.strength.windowDays);
  const w = weekSummary(days, today, est?.proteinTarget ?? null);
  const lines: string[] = [`## Where things stand on ${today}`, ""];

  if (est) {
    const t = est.trend;
    lines.push(
      `- Smoothed weight ${est.trendKg.toFixed(1)} kg` +
        (t ? `, moving ${t.kgPerWeek >= 0 ? "+" : ""}${t.kgPerWeek.toFixed(2)} ± ${(2 * t.stdErrKgPerWeek).toFixed(2)} kg/week (2σ)` : ", rate not yet measurable"),
      `- TDEE ${Math.round(est.tdee)} kcal` +
        (est.tdeeStdErr !== null ? ` ± ${Math.round(2 * est.tdeeStdErr)} (2σ)` : " (formula estimate, not yet measured)") +
        `, from ${est.countedDays} counted days in the last ${est.windowDays}`,
      `- Today's band ${Math.round(est.kcalLower)}–${Math.round(est.kcalUpper)} kcal;` +
        ` uncorrected goal ${Math.round(est.goalKcal)}, bias ${est.bias.kcal >= 0 ? "+" : ""}${Math.round(est.bias.kcal)} kcal over ${est.bias.days} counted days`,
      `- Protein target ${Math.round(est.proteinTarget)} g/day`,
    );
  } else {
    lines.push("- No weigh-ins yet, so there is no weight trend, TDEE or protein target.");
  }

  if (s.fit) {
    const f = s.fit;
    const band = ((fitTotal(f, 2) - fitTotal(f, -2)) / 2) * 100;
    const covers = Math.abs(fitTotal(f) * 100) < band;
    lines.push(
      `- Strength ${pct(fitTotal(f))}% ± ${band.toFixed(1)}% over ${f.windowDays} days,` +
        ` from ${f.points} exercise-sessions across ${f.exercises} exercises` +
        (covers ? " — the interval covers zero, so this is not yet a finding" : ""),
    );
  } else {
    lines.push("- Not enough repeated exercises yet to fit a strength trend.");
  }

  lines.push(
    `- Last ${WEEK_DAYS} days: ${w.logged} days fully logged, ` +
      (w.intake
        ? `${Math.round(w.intake.kcal)} kcal average against a ${Math.round(w.intake.goal)} target over ${w.intake.days} of them, `
        : "no comparable intake, ") +
      `protein target hit on ${w.proteinHit}, ${w.weighed} weigh-ins, ` +
      `${w.sessions} sessions and ${w.sets} sets`,
    "",
  );
  return lines.join("\n");
}

function weekly(
  cfg: Config,
  days: Map<DayKey, Day>,
  today: DayKey,
  trend: Map<DayKey, number>,
  index: IndexPoint[],
): string {
  const rows: string[] = [];
  const first = addDays(weekStart(today), -7 * (WINDOW.weeks - 1));

  for (let from = first; from <= today; from = addDays(from, 7)) {
    const p: Period = { from, to: addDays(from, 6) };
    const r = rollup(cfg, days, p, today, trend, index);
    rows.push(
      row(
        from,
        r.complete,
        n(r.kcal),
        n(r.protein),
        r.inBand,
        n(r.weightEnd, 1),
        n(r.kgPerWeek, 2),
        n(r.tdee),
        r.sessions,
        r.sets,
        n(r.si, 3),
      ),
    );
  }

  return block(
    `Weekly (${WINDOW.weeks} weeks, Monday-started)`,
    "week_start,days_complete,kcal_avg,protein_avg,in_band_days,weight_trend_kg,kg_per_wk,tdee,sessions,sets,si",
    rows,
  );
}

function monthly(
  cfg: Config,
  days: Map<DayKey, Day>,
  today: DayKey,
  trend: Map<DayKey, number>,
  index: IndexPoint[],
): string {
  const rows: string[] = [];
  const [y, m] = today.split("-").map(Number);
  // Months before anything was ever logged are dropped rather than shown as a
  // row of empties. A run of them at the top reads as a gap in a history that
  // had not started, which is a different claim from "nothing was logged".
  const first = [...days.keys()].sort()[0] ?? today;

  for (let i = WINDOW.months - 1; i >= 0; i--) {
    const start = new Date(y!, m! - 1 - i, 1);
    const from = toDayKey(start);
    const to = toDayKey(new Date(start.getFullYear(), start.getMonth() + 1, 0));
    if (to < first) continue;
    const r = rollup(cfg, days, { from, to }, today, trend, index);
    rows.push(
      row(
        monthOf(from),
        r.complete,
        n(r.kcal),
        n(r.protein),
        n(r.weightStart, 1),
        n(r.weightEnd, 1),
        n(r.tdee),
        r.sessions,
        r.sets,
        n(r.si, 3),
      ),
    );
  }

  return block(
    `Monthly (${WINDOW.months} months)`,
    "month,days_complete,kcal_avg,protein_avg,weight_start,weight_end,tdee,sessions,sets,si_end",
    rows,
  );
}

function daily(days: Map<DayKey, Day>, today: DayKey, trend: Map<DayKey, number>): string {
  const from = addDays(today, -(WINDOW.dailyDays - 1));
  const rows = span(days, from, today).map(([k, d]) =>
    row(
      k,
      parseDay(k).toLocaleDateString("en-US", { weekday: "short" }),
      n(d.weight_kg, 1),
      n(trend.get(k), 1),
      d.items.length ? n(dayKcal(d)) : "",
      d.items.length ? n(dayProtein(d)) : "",
      n(d.goal_kcal),
      isCounted(d) ? "yes" : "no",
      (d.sessions ?? []).length,
      setsIn(d),
    ),
  );

  return block(
    `Daily (${WINDOW.dailyDays} days)`,
    "day,dow,weight_kg,weight_trend_kg,kcal,protein_g,goal_kcal,complete,sessions,sets",
    rows,
  );
}

function food(days: Map<DayKey, Day>, today: DayKey): string {
  const from = addDays(today, -(WINDOW.foodDays - 1));
  const rows: string[] = [];

  for (const [k, d] of span(days, from, today)) {
    for (const item of d.items) {
      rows.push(row(k, atTime(item.at), item.name, n(item.kcal), n(item.protein_g, 1), item.model ?? "manual"));
    }
  }

  return block(
    `Food log (${WINDOW.foodDays} days, as typed)`,
    "day,time,description,kcal,protein_g,source",
    rows,
  );
}

function sessions(list: DatedSession[], today: DayKey): string {
  const from = addDays(today, -(WINDOW.sessionDays - 1));
  const rows: string[] = [];

  // Oldest first, unlike the screens: a table read top to bottom is a history.
  for (const { day, session } of [...list].reverse()) {
    if (day < from || day > today) continue;
    for (const ex of session.exercises) {
      rows.push(
        row(
          day,
          session.name ?? "",
          ex.name,
          ex.sets.map((s) => `${s.weight_kg}x${s.reps}`).join(" "),
          n(topE1rm(ex.sets), 1),
        ),
      );
    }
  }

  return block(
    `Sessions (${WINDOW.sessionDays} days)`,
    "day,session,exercise,sets,top_e1rm_kg",
    rows,
  );
}

/**
 * Per exercise, over everything loaded. The rate is `panelFit` on that one
 * exercise's points, which for a single series is plain OLS of log e1RM on the
 * day — the same arithmetic the overall verdict uses, restricted, so the two
 * cannot disagree about what they measure. Blank where there are too few
 * appearances to fit one.
 */
function exercises(points: LiftPoint[]): string {
  const groups = new Map<string, LiftPoint[]>();
  for (const p of points) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);

  const rows = [...groups.values()]
    .sort((a, b) => b[b.length - 1]!.day.localeCompare(a[a.length - 1]!.day))
    .map((g) => {
      const first = g[0]!;
      const last = g[g.length - 1]!;
      const fit = panelFit(g, 7);
      return row(
        last.name,
        g.length,
        first.day,
        last.day,
        n(Math.exp(first.x), 1),
        n(Math.exp(last.x), 1),
        fit ? pct(fitTotal(fit)) : "",
      );
    });

  return block(
    "Per exercise (all loaded history, most recently trained first)",
    "exercise,sessions,first_day,last_day,first_e1rm_kg,last_e1rm_kg,pct_per_wk",
    rows,
  );
}

// ----------------------------------------------------------------- build

export interface ContextOptions {
  today: DayKey;
  /** Display stamp for the header — the caller's clock, formatted its way. */
  generatedAt: string;
}

/**
 * The whole document. Ordered widest-context-first: what this is, how to read
 * it, where things stand, then the tables from coarse to fine. A model reading
 * top to bottom has the definitions before the numbers, which is the order that
 * stops it guessing at them.
 */
export function buildContext(cfg: Config, days: Map<DayKey, Day>, o: ContextOptions): string {
  const { today, generatedAt } = o;

  // Computed once and threaded through: the smoothed weight on every weigh-in
  // day, and the strength index over every training day.
  const trend = new Map(
    holtSeries(weightSamples(days), cfg.estimator.levelHalfLifeDays, cfg.estimator.trendHalfLifeDays)
      .map((s) => [s.day, s.kg] as const),
  );
  const list = sessionsOf(days);
  const points = e1rmPoints(list);
  const index = strengthIndex(points);

  return [
    preamble(cfg, today, generatedAt),
    now(cfg, days, today),
    weekly(cfg, days, today, trend, index),
    daily(days, today, trend),
    food(days, today),
    sessions(list, today),
    exercises(points),
    monthly(cfg, days, today, trend, index),
  ].join("\n");
}
