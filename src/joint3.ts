// Joint weight/TDEE estimation: intake as a noisy input, not a second average.
//
// State is [tissue, water, TDEE]:
//
//   tissue[t] = tissue[t-1] + (intake[t-1] - TDEE[t-1]) / rho
//   water[t]  = phi * water[t-1]          (zero-mean AR(1) transient)
//   TDEE[t]   = TDEE[t-1]                 (slow random walk)
//   scale[t]  = tissue[t] + water[t]
//
// Intake carries a known variance — a per-day sd on counted days, a wide
// unlogged-day sd everywhere else — which lands on tissue as process noise.
// Noisy intake therefore widens the tissue posterior and shifts the Kalman
// gain toward the scale, with no heuristic gain-scaling needed.
//
// When intake ~= TDEE the filter predicts no change, so a scale jump lands in
// water; when intake >> TDEE it predicts a jump of a known size and tissue
// moves instead. That attribution is the Kalman gain doing its job — no
// heuristic gain-scaling needed.
//
// Everything here is a filter, never a smoother: the state on day `t` sees
// only data up to `t`. Hyperparameters are fitted by maximum likelihood on
// the intake era only (days at/after the first fully-logged intake — nothing
// before that can say anything about TDEE), by a small Nelder-Mead with
// fixed starts, so the fit is deterministic: same data, same numbers.
import { addDays, daysBetween } from "./dates.js";
import { KCAL_PER_KG_FAT, type Day, type DayKey } from "./types.js";

/** Fitted hyperparameters. Variances in (kg, kcal/day) units. */
export interface JointHyper {
  /** (kcal/day)^2 per day: how fast TDEE may drift. */
  qTdee: number;
  /** kg^2 per day: water innovation variance. */
  qWater: number;
  /** Water AR(1) persistence in (0, 1). Half-life ln(.5)/ln(phi) days. */
  phi: number;
}

/** MLE fit on real data; also the fallback when there is no intake to fit on. */
export const DEFAULT_HYPER: JointHyper = { qTdee: 732, qWater: 0.097, phi: 0.75 };

/** Pinned, not fitted: composition does not teleport. */
const Q_LEAN = 0;
/** Gap-fill clock for missing intake: recent logging carries forward. */
const EWMA_HALF_LIFE_DAYS = 12;
/** Leading era innovations dropped from the likelihood (wide-prior warm-up). */
const FIT_BURN = 5;
/** TDEE prior width, kcal/day. Wide on purpose: the cold start is honest. */
const PRIOR_TDEE_SD = 400;

/**
 * Observation variance in kg^2 for a scale with the given display step in
 * grams. The reading is the truth rounded to the step, so the error is uniform
 * over half a step either way — variance p^2/12 — and is treated as Gaussian
 * with that same variance, which is what the Kalman update wants. No drift
 * between readings is assumed: the scale is accurate, merely coarse.
 * Non-positive input reads as a perfect scale rather than failing the filter.
 */
export function scaleVarKg2(precisionG: number): number {
  if (!(precisionG > 0)) return 0;
  const stepKg = precisionG / 1000;
  return (stepKg * stepKg) / 12;
}

export interface JointState {
  tissue: number;
  water: number;
  tdee: number;
  tissueSd: number;
  waterSd: number;
  tdeeSd: number;
  /** Implied drift this day, kg/day: (drive - TDEE) / rho, else 0. */
  slope: number;
}

interface Innovation {
  t: number;
  v: number;
  f: number;
}

/** Daily calendar arrays over [start, end]: null is missing, never zero. */
export interface JointInputs {
  start: DayKey;
  weight: (number | null)[];
  /** Fully-logged intake, else null. Days >= `today` are always null: a day
   *  still in progress would drag its own target down. */
  counted: (number | null)[];
  /** Per-day intake sd in kcal, alongside `counted`: null wherever it is. */
  countedSd: (number | null)[];
}

