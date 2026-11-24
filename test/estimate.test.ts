// The weight/intake estimator. Pure functions over raw data: nothing here touches
// storage or the DOM, and nothing derived is ever persisted. Improving an
// estimator therefore improves the whole history retroactively.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultConfig, withDefaults } from "../src/core/config.js";
import { addDays } from "../src/core/dates.js";
import {
  calorieSeries,
  correctedTarget,
  dayKcal,
  dayProtein,
  displayBand,
  estimate,
  mifflinBmr,
  projection,
  weekSummary,
  weightSamples,
  type TrendPoint,
} from "../src/core/estimate.js";
import { DAYS_PER_WEEK, KCAL_PER_KG_FAT, type Config, type Day, type DayKey } from "../src/core/types.js";

// --------------------------------------------------------------- fixtures

const close = (actual: number, expected: number, eps = 1e-9, what = "") =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${what || "value"}: expected ${expected} ± ${eps}, got ${actual}`,
  );

let nextId = 0;
const food = (kcal: number, protein_g = 0) => ({
  id: `i${nextId++}`,
  at: "2026-07-25T12:00:00.000Z",
  name: "food",
  kcal,
  protein_g,
});

/** A day the user confirmed is fully logged, holding `kcal` in one item. */
const logged = (kcal: number, goal?: number, protein = 0): Day => ({
  items: [food(kcal, protein)],
  logging: "complete",
  ...(goal === undefined ? {} : { goal_kcal: goal }),
});

const DAY0 = "2026-01-01";
const on = (n: number): DayKey => addDays(DAY0, n);

/** `n` consecutive days from DAY0, built by index. */
const history = (n: number, each: (i: number) => Day | null): Map<DayKey, Day> => {
  const days = new Map<DayKey, Day>();
  for (let i = 0; i < n; i++) {
    const d = each(i);
    if (d) days.set(on(i), d);
  }
  return days;
};

const config = (over: Partial<Config["estimator"]> = {}, goal: Partial<Config["goal"]> = {}) => {
  const cfg = defaultConfig();
  return { ...cfg, estimator: { ...cfg.estimator, ...over }, goal: { ...cfg.goal, ...goal } };
};

// ------------------------------------------------------------ day totals

describe("dayKcal / dayProtein", () => {
  it("sum the items", () => {
    const d: Day = { items: [food(500, 30), food(250, 12), food(0, 8)] };
    assert.equal(dayKcal(d), 750);
    assert.equal(dayProtein(d), 50);
  });

  it("are zero on an empty day", () => {
    assert.equal(dayKcal({ items: [] }), 0);
    assert.equal(dayProtein({ items: [] }), 0);
  });
});

// ------------------------------------------------------------- samples

describe("weightSamples", () => {
  it("keeps only weighed days, oldest first", () => {
    const days = new Map<DayKey, Day>([
      ["2026-01-03", { items: [], weight_kg: 82 }],
      ["2026-01-01", { items: [], weight_kg: 80 }],
      ["2026-01-02", { items: [] }],
    ]);
    assert.deepEqual(weightSamples(days), [
      { day: "2026-01-01", kg: 80 },
      { day: "2026-01-03", kg: 82 },
    ]);
  });

  it("is empty when nothing was weighed", () => {
    assert.deepEqual(weightSamples(new Map([["2026-01-01", { items: [] }]])), []);
  });
});

// ---------------------------------------------------------------- projection

describe("projection", () => {
  const point = (dayOffset: number, kg: number, slope: number): TrendPoint => ({
    day: on(dayOffset),
    kg,
    slope,
  });

  it("is empty when there is nothing to project from, or nowhere to project to", () => {
    assert.deepEqual(projection([], 7), []);
    assert.deepEqual(projection([point(0, 80, 0.1)], 0), []);
    assert.deepEqual(projection([point(0, 80, 0.1)], -3), []);
  });

  it("starts on the last trend point, so the two lines meet", () => {
    // Not one day after it. The caller draws this as its own series, and a gap
    // here shows up as a dashed line floating beside the solid one.
    const t = [point(0, 80, 0), point(3, 81.1, 0.08)];
    const last = t.at(-1)!;
    const p = projection(t, 7);
    assert.equal(p.length, 8, "the shared point, plus one per projected day");
    assert.equal(p[0]!.day, last.day);
    close(p[0]!.kg, last.kg, 1e-12);
  });

  it("carries the reported rate exactly", () => {
    // The whole point of drawing it: the gradient of this line is the number in
    // the headline. If the two ever disagree the chart contradicts the app.
    const t = [point(0, 80, -0.01), point(10, 79.7, -0.03)];
    const p = projection(t, 14);
    close((p.at(-1)!.kg - p[0]!.kg) / 14, t.at(-1)!.slope, 1e-12);
  });

  it("is straight, one point per day", () => {
    const p = projection([point(4, 82.2, 0.06)], 10);
    for (let i = 1; i < p.length; i++) {
      assert.equal(p[i]!.day, addDays(p[0]!.day, i), "no gaps");
      close(p[i]!.kg - p[i - 1]!.kg, p[1]!.kg - p[0]!.kg, 1e-12);
    }
  });

  it("stays flat when the trend has no slope to carry", () => {
    for (const s of projection([point(0, 80, 0)], 7)) close(s.kg, 80, 1e-12);
  });
});

// ---------------------------------------------------------------- BMR

describe("mifflinBmr", () => {
  const bio = { heightCm: 192, birth: "1991-03-15", sex: "m" } as const;

  it("matches the published Mifflin-St Jeor formula", () => {
    // 10·80 + 6.25·192 − 5·35.0014 + 5, with age in tropical years.
    close(mifflinBmr(bio, 80, "2026-03-15"), 1829.993, 1e-3);
  });

  it("puts the sexes exactly 166 kcal apart", () => {
    const male = mifflinBmr(bio, 80, "2026-03-15");
    const female = mifflinBmr({ ...bio, sex: "f" }, 80, "2026-03-15");
    close(male - female, 166, 1e-9);
  });

  it("is linear in weight at 10 kcal per kg", () => {
    close(mifflinBmr(bio, 81, "2026-03-15") - mifflinBmr(bio, 80, "2026-03-15"), 10, 1e-9);
  });

  it("falls by 5 kcal per year of age", () => {
    const now = mifflinBmr(bio, 80, "2026-03-15");
    const later = mifflinBmr(bio, 80, "2036-03-15");
    close(now - later, 50, 0.01);
  });

  it("reads both dates as plain calendar dates, timezone-free", () => {
    // Same day either side of a DST boundary: nothing here may depend on the
    // runner's zone.
    const winter = mifflinBmr(bio, 80, "2026-01-15");
    const summer = mifflinBmr(bio, 80, "2026-07-15");
    close(winter - summer, (5 * 181) / 365.2425, 1e-6);
  });
});

// ------------------------------------------------------- week summary

describe("weekSummary", () => {
  const today = on(10);

  it("is all zeroes and no intake on an empty history", () => {
    assert.deepEqual(weekSummary(new Map(), today, 150), {
      logged: 0,
      weighed: 0,
      intake: null,
      proteinHit: 0,
      sessions: 0,
      sets: 0,
    });
  });

  it("looks at today and the six days before it, and no further", () => {
    // Weighed every day for eleven days; only seven of them are in the window.
    const days = history(11, () => ({ items: [], weight_kg: 80 }));
    assert.equal(weekSummary(days, today, null).weighed, 7);
  });

  it("counts today once it has been ticked", () => {
    const days = new Map<DayKey, Day>([[today, logged(2000, 2000)]]);
    assert.equal(weekSummary(days, today, null).logged, 1);
  });

  it("counts a day as logged only when confirmed complete and non-empty", () => {
    const days = new Map<DayKey, Day>([
      [on(10), logged(2000)],
      [on(9), { items: [food(2000)] }], // never confirmed
      [on(8), { items: [], logging: "complete" }], // confirmed but empty
      [on(7), logged(1800)],
    ]);
    assert.equal(weekSummary(days, today, null).logged, 2);
  });

  it("averages intake and goal over the same days — those carrying both", () => {
    const days = new Map<DayKey, Day>([
      [on(10), logged(2200, 2000)],
      [on(9), logged(1800, 2000)],
      [on(8), logged(9999)], // counted as logged, but no target to compare to
    ]);
    const w = weekSummary(days, today, null);
    assert.equal(w.logged, 3);
    assert.deepEqual(w.intake, { kcal: 2000, goal: 2000, days: 2 });
  });

  it("has no intake figure when no day in the window carries a target", () => {
    const days = new Map<DayKey, Day>([[on(10), logged(2200)]]);
    assert.equal(weekSummary(days, today, null).intake, null);
  });

  it("judges protein on every day in the window, logged or not", () => {
    // The documented asymmetry: an unconfirmed day looks low on intake merely
    // because it is unfinished, but it can clear a protein target perfectly
    // well. So protein is counted out of seven, not out of `logged`.
    const days = new Map<DayKey, Day>([
      [on(10), { items: [food(2000, 160)] }], // not confirmed, clears
      [on(9), logged(2000, 2000, 150)], // confirmed, clears exactly
      [on(8), logged(2000, 2000, 149)], // confirmed, misses
    ]);
    const w = weekSummary(days, today, 150);
    assert.equal(w.logged, 2);
    assert.equal(w.proteinHit, 2);
  });

  it("counts no protein days when there is no target", () => {
    const days = history(7, () => ({ items: [food(2000, 300)] }));
    assert.equal(weekSummary(days, today, null).proteinHit, 0);
  });

  it("counts sessions and their sets across the window", () => {
    const sets = [{ weight_kg: 100, reps: 5 }];
    const session = (id: string, exercises: number) => ({
      id,
      at: "2026-01-01T18:00:00.000Z",
      exercises: Array.from({ length: exercises }, (_, i) => ({ name: `e${i}`, sets })),
    });
    const days = new Map<DayKey, Day>([
      [on(10), { items: [], sessions: [session("a", 3), session("b", 1)] }],
      [on(9), { items: [], sessions: [session("c", 2)] }],
      [on(1), { items: [], sessions: [session("d", 5)] }], // outside the window
    ]);
    const w = weekSummary(days, today, null);
    assert.equal(w.sessions, 3);
    assert.equal(w.sets, 6);
  });
});

// ----------------------------------------------------------- estimate

describe("estimate", () => {
  const today = on(60);

  it("is null until something has been weighed", () => {
    assert.equal(estimate(config(), new Map(), today), null);
    assert.equal(estimate(config(), new Map([[on(1), logged(2000)]]), today), null);
  });

  it("defaults the scale step to 100 g and trusts a spike less when coarser", () => {
    assert.equal(defaultConfig().estimator.scalePrecisionG, 100);
    // Spike on the last day, full pipeline (fit, then filter) in both runs:
    // the coarse run's trend must sit closer to the flat history.
    const spiked = (over: Partial<Config["estimator"]>) => {
      const cfg = config(over);
      const days = history(60, (i) => ({ ...logged(2600, 2600), weight_kg: i === 59 ? 81 : 80 }));
      return estimate(cfg, days, today)!.trendKg;
    };
    const fine = spiked({ scalePrecisionG: 10 });
    const coarse = spiked({ scalePrecisionG: 2000 });
    assert.ok(fine > 80 && coarse > 80, "a spike must move the trend up");
    assert.ok(coarse < fine, `coarse ${coarse} should sit below fine ${fine}`);
  });

  it("defaults intake uncertainty wide on unlogged days, 15% on manual food", () => {
    const e = defaultConfig().estimator;
    assert.equal(e.manualFoodKcalSdPct, 15);
    assert.equal(e.unloggedDayKcalSd, 750);
  });

  it("drops the retired estimator settings even when a stored config carries them", () => {
    const stored = withDefaults({
      estimator: { levelHalfLifeDays: 10, trendHalfLifeDays: 28, blendFullConfidenceDays: 14, tdeeWindowDays: 21 },
    });
    for (const key of ["levelHalfLifeDays", "trendHalfLifeDays", "blendFullConfidenceDays", "tdeeWindowDays"]) {
      assert.ok(!(key in stored.estimator), `${key} should not survive withDefaults`);
      assert.ok(!(key in defaultConfig().estimator), `${key} should not be a default`);
    }
  });

  it("trusts the scale more when manual food is noisier", () => {
    // The mirror of the scale test: noisy intake widens the tissue posterior,
    // so the Kalman gain leans on the scale instead and a last-day spike pulls
    // the trend up further. Full pipeline (fit, then filter) in both runs.
    const spiked = (over: Partial<Config["estimator"]>) => {
      const cfg = config(over);
      const days = history(60, (i) => ({ ...logged(2600, 2600), weight_kg: i === 59 ? 81 : 80 }));
      return estimate(cfg, days, today)!.trendKg;
    };
    const sure = spiked({ manualFoodKcalSdPct: 5 });
    const unsure = spiked({ manualFoodKcalSdPct: 60 });
    assert.ok(sure > 80 && unsure > 80, "a spike must move the trend up");
    assert.ok(unsure > sure, `unsure ${unsure} should sit above sure ${sure}`);
  });

  it("reads stored item sds over the manual percent rule", () => {
    // Same totals, same spike: days carrying tight stored sds trust intake and
    // barely answer the scale, while the percent rule answers it more.
    const day = (sd: number | undefined): Day => ({
      items: [{ ...food(2600), ...(sd === undefined ? {} : { kcal_sd: sd }) }],
      logging: "complete",
      goal_kcal: 2600,
    });
    const run = (sd: number | undefined) => {
      const cfg = config({ manualFoodKcalSdPct: 60 });
      const days = history(60, (i) => {
        const d = day(sd);
        return { ...d, weight_kg: i === 59 ? 81 : 80 };
      });
      return estimate(cfg, days, today)!.trendKg;
    };
    const stored = run(30);
    const rule = run(undefined);
    assert.ok(stored > 80 && rule > 80, "a spike must move the trend up");
    assert.ok(stored < rule, `stored-sd ${stored} should sit below rule ${rule}`);
  });

  it("falls back to the formula alone when nothing is logged", () => {
    const cfg = config();
    const days = new Map<DayKey, Day>([[on(59), { items: [], weight_kg: 80 }]]);
    const e = estimate(cfg, days, today)!;

    close(e.tdee, mifflinBmr(cfg.bio, 80, today) * cfg.estimator.activityFactor, 1e-9);
    assert.equal(e.countedDays, 0);
    assert.equal(e.kgPerWeek, null);
    assert.equal(e.bias.days, 0);
    close(e.bias.kcal, 0, 1e-9);
    close(e.targetKcal, e.goalKcal, 1e-9);
  });

  it("converges on measured intake once enough days are logged", () => {
    // Weight dead flat and 2600 kcal eaten every day: whatever the formula says,
    // the measurement says TDEE is 2600. The joint filter approaches it
    // asymptotically, so the tolerance below is convergence, not arithmetic —
    // and intake now carries ±15% a day, so sixty days no longer pin it to the
    // millikcal the way exact intake did. All intake counts — there is no
    // window — hence countedDays is the whole log.
    const cfg = config({ biasGain: 0 });
    const days = history(60, (i) => ({ ...logged(2600, 2600), weight_kg: 80 }));
    const e = estimate(cfg, days, today)!;

    assert.equal(e.countedDays, 60);
    close(e.kgPerWeek!, 0, 5e-4);
    close(e.tdee, 2600, 0.5);
    close(e.goalKcal, e.tdee + cfg.goal.kcalOffset, 1e-9);

    // Converging, not merely close: twice the days lands closer. This is the
    // property the tolerances above only approximate.
    const long = history(120, () => ({ ...logged(2600, 2600), weight_kg: 80 }));
    const e2 = estimate(cfg, long, on(120))!;
    assert.ok(Math.abs(e2.tdee - 2600) < Math.abs(e.tdee - 2600), "tdee should converge");
    assert.ok(Math.abs(e2.kgPerWeek!) < Math.abs(e.kgPerWeek!), "rate should converge");
  });

  it("charges weight change against intake at the fat-equivalent rate", () => {
    // Losing 0.5 kg/week on 2000 kcal/day means burning 2000 + 7700·0.5/7.
    //
    // A smoother approaches a steady rate rather than landing on it, so the
    // tolerances here are the honest residual after sixty days — about 2% of
    // the rate, and the ~10 kcal of TDEE that implies. Demanding more would be
    // asserting that an exponential has finished.
    const cfg = config({ biasGain: 0 });
    const days = history(60, (i) => ({ ...logged(2000, 2000), weight_kg: 90 - (0.5 / 7) * i }));
    const e = estimate(cfg, days, today)!;

    close(e.kgPerWeek!, -0.5, 0.5 * 0.02, "trend");
    close(e.tdee, 2000 + (0.5 * KCAL_PER_KG_FAT) / DAYS_PER_WEEK, 12, "tdee");
  });

  it("leans from the formula toward the measurement while logging is sparse", () => {
    // The old pipeline blended by counted-days-over-horizon; the joint filter
    // carries the same idea as a wide prior that the data overwhelms. Seven
    // logged days at 2600 should sit far nearer the measurement than the
    // formula it started from.
    const cfg = config({ biasGain: 0 });
    const days = history(60, (i) => {
      const weighed = { items: [], weight_kg: 80 } as Day;
      return i >= 52 && i < 59 ? { ...logged(2600, 2600), weight_kg: 80 } : weighed;
    });
    const e = estimate(cfg, days, today)!;
    const formula = mifflinBmr(cfg.bio, e.trendKg, today) * cfg.estimator.activityFactor;

    assert.equal(e.countedDays, 7);
    assert.ok(Math.abs(e.tdee - 2600) < Math.abs(formula - 2600), `tdee ${e.tdee} should beat formula ${formula} toward 2600`);
  });

  it("never lets today's food move today's own target", () => {
    // Today is excluded from the intake fit even when ticked, so the bias
    // accumulator cannot be fed by the meal you are about to log against it —
    // and the filter inputs are bit-identical, so the number cannot move.
    const cfg = config();
    const base = history(60, () => ({ ...logged(2600, 2600), weight_kg: 80 }));
    const withToday = new Map(base).set(today, { ...logged(9000, 2600) });

    const a = estimate(cfg, base, today)!;
    const b = estimate(cfg, withToday, today)!;
    close(b.targetKcal, a.targetKcal, 1e-9);
    close(b.tdee, a.tdee, 1e-9);
    assert.equal(b.countedDays, a.countedDays);
  });

  it("does let today's weigh-in move the trend", () => {
    // The morning weigh-in is finished data, unlike the day's food: it enters
    // the filter, so the trend answers it. On a dead-flat history the move is
    // tiny but nonzero — a smoother that ignored a real reading would be broken.
    const cfg = config();
    const base = history(60, () => ({ ...logged(2600, 2600), weight_kg: 80 }));
    const withWeighIn = new Map(base).set(today, {
      ...logged(9000, 2600),
      weight_kg: 80,
    });

    const a = estimate(cfg, base, today)!;
    const b = estimate(cfg, withWeighIn, today)!;
    assert.ok(b.tdee !== a.tdee, "a fresh weigh-in must move the filter");
    // Still a whisper in kcal terms — but a louder one than under exact
    // intake, because noisy intake widens the posterior the gain works from.
    assert.ok(Math.abs(b.tdee - a.tdee) < 0.05, "on flat data the move is a whisper");
    assert.equal(b.countedDays, a.countedDays);
  });

  describe("the calorie band", () => {
    it("keeps its width whatever the correction does", () => {
      const cfg = config({}, { kcalWindow: 400 });
      for (const overshoot of [0, 300, -300, 5000]) {
        const days = history(60, () => ({ ...logged(2600 + overshoot, 2600), weight_kg: 80 }));
        const e = estimate(cfg, days, today)!;
        close(e.kcalUpper - e.kcalLower, 400, 1e-9, `width at ${overshoot}`);
        close(e.targetKcal, (e.kcalLower + e.kcalUpper) / 2, 1e-9, `centre at ${overshoot}`);
      }
    });

    it("is centred on the plain goal when the gain is zero", () => {
      const cfg = config({ biasGain: 0 });
      const days = history(60, () => ({ ...logged(3500, 2600), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      assert.ok(e.bias.kcal > 0, "the bias is still accumulated, just not applied");
      close(e.targetKcal, e.goalKcal, 1e-9);
    });
  });

  describe("displayBand", () => {
    it("ignores a moved offset once the day has a stored goal", () => {
      // Sixty days pinned at 2600. Moving the offset moves the live candidate
      // for the *next* pin, but the band shown for the stored day must not move.
      const days = history(60, () => ({ ...logged(2600, 2600), weight_kg: 80 }));
      const before = estimate(config({ biasGain: 0 }, { kcalOffset: 0 }), days, today)!;
      const after = estimate(config({ biasGain: 0 }, { kcalOffset: 500 }), days, today)!;
      assert.ok(Math.abs(after.goalKcal - before.goalKcal) > 100, "premise: the offset moves the live goal");

      const a = displayBand(config(), before, 2600)!;
      const b = displayBand(config(), after, 2600)!;
      close(a.targetKcal, 2600, 1e-9);
      close(b.targetKcal, 2600, 1e-9);
      close(b.kcalLower, 2600 - 200, 1e-9);
      close(b.kcalUpper, 2600 + 200, 1e-9);
    });

    it("keeps the bias correction on the stored goal", () => {
      // Persistent overeating against a stored 2600: the displayed centre sits
      // below the stored goal by exactly gain times the bias.
      const cfg = config();
      const days = history(60, () => ({ ...logged(3000, 2600), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      assert.ok(e.bias.kcal > 0, "premise: overeating builds a positive bias");

      const band = displayBand(cfg, e, 2600)!;
      close(
        band.targetKcal,
        correctedTarget(2600, e.bias.kcal, e.bmr, cfg.estimator.biasGain),
        1e-9,
      );
      assert.ok(band.targetKcal < 2600, "the correction must still push down");
      close(band.kcalUpper - band.kcalLower, cfg.goal.kcalWindow, 1e-9);
    });

    it("shows nothing for a past day with no stored goal", () => {
      // History from before goals were pinned: no fabrication from the live
      // offset, just null for the caller to dash.
      const cfg = config({}, { kcalOffset: 500 });
      const days = history(60, () => ({ ...logged(2600, 2600), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      assert.equal(displayBand(cfg, e, undefined), null);
    });

    it("previews the live band for a day not yet pinnable", () => {
      const cfg = config();
      const days = history(60, () => ({ ...logged(2600, 2600), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      const band = displayBand(cfg, e, undefined, true)!;
      close(band.targetKcal, e.targetKcal, 1e-9);
      close(band.kcalLower, e.kcalLower, 1e-9);
      close(band.kcalUpper, e.kcalUpper, 1e-9);
    });
  });

  describe("the bias accumulator", () => {
    it("pushes the target down after persistent overeating", () => {
      const cfg = config();
      const days = history(60, () => ({ ...logged(3000, 2600), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      assert.ok(e.bias.kcal > 0, `expected a positive bias, got ${e.bias.kcal}`);
      assert.ok(e.targetKcal < e.goalKcal, "a target above goal would reward overeating");
    });

    it("pushes it up after persistent undereating", () => {
      const cfg = config();
      const days = history(60, () => ({ ...logged(2200, 2600), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      assert.ok(e.bias.kcal < 0);
      assert.ok(e.targetKcal > e.goalKcal);
    });

    it("stays put when intake lands on target", () => {
      const cfg = config();
      const days = history(60, () => ({ ...logged(2600, 2600), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      close(e.bias.kcal, 0, 1e-9);
      close(e.targetKcal, e.goalKcal, 1e-9);
    });

    it("skips days with no recorded target rather than treating them as zero", () => {
      // A gap in logging says nothing about where this person lands relative to
      // a target they were never shown, so it must move E neither way.
      const cfg = config();
      const withGaps = history(60, (i) =>
        i % 3 === 0 ? { ...logged(2600), weight_kg: 80 } : { ...logged(2600, 2600), weight_kg: 80 },
      );
      const e = estimate(cfg, withGaps, today)!;
      close(e.bias.kcal, 0, 1e-9);
      assert.equal(e.bias.days, 40, "only days carrying a target are counted");
    });

    it("caps at biasMaxKcal however long the overshoot runs", () => {
      const cfg = config({ biasMaxKcal: 900 });
      const days = history(60, () => ({ ...logged(6000, 2000), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      close(e.bias.kcal, 900, 1e-9);
    });

    it("moves the band as far as gain and cap allow, past its own width", () => {
      // The band width no longer bounds the correction: with a big enough gain
      // the shifted band clears the original one entirely.
      const cfg = config({ biasGain: 1, biasMaxKcal: 900 }, { kcalWindow: 400 });
      const days = history(60, () => ({ ...logged(3400, 2400), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      close(e.goalKcal - e.targetKcal, e.bias.kcal, 1e-9);
      assert.ok(e.goalKcal - e.targetKcal > 200, "no longer clamped to the half-width");
    });

    it("shifts by exactly gain times the bias when the floor is far away", () => {
      const cfg = config({ biasGain: 0.3, biasMaxKcal: 900 });
      const days = history(60, () => ({ ...logged(3400, 2400), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      close(e.goalKcal - e.targetKcal, 0.3 * e.bias.kcal, 1e-9);
    });

    it("never pushes the target below basal metabolic rate", () => {
      // An absurd deficit, plus a bias pushing the same way. The floor is a
      // physiological line, so it is the one thing that has to hold.
      const cfg = config({ biasGain: 1 }, { kcalOffset: -4000 });
      const days = history(60, () => ({ ...logged(2600, 1000), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      const bmr = mifflinBmr(cfg.bio, e.trendKg, today);

      assert.ok(e.bias.kcal > 0, "the correction should be pushing down as well");
      assert.ok(e.goalKcal < bmr, "premise: the uncorrected goal is already under the floor");
      close(e.targetKcal, bmr, 1e-9);
    });

    it("leaks: an old excursion counts for less than a recent one", () => {
      const cfg = config({ biasLeak: 0.96 });
      const spike = (at: number) =>
        estimate(cfg, history(60, (i) => ({ ...logged(i === at ? 3600 : 2600, 2600), weight_kg: 80 })), today)!
          .bias.kcal;
      const old = spike(5);
      const recent = spike(55);
      assert.ok(recent > old, `recent ${recent} should outweigh old ${old}`);
      assert.ok(old > 0 && old < 100, `an old spike should have mostly decayed, got ${old}`);
    });
  });

  it("scales the protein target off the smoothed weight", () => {
    const cfg = config({}, { proteinGPerKg: 1.6 });
    const days = history(60, () => ({ items: [], weight_kg: 80 }));
    const e = estimate(cfg, days, today)!;
    close(e.trendKg, 80, 1e-9);
    close(e.proteinTarget, 128, 1e-9);
  });

  it("hands back the raw and smoothed series", () => {
    const cfg = config();
    const days = history(60, (i) => ({ items: [], weight_kg: 80 + i * 0.01 }));
    const e = estimate(cfg, days, today)!;
    assert.equal(e.samples.length, 60);
    assert.equal(e.trendLine.length, 60);
    assert.equal(e.trendKg, e.trendLine[e.trendLine.length - 1]!.kg);
  });
});

// ---------------------------------------------------------- calories chart

describe("calorieSeries", () => {
  const today = on(29);

  /** Weighed and fully logged every day: intake 2500, drifting down slowly. */
  const steady = (): Map<DayKey, Day> =>
    history(30, (i) => ({ ...logged(2500, 2400, 150), weight_kg: 85 - i * 0.02 }));

  it("marks intake only on fully logged days, never zero", () => {
    const days = steady();
    // Untick one day, empty another, drop a third entirely.
    days.set(on(5), { items: [food(2500)] });
    days.set(on(6), { items: [], logging: "complete" });
    days.delete(on(7));
    const rows = calorieSeries(config(), days, today, 30);
    assert.equal(rows.length, 30);
    assert.equal(rows[5]!.kcal, null);
    assert.equal(rows[6]!.kcal, null);
    assert.equal(rows[7]!.kcal, null);
    assert.equal(rows[8]!.kcal, 2500);
  });

  it("has no TDEE before the first weigh-in", () => {
    const days = steady();
    for (const d of days.values()) delete d.weight_kg;
    days.get(on(20))!.weight_kg = 84;
    const rows = calorieSeries(config(), days, today, 30);
    assert.equal(rows.length, 30);
    assert.ok(
      rows.every((r) => (r.day < on(20) ? r.tdee === null : r.tdee !== null)),
      "TDEE should appear exactly once weighed",
    );
  });

  it("drops leading days with neither intake nor TDEE", () => {
    const days = steady();
    // Nothing at all for the first ten days: no log, no scale.
    for (let i = 0; i < 10; i++) days.delete(on(i));
    const rows = calorieSeries(config(), days, today, 30);
    assert.equal(rows[0]!.day, on(10));
  });

  it("is empty when there is nothing to draw", () => {
    assert.deepEqual(calorieSeries(config(), new Map(), today, 42), []);
  });

  it("agrees with estimate on the last day: one path, not two", () => {
    const days = steady();
    const rows = calorieSeries(config(), days, today, 30);
    const last = rows[rows.length - 1]!;
    assert.equal(last.day, today);
    const e = estimate(config(), days, addDays(today, 1))!;
    close(last.tdee!, e.tdee, 1e-9);
  });

  it("counts a ticked today as finished", () => {
    const days = steady();
    const rows = calorieSeries(config(), days, today, 30);
    assert.equal(rows[rows.length - 1]!.kcal, 2500);
  });
});
