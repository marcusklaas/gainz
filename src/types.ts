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

export type FoodSource = "llm" | "manual" | "favorite";

export interface FoodItem {
  id: string;
  /** "19:40", local. */
  at: string;
  name: string;
  grams?: number;
  kcal: number;
  protein_g: number;
  /** Raw free text this was parsed from. Kept so history can be re-estimated. */
  sourceText?: string;
  source: FoodSource;
  /** Which model produced the estimate. */
  model?: string;
}

export interface Day {
  weight_kg?: number;
  items: FoodItem[];
  /** Override for the auto-classifier. Absent means "decide automatically". */
  logging?: "complete" | "incomplete";
}

export interface MonthFile {
  version: 1;
  days: Record<DayKey, Day>;
}

/** A recurring food, fed to the model as context so repeats stay consistent. */
export interface Favorite {
  name: string;
  grams: number | null;
  kcal: number;
  protein_g: number;
}

export interface FavoritesFile {
  version: 1;
  items: Favorite[];
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

export function emptyFavorites(): FavoritesFile {
  return { version: 1, items: [] };
}