export function inputsFor(
  days: Map<DayKey, Day>,
  end: DayKey,
  today: DayKey,
  manualPct: number,
): JointInputs | null {
  const keys = [...days.keys()].sort();
  if (!keys.length) return null;
  const start = keys[0]!;
  const n = daysBetween(start, end) + 1;
  if (n <= 0) return null;
  const frac = manualPct / 100;
  const weight: (number | null)[] = new Array(n).fill(null);
  const counted: (number | null)[] = new Array(n).fill(null);
  const countedSd: (number | null)[] = new Array(n).fill(null);
  for (const [day, d] of days) {
    if (day < start || day > end) continue;
    const i = daysBetween(start, day);
    if (d.weight_kg) weight[i] = d.weight_kg;
    if (day >= today) continue;
    if (d.logging === "complete" && d.items.length) {
      counted[i] = d.items.reduce((a, it) => a + it.kcal, 0);
      // Stored sd wins, else the manual percent rule — one rule for every item
      // without a stored sd, manual or otherwise. Item errors are taken as
      // independent, so variances add.
      countedSd[i] = Math.sqrt(
        d.items.reduce((a, it) => {
          const sd = it.kcal_sd ?? frac * it.kcal;
          return a + sd * sd;
        }, 0),
      );
    }
  }
  return { start, weight, counted, countedSd };
}

/** Calendar-time EWMA fill over counted days: w = 0.5^(age / halfLife).
 *  Missing days contribute no weight; before the first counted day even the
 *  EWMA has nothing and stays null (maintenance takes over there). */
export function ewmaFill(counted: (number | null)[], halfLifeDays: number): (number | null)[] {
  const decay = Math.pow(0.5, 1 / halfLifeDays);
  const out: (number | null)[] = new Array(counted.length).fill(null);
  let s = 0;
  let norm = 0;
  for (let t = 0; t < counted.length; t++) {
    out[t] = norm > 0 ? s / norm : null;
    const c = counted[t];
    s = (s + (c ?? 0)) * decay;
    norm = (norm + (c === null ? 0 : 1)) * decay;
  }
  return out;
}

// ------------------------------------------------------------- the filter

interface Vec3 {
  w: number;
  v: number;
  e: number;
}

export function filterJoint(
  weight: (number | null)[],
  counted: (number | null)[],
  countedSd: (number | null)[],
  e0: number,
  hyper: JointHyper,
  /** Observation variance in kg^2 — `scaleVarKg2` of the scale's step. */
  rObs: number,
  /** Intake sd in kcal for days with no complete log. */
  unloggedSd: number,
  rho: number = KCAL_PER_KG_FAT,
): { states: (JointState | null)[]; innov: Innovation[] } {
  const n = weight.length;
  const states: (JointState | null)[] = new Array(n).fill(null);
  const innov: Innovation[] = [];
  const k = 1 / rho;
  const { qTdee, qWater, phi } = hyper;
  // Drive: the day's own counted intake when logged, else the EWMA carry-over,
  // else null (maintenance takes over in the loop). The fill excludes the day
  // itself, so counted days must win explicitly — otherwise a logged 4000 kcal
  // feast would drive as yesterday's average.
  const fill = ewmaFill(counted, EWMA_HALF_LIFE_DAYS);
  const drive: (number | null)[] = counted.map((c, t) => c ?? fill[t] ?? null);
  // Drive sd needs no fill: a counted day carries its own, and every other day
  // carries the unlogged-day sd — filled or maintenance, nothing was recorded.
  const driveSd: number[] = countedSd.map((sd) => sd ?? unloggedSd);

  let start = -1;
  for (let i = 0; i < n; i++) {
    if (weight[i] !== null) {
      start = i;
      break;
    }
  }
  if (start === -1) return { states, innov };
  let firstCounted = -1;
  for (let i = 0; i < n; i++) {
    if (counted[i] !== null) {
      firstCounted = i;
      break;
    }
  }

  const sw = qWater / (1 - phi * phi);
  // State + covariance. P0 gives tissue the first reading with variance
  // 1 + Sw (the water it might contain), water its stationary prior, and
  // the -Sw off-diagonal keeps the split self-consistent.
  let x: Vec3 = { w: weight[start]!, v: 0, e: e0 };
  let p00 = 1 + sw;
  let p01 = -sw;
  let p02 = 0;
  let p11 = sw;
  let p12 = 0;
  let p22 = PRIOR_TDEE_SD * PRIOR_TDEE_SD;

  const driveAt = (t: number): number | null => (t >= 0 && t < n ? (drive[t] ?? null) : null);
  const driveSdAt = (t: number): number => (t >= 0 && t < n ? driveSd[t]! : unloggedSd);

  const store = (t: number) => {
    const uu = driveAt(t);
    states[t] = {
      tissue: x.w,
      water: x.v,
      tdee: x.e,
      tissueSd: Math.sqrt(Math.max(p00, 0)),
      waterSd: Math.sqrt(Math.max(p11, 0)),
      tdeeSd: Math.sqrt(Math.max(p22, 0)),
      slope: uu === null ? 0 : (uu - x.e) * k,
    };
  };
  store(start);

  for (let t = start + 1; t < n; t++) {
    if (t === firstCounted) {
      // Pre-intake TDEE is unobservable — under the maintenance substitution
      // a cut reads as maintenance and pushes E the wrong way while shrinking
      // its variance. Re-seed wide rather than carry that in.
      x.e = e0;
      p02 = 0;
      p12 = 0;
      p22 = PRIOR_TDEE_SD * PRIOR_TDEE_SD;
    }
    const uu = driveAt(t - 1) ?? x.e; // maintenance: drive -> 0
    const du = driveSdAt(t - 1);
    // Predict: w += (u - e) * k; v *= phi; e coasts.
    x = { w: x.w + (uu - x.e) * k, v: phi * x.v, e: x.e };
    // P = F P F' + Q with F = [[1,0,-k],[0,phi,0],[0,0,1]], Q = diag(0, qW, qE).
    // Only the upper triangle is stored; symmetry is exact from a symmetric
    // start, so no symmetrisation pass is needed. Intake noise is exogenous —
    // independent of the state — so it lands on tissue alone, as k^2 Var(u).
    const a02 = p02 - k * p22;
    p00 = p00 - 2 * k * p02 + k * k * p22 + Q_LEAN + k * k * du * du;
    p01 = phi * (p01 - k * p12);
    p02 = a02;
    p11 = phi * phi * p11 + qWater;
    p12 = phi * p12;
    p22 = p22 + qTdee;
    const yt = weight[t] ?? null;
    if (yt !== null) {
      // H = [1, 1, 0]: f = P00 + P01 + P10 + P11 + r.
      const f = p00 + 2 * p01 + p11 + rObs;
      const vv = yt - (x.w + x.v);
      const g0 = (p00 + p01) / f;
      const g1 = (p01 + p11) / f;
      const g2 = (p02 + p12) / f;
      x = { w: x.w + g0 * vv, v: x.v + g1 * vv, e: x.e + g2 * vv };
      // P -= outer(g, H P); H P = row0 + row1.
      const h0 = p00 + p01;
      const h1 = p01 + p11;
      const h2 = p02 + p12;
      p00 -= g0 * h0;
      p01 -= g0 * h1;
      p02 -= g0 * h2;
      p11 -= g1 * h1;
      p12 -= g1 * h2;
      p22 -= g2 * h2;
      innov.push({ t, v: vv, f });
    }
    store(t);
  }
  return { states, innov };
}

