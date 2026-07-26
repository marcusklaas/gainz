// Universal constants only. Anything personal or tunable lives in config.json
// in the private data repo. See PLAN.md "Constants policy".

/** Approximation. Fine because TDEE is continuously re-derived from fresh data. */
export const KCAL_PER_KG_FAT = 7700;
export const DAYS_PER_WEEK = 7;

/** Mifflin-St Jeor published coefficients. */
export const MIFFLIN = { weight: 10, height: 6.25, age: 5, maleOffset: 5, femaleOffset: -161 };

/** Local calendar date, "YYYY-MM-DD". Never a UTC timestamp. */
export type DayKey = string;
/** "YYYY-MM" */
export type MonthKey = string;

/** "llm" means the numbers came from an estimate, whether or not they were then
 *  edited by hand. */
export type FoodSource = "llm" | "manual";

export interface FoodItem {
  id: string;
  /** "19:40", local. */
  at: string;
  /** The description as typed. Doubles as the text the estimate was made from. */
  name: string;
  kcal: number;
  protein_g: number;
  source: FoodSource;
  /** Which model produced the estimate. */
  model?: string;
  /** Written by an earlier version that logged several items per description. */
  grams?: number;
  sourceText?: string;
}

export interface Day {
  weight_kg?: number;
  /**
   * The calorie target the app actually displayed on this day, written once and
   * never revised. The bias accumulator measures how far intake landed from what
   * the user was told, so it has to read the number they saw — not one re-derived
   * later from more data. Absent on days that predate the feature, or that were
   * logged without opening the app that day.
   */
  goal_kcal?: number;
  items: FoodItem[];
  /** Override for the auto-classifier. Absent means "decide automatically". */
  logging?: "complete" | "incomplete";
}

export interface MonthFile {
  version: 1;
  days: Record<DayKey, Day>;
}

export type GoalKind = "cut" | "maintain" | "bulk";

export interface Goal {
  kind: GoalKind;
  startedOn: DayKey;
  /** Added to TDEE to give the daily calorie band. */
  kcalRangeOffset: { lower: number; upper: number };
  proteinGPerKg: number;
  endCondition:
    | { type: "review"; on: DayKey }
    | { type: "weight"; weightKg: number };
}

export interface Config {
  version: 1;
  bio: {
    heightCm: number;
    /** "YYYY-MM", month precision so age is exact year-round. */
    birth: string;
    sex: "m" | "f";
  };
  goal: Goal;
  estimator: {
    /** Holt level half-life: how fast the smoothed weight follows the scale. */
    levelHalfLifeDays: number;
    /** Holt trend half-life: how fast the estimated slope adapts. Longer is calmer. */
    trendHalfLifeDays: number;
    /** How far back to load. Warms up the smoother and sets the chart span. */
    historyDays: number;
    tdeeWindowDays: number;
    blendFullConfidenceDays: number;
    /** Days below this fraction of TDEE are treated as partially logged. */
    incompleteDayKcalFraction: number;
    activityFactor: number;
  };
  llm: { provider: Provider; model: string };
}

export type Provider = "anthropic" | "openai";

export function emptyDay(): Day {
  return { items: [] };
}

export function emptyMonth(): MonthFile {
  return { version: 1, days: {} };
}
