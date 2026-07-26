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

export interface Trend {
  kgPerWeek: number;
  stdErrKgPerWeek: number;
  /** Fitted line is interceptKg + (kgPerWeek / 7) * days since origin. */
  origin: DayKey;
  interceptKg: number;
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
 * removes it without needing future data, and is the discrete cousin of the
 * local-linear-trend Kalman model planned for M4.
 */
export function holtSeries(
  samples: Sample[],
  levelHalfLifeDays: number,
  trendHalfLifeDays: number,
): Sample[] {
  const out: Sample[] = [];
  let level = 0;
  let slope = 0; // kg/day

  for (const s of samples) {
    const last = out[out.length - 1];
    if (!last) {
      level = s.kg;
      out.push({ day: s.day, kg: level });
      continue;
    }
    const gap = Math.max(daysBetween(last.day, s.day), 1);
    const a = 1 - Math.pow(0.5, gap / levelHalfLifeDays);
    const b = 1 - Math.pow(0.5, gap / trendHalfLifeDays);

    const previous = level;
    level = a * s.kg + (1 - a) * (level + slope * gap);
    slope = b * ((level - previous) / gap) + (1 - b) * slope;
    out.push({ day: s.day, kg: level });
  }
  return out;
}

/**
 * OLS of kg against elapsed days. Preferred over differencing the EWMA: lower
 * variance, no lag, gaps need no handling, and it yields a standard error.
 */
export function regress(samples: Sample[]): Trend | null {
  const n = samples.length;
  if (n < 3) return null;

  const origin = samples[0]!.day;
  const x = samples.map((s) => daysBetween(origin, s.day));
  const y = samples.map((s) => s.kg);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i]! - mx) ** 2;
    sxy += (x[i]! - mx) * (y[i]! - my);
  }
  if (sxx === 0) return null; // every sample on the same day

  const slope = sxy / sxx; // kg/day
  const intercept = my - slope * mx;

  let sse = 0;
  for (let i = 0; i < n; i++) sse += (y[i]! - (intercept + slope * x[i]!)) ** 2;

  return {
    kgPerWeek: slope * DAYS_PER_WEEK,
    stdErrKgPerWeek: Math.sqrt(sse / (n - 2) / sxx) * DAYS_PER_WEEK,
    origin,
    interceptKg: intercept,
  };
}

export function mifflinBmr(bio: Config["bio"], kg: number, on: DayKey): number {
  const [by, bm] = bio.birth.split("-").map(Number);
  const [y, m] = on.split("-").map(Number);
  const age = y! - by! + (m! - bm!) / 12;
  return (
    MIFFLIN.weight * kg +
    MIFFLIN.height * bio.heightCm -
    MIFFLIN.age * age +
    (bio.sex === "m" ? MIFFLIN.maleOffset : MIFFLIN.femaleOffset)
  );
}

export interface Estimate {
  samples: Sample[];
  /** Smoothed weight, one point per weigh-in. */
  trendLine: Sample[];
  trendKg: number;
  trend: Trend | null;
  formulaTdee: number;
  measuredTdee: number | null;
  tdee: number;
  tdeeStdErr: number | null;
  countedDays: number;
  windowDays: number;
  kcalLower: number;
  kcalUpper: number;
  proteinTarget: number;
}

/** Null until at least one weight exists — there is no basis for a target without it. */
export function estimate(cfg: Config, days: Map<DayKey, Day>, today: DayKey): Estimate | null {
  const e = cfg.estimator;
  const samples = weightSamples(days);
  const trendLine = holtSeries(samples, e.levelHalfLifeDays, e.trendHalfLifeDays);
  const trendKg = trendLine[trendLine.length - 1]?.kg;
  if (trendKg === undefined) return null;

  const from = addDays(today, -e.tdeeWindowDays);
  const trend = regress(samples.filter((s) => s.day >= from));
  const formulaTdee = mifflinBmr(cfg.bio, trendKg, today) * e.activityFactor;

  // Partial-day detection anchors on the formula TDEE rather than the measured
  // one. Anchoring on measured would be a feedback loop: under-logging lowers
  // TDEE, which lowers the bar, which admits more under-logged days.
  const floor = e.incompleteDayKcalFraction * formulaTdee;

  // Today is excluded — a day in progress would drag the average down hard.
  const counted: number[] = [];
  for (let d = from; d < today; d = addDays(d, 1)) {
    const day = days.get(d);
    if (!day?.items.length || day.logging === "incomplete") continue;
    const kcal = dayKcal(day);
    if (day.logging !== "complete" && kcal < floor) continue;
    counted.push(kcal);
  }

  const avgIntake = counted.length
    ? counted.reduce((a, b) => a + b, 0) / counted.length
    : null;
  const measuredTdee =
    avgIntake !== null && trend
      ? avgIntake - (trend.kgPerWeek * KCAL_PER_KG_FAT) / DAYS_PER_WEEK
      : null;

  // Blend toward the measured value as logged days accumulate. Covers the cold
  // start, vacations, and any stretch of poor logging.
  const w = measuredTdee === null ? 0 : Math.min(counted.length / e.blendFullConfidenceDays, 1);
  const tdee = w * (measuredTdee ?? 0) + (1 - w) * formulaTdee;

  return {
    samples,
    trendLine,
    trendKg,
    trend,
    formulaTdee,
    measuredTdee,
    tdee,
    tdeeStdErr:
      trend && w > 0 ? (w * trend.stdErrKgPerWeek * KCAL_PER_KG_FAT) / DAYS_PER_WEEK : null,
    countedDays: counted.length,
    windowDays: e.tdeeWindowDays,
    kcalLower: tdee + cfg.goal.kcalRangeOffset.lower,
    kcalUpper: tdee + cfg.goal.kcalRangeOffset.upper,
    proteinTarget: trendKg * cfg.goal.proteinGPerKg,
  };
}
