// The estimator pipeline. Pure functions over raw data: nothing here touches
// storage or the DOM, and nothing derived is ever persisted. Improving an
// estimator therefore improves the whole history retroactively. See PLAN.md.
import { addDays, daysBetween } from "./dates.js";
import {
  DAYS_PER_WEEK,
  KCAL_PER_KG_FAT,
  MIFFLIN,
  type Config,
  type Day,
  type DayKey,
} from "./types.js";

export interface Sample {
  day: DayKey;
  kg: number;
}

/** A smoothed point: the level, and the slope the smoother was carrying when it
 *  reached it. */
export interface HoltPoint extends Sample {
  /** kg/day. */
  slope: number;
}

export const dayKcal = (d: Day): number => d.items.reduce((n, i) => n + i.kcal, 0);
export const dayProtein = (d: Day): number => d.items.reduce((n, i) => n + i.protein_g, 0);

export function weightSamples(days: Map<DayKey, Day>): Sample[] {
  const out: Sample[] = [];
  for (const [day, d] of days) if (d.weight_kg) out.push({ day, kg: d.weight_kg });
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Holt linear-trend smoothing, time-aware. Carries a level *and* a slope, so
 * the level is corrected by the trend instead of being dragged behind it.
 *
 * A plain EWMA estimates level only, which puts its weights at a mean age of
 * (1-a)/a — about 14 days at a 10-day half-life. That is the visible lag. Holt
 * removes it without needing future data.
 *
 * Both outputs are used: the level is the smoothed weight on the chart and the
 * input to Mifflin-St Jeor, and the slope is what TDEE is derived from. They
 * come from the same recursion, so the rate shown is the tangent to the curve
 * drawn — a windowed fit alongside it could report a rate the drawn line
 * visibly disagrees with.
 */
export function holtSeries(
  samples: Sample[],
  levelHalfLifeDays: number,
  trendHalfLifeDays: number,
): HoltPoint[] {
  const out: HoltPoint[] = [];
  let level = 0;
  let slope = 0; // kg/day

  for (const s of samples) {
    const last = out[out.length - 1];
    if (!last) {
      level = s.kg;
      out.push({ day: s.day, kg: level, slope });
      continue;
    }
    const gap = Math.max(daysBetween(last.day, s.day), 1);
    const a = 1 - Math.pow(0.5, gap / levelHalfLifeDays);
    const b = 1 - Math.pow(0.5, gap / trendHalfLifeDays);

    const previous = level;
    level = a * s.kg + (1 - a) * (level + slope * gap);
    slope = b * ((level - previous) / gap) + (1 - b) * slope;
    out.push({ day: s.day, kg: level, slope });
  }
  return out;
}

/**
 * The smoother's current slope carried forward from where it left off, one
 * point per day, starting at the last trend point itself.
 *
 * This is the one place the reported rate becomes legible. The headline number
 * is an average of the trend line's own gradient over roughly the last eight
 * days, and eight days is too little width to read a gradient off at any useful
 * chart span — so the drawn curve can look like it is rising while the headline
 * says falling, with both correct. A tangent puts the two next to each other.
 *
 * It repeats the last trend point rather than starting a day after it, so the
 * caller can draw this as its own line and have it grow out of the solid one
 * instead of floating a day to its right.
 *
 * Straight, not curved: the model's forecast genuinely is a straight line. Holt
 * holds its slope until an observation moves it, so anything else drawn here
 * would be a claim the estimator is not making.
 */
export function projection(trend: HoltPoint[], days: number): Sample[] {
  const last = trend[trend.length - 1];
  if (last === undefined || days <= 0) return [];
  const out: Sample[] = [{ day: last.day, kg: last.kg }];
  for (let k = 1; k <= days; k++) {
    out.push({ day: addDays(last.day, k), kg: last.kg + last.slope * k });
  }
  return out;
}

export function mifflinBmr(bio: Config["bio"], kg: number, on: DayKey): number {
  // Both are plain ISO dates, so both parse as UTC midnight and the difference
  // between them carries no timezone.
  const age = (Date.parse(on) - Date.parse(bio.birth)) / (365.2425 * 864e5);
  return (
    MIFFLIN.weight * kg +
    MIFFLIN.height * bio.heightCm -
    MIFFLIN.age * age +
    (bio.sex === "m" ? MIFFLIN.maleOffset : MIFFLIN.femaleOffset)
  );
}

// -------------------------------------------------- intake bias correction
//
// Landing consistently on one side of the calorie band leaves the weekly
// average off target even though every single day was "in range". One leaky
// accumulator of how far intake landed from that day's target — integral
// control with forgetting — shifts the whole band to compensate, without
// narrowing it.
//
// Gain, leak and cap are config, not constants — they are the knobs worth
// turning if the correction feels too eager or too sleepy. Setting the gain to
// zero switches the whole thing off and shows the plain goal.

const clamp = (n: number, limit: number) => Math.min(Math.max(n, -limit), limit);

export interface Bias {
  /** E, in kcal. Positive means consistently eating above target. */
  kcal: number;
  /** How many days went into it. */
  days: number;
}

/**
 * Days with no recorded target are skipped outright — not leaked, not counted
 * as zero intake. A gap in logging says nothing about where this person lands
 * relative to their target, so it should move E neither way.
 */
function accumulate(counted: Counted[], e: Config["estimator"]): Bias {
  let kcal = 0;
  let days = 0;
  for (const c of counted) {
    if (c.goal === undefined) continue;
    kcal = clamp(e.biasLeak * kcal + (c.kcal - c.goal), e.biasMaxKcal);
    days++;
  }
  return { kcal, days };
}

/**
 * The goal shifted against the accumulated bias, damped by the gain and clamped
 * so the band moves by at most its own half-width. The floor is basal metabolic
 * rate — a real physiological line rather than a picked number, and no
 * correction has any business pushing a target below it.
 */
function correctedTarget(goal: number, half: number, bias: number, bmr: number, gain: number) {
  return Math.max(goal - clamp(gain * bias, half), bmr);
}

interface Counted {
  day: DayKey;
  kcal: number;
  /** The target displayed that day. Undefined before the feature existed. */
  goal: number | undefined;
}

export interface Estimate {
  samples: Sample[];
  /** Smoothed weight, one point per weigh-in. */
  trendLine: HoltPoint[];
  trendKg: number;
  /** The smoother's current slope, or null below the two weigh-ins it takes to
   *  have a rate at all. Null rather than zero so "flat" and "unknown" stay
   *  distinguishable, which is the one thing every caller branches on. */
  kgPerWeek: number | null;
  tdee: number;
  countedDays: number;
  /** How far back intake is averaged. No longer bounds the weight trend, which
   *  the smoother carries over the whole history. */
  windowDays: number;
  /** The band as displayed: the corrected target, half the window either side. */
  kcalLower: number;
  kcalUpper: number;
  /** The uncorrected goal. What the day's deviation is measured against. */
  goalKcal: number;
  /** Midpoint of the displayed band. */
  targetKcal: number;
  bias: Bias;
  proteinTarget: number;
}

/**
 * Intake for a day the user has confirmed is fully logged, else null. Every
 * other day — unmarked, empty, still in progress — says nothing about intake
 * and is skipped rather than counted low. See the note on Day.logging.
 */
function countedKcal(day: Day | undefined): number | null {
  if (day?.logging !== "complete" || !day.items.length) return null;
  return dayKcal(day);
}

// ------------------------------------------------------------ week summary

/** Today and the six days before it. Rolling rather than calendar, which is
 *  why the heading names its length instead of saying "this week". */
export const WEEK_DAYS = 7;

export interface Week {
  /** Days confirmed fully logged, by the same rule the estimator counts. */
  logged: number;
  weighed: number;
  /**
   * Both figures over the same days: the ones that are counted *and* carry a
   * pinned target. Intake without a target cannot be compared to one, and
   * averaging the two over different day counts would quietly make them not
   * comparable. Null when no day in the week has both.
   */
  intake: { kcal: number; goal: number; days: number } | null;
  /** Days that cleared the protein target, out of `WEEK_DAYS` — not out of
   *  `logged`, which is the one figure here that is not about intake. */
  proteinHit: number;
  sessions: number;
  sets: number;
}

/**
 * What the last seven days actually held. Reported, never prescribed: there is
 * no "remaining this week" here and there must not be, because a weekly
 * allowance is the calorie banking the design rejects — the bias accumulator is
 * already the soft, automatic version of that idea.
 *
 * The target shown is the stored `goal_kcal` rather than the corrected band
 * centre the user saw each day. The two converge: `accumulate` is integral
 * control, so landing on the band drives the difference to zero, and it is only
 * non-zero while intake is persistently missing — where the gap is itself the
 * information.
 */
export function weekSummary(
  days: Map<DayKey, Day>,
  today: DayKey,
  proteinTarget: number | null,
): Week {
  const w: Week = { logged: 0, weighed: 0, intake: null, proteinHit: 0, sessions: 0, sets: 0 };
  let kcal = 0;
  let goal = 0;
  let withGoal = 0;

  for (let i = 0; i < WEEK_DAYS; i++) {
    const d = days.get(addDays(today, -i));
    if (!d) continue;
    if (d.weight_kg) w.weighed++;
    for (const s of d.sessions ?? []) {
      w.sessions++;
      for (const e of s.exercises) w.sets += e.sets.length;
    }

    // Judged on every day in the window, which is why it is counted before the
    // check below rather than after it. Protein is hit by what was eaten, and a
    // day whose logging was never confirmed can clear the target perfectly well.
    // Intake cannot be read that way — an unconfirmed day looks low simply
    // because it is unfinished — and that difference, not an oversight, is why
    // the two lines are counted over different denominators.
    if (proteinTarget !== null && dayProtein(d) >= proteinTarget) w.proteinHit++;

    // Unlike the TDEE fit, today counts here once it has been ticked. The fit
    // excludes it because a day still in progress drags the average down; a day
    // the user has said is complete is complete, and a summary of the last
    // seven days that silently dropped one of them would be lying about which
    // seven.
    const counted = countedKcal(d);
    if (counted === null) continue;
    w.logged++;
    if (d.goal_kcal !== undefined) {
      kcal += counted;
      goal += d.goal_kcal;
      withGoal++;
    }
  }

  if (withGoal) w.intake = { kcal: kcal / withGoal, goal: goal / withGoal, days: withGoal };
  return w;
}

/** Null until at least one weight exists — there is no basis for a target without it. */
export function estimate(cfg: Config, days: Map<DayKey, Day>, today: DayKey): Estimate | null {
  const e = cfg.estimator;
  const samples = weightSamples(days);
  const trendLine = holtSeries(samples, e.levelHalfLifeDays, e.trendHalfLifeDays);
  const last = trendLine[trendLine.length - 1];
  if (last === undefined) return null;
  const trendKg = last.kg;

  const from = addDays(today, -e.tdeeWindowDays);
  const bmr = mifflinBmr(cfg.bio, trendKg, today);
  const formulaTdee = bmr * e.activityFactor;

  // Today is excluded even if it has already been ticked — a day still in
  // progress would drag the average down hard. It also gives the bias
  // accumulator the property it needs for free: today's target is built from
  // earlier days only, so logging food cannot move it.
  //
  // One pass, oldest first, over every day that counts. The bias fold wants all
  // of it — with a ~17-day half-life a 21-day fold would still be climbing out
  // of its zero start when it reported a number — and the TDEE window is that
  // same list from `from` onwards.
  const counted: Counted[] = [];
  for (const d of [...days.keys()].sort()) {
    if (d >= today) continue;
    const kcal = countedKcal(days.get(d));
    if (kcal !== null) counted.push({ day: d, kcal, goal: days.get(d)!.goal_kcal });
  }
  const inWindow = counted.filter((c) => c.day >= from);

  const avgIntake = inWindow.length
    ? inWindow.reduce((a, c) => a + c.kcal, 0) / inWindow.length
    : null;
  const measuredTdee = avgIntake === null ? null : avgIntake - last.slope * KCAL_PER_KG_FAT;

  // Blend toward the measured value as logged days accumulate. Covers the cold
  // start, vacations, and any stretch of poor logging.
  const w = measuredTdee === null ? 0 : Math.min(inWindow.length / e.blendFullConfidenceDays, 1);
  const tdee = w * (measuredTdee ?? 0) + (1 - w) * formulaTdee;

  // The band keeps its width; only its centre moves. The goal is what today is
  // judged against and what gets recorded — never the shifted target, which
  // would make the correction cancel itself out the moment it took effect.
  const goalKcal = tdee + cfg.goal.kcalOffset;
  const half = cfg.goal.kcalWindow / 2;
  const bias = accumulate(counted, e);
  const targetKcal = correctedTarget(goalKcal, half, bias.kcal, bmr, e.biasGain);

  return {
    samples,
    trendLine,
    trendKg,
    kgPerWeek: samples.length < 2 ? null : last.slope * DAYS_PER_WEEK,
    tdee,
    countedDays: inWindow.length,
    windowDays: e.tdeeWindowDays,
    kcalLower: targetKcal - half,
    kcalUpper: targetKcal + half,
    goalKcal,
    targetKcal,
    bias,
    proteinTarget: trendKg * cfg.goal.proteinGPerKg,
  };
}