// ------------------------------------------------------------------ fit

/** Gaussian prediction-error log-likelihood over the intake era only. */
export function eraLoglik(
  weight: (number | null)[],
  counted: (number | null)[],
  countedSd: (number | null)[],
  e0: number,
  hyper: JointHyper,
  rObs: number,
  unloggedSd: number,
  rho: number = KCAL_PER_KG_FAT,
): number {
  let era0 = -1;
  for (let i = 0; i < counted.length; i++) {
    if (counted[i] !== null) {
      era0 = i;
      break;
    }
  }
  if (era0 === -1) return -Infinity;
  const { innov } = filterJoint(weight, counted, countedSd, e0, hyper, rObs, unloggedSd, rho);
  const use = innov.filter((r) => r.t >= era0 + FIT_BURN);
  if (use.length < 3) return -Infinity;
  let ll = 0;
  for (const r of use) {
    if (!(r.f > 0)) return -Infinity;
    ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(r.f) + (r.v * r.v) / r.f);
  }
  return ll;
}

function nelderMead(fn: (x: number[]) => number, start: number[]): { x: number[]; fx: number } {
  const n = start.length;
  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;
  const step = 0.5;
  const simplex: number[][] = [start.slice()];
  for (let i = 0; i < n; i++) {
    const p = start.slice();
    p[i]! += step;
    simplex.push(p);
  }
  const val = simplex.map((p) => fn(p));
  const centroid = (pts: number[][]): number[] => {
    const c = new Array(n).fill(0);
    for (const p of pts) for (let i = 0; i < n; i++) c[i]! += p[i]!;
    return c.map((s) => s / pts.length);
  };
  for (let iter = 0; iter < 2000; iter++) {
    const order = simplex.map((_, i) => i).sort((a, b) => val[a]! - val[b]!);
    const best = simplex[order[0]!]!;
    const worst = simplex[order[n]!]!;
    const rest = order.slice(0, n).map((i) => simplex[i]!);
    const c = centroid(rest);
    const xr = c.map((ci, i) => ci + alpha * (ci - worst[i]!));
    const fr = fn(xr);
    if (fr < val[order[0]!]!) {
      const xe = c.map((ci, i) => ci + gamma * (xr[i]! - ci));
      const fe = fn(xe);
      simplex[order[n]!] = fe < fr ? xe : xr;
      val[order[n]!] = fe < fr ? fe : fr;
    } else if (fr < val[order[n - 1]!]!) {
      simplex[order[n]!] = xr;
      val[order[n]!] = fr;
    } else {
      const xc = c.map((ci, i) => ci + rho * (worst[i]! - ci));
      const fc = fn(xc);
      if (fc < val[order[n]!]!) {
        simplex[order[n]!] = xc;
        val[order[n]!] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          const idx = order[i]!;
          simplex[idx] = simplex[idx]!.map((v, j) => best[j]! + sigma * (v - best[j]!));
          val[idx] = fn(simplex[idx]!);
        }
      }
    }
    // Stop when the simplex is flat in value.
    let spread = 0;
    for (const v of val) spread = Math.max(spread, Math.abs(v - val[order[0]!]!));
    if (spread < 1e-9) break;
  }
  const bi = val.indexOf(Math.min(...val));
  return { x: simplex[bi]!, fx: val[bi]! };
}

const unpack = (theta: number[]): JointHyper => ({
  qTdee: Math.exp(theta[0]!),
  qWater: Math.exp(theta[1]!),
  phi: 1 / (1 + Math.exp(-theta[2]!)),
});

export interface JointFit {
  hyper: JointHyper;
  loglik: number;
  /** Scale readings at/after the first counted day. */
  nEra: number;
}

/** Fit (qTdee, qWater, phi) on the intake era: maximum likelihood plus a weak
 *  MAP prior toward DEFAULT_HYPER (see `neg`). Deterministic: fixed starts,
 *  no randomness — the same history always fits the same numbers, which is
 *  what lets per-day replays agree with the headline estimate. */
export function fitJoint(
  weight: (number | null)[],
  counted: (number | null)[],
  countedSd: (number | null)[],
  e0: number,
  rObs: number,
  unloggedSd: number,
  rho: number = KCAL_PER_KG_FAT,
): JointFit {
  let era0 = -1;
  for (let i = 0; i < counted.length; i++) {
    if (counted[i] !== null) {
      era0 = i;
      break;
    }
  }
  let nEra = 0;
  if (era0 !== -1) {
    for (let i = era0; i < weight.length; i++) if (weight[i] !== null) nEra++;
  }
  if (era0 === -1 || nEra < 8) {
    return { hyper: { ...DEFAULT_HYPER }, loglik: -Infinity, nEra };
  }
  // Weak MAP prior toward DEFAULT_HYPER, 1 nat sd per component: with a
  // handful of era readings the likelihood is ridge-flat and the optimiser
  // wanders to frozen-TDEE boundaries (qTdee -> 0 parks TDEE at an
  // overcorrected level — the early-August rows read ~1650 that way); with a
  // full era the penalty costs ~nothing. Prior is constant, so every replay
  // row stays causal.
  const t0 = [
    Math.log(DEFAULT_HYPER.qTdee),
    Math.log(DEFAULT_HYPER.qWater),
    Math.log(DEFAULT_HYPER.phi / (1 - DEFAULT_HYPER.phi)),
  ];
  const neg = (theta: number[]): number => {
    const ll = eraLoglik(weight, counted, countedSd, e0, unpack(theta), rObs, unloggedSd, rho);
    if (!Number.isFinite(ll)) return 1e12;
    const pen =
      (theta[0]! - t0[0]!) ** 2 + (theta[1]! - t0[1]!) ** 2 + (theta[2]! - t0[2]!) ** 2;
    return -ll + pen / 2;
  };
  const seed: [number, number, number] = [-0.5, -3.0, 0.0];
  const starts: number[][] = [
    [...seed],
    [seed[0] + 2, seed[1], seed[2]],
    [seed[0] - 2, seed[1], seed[2]],
    [seed[0], seed[1] - 1, seed[2] + 0.5],
    [seed[0], seed[1] + 1, seed[2] + 1.5],
  ];
  let best = { x: starts[0]!, fx: Infinity };
  for (const s of starts) {
    const r = nelderMead(neg, s);
    if (r.fx < best.fx) best = r;
  }
  const hyper = unpack(best.x);
  // Pure era log-likelihood, without the MAP penalty, so it stays comparable
  // across fits.
  return { hyper, loglik: eraLoglik(weight, counted, countedSd, e0, hyper, rObs, unloggedSd, rho), nEra };
}
