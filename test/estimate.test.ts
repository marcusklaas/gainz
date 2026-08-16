// The weight/intake estimator. Every function here is pure, so every test is a
// table of numbers in and a number out — no fakes, no clock, no storage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultConfig } from "../src/config.js";
import { addDays } from "../src/dates.js";
import {
  dayKcal,
  dayProtein,
  estimate,
  holtSeries,
  mifflinBmr,
  weekSummary,
  weightSamples,
  type Sample,
} from "../src/estimate.js";
import { DAYS_PER_WEEK, KCAL_PER_KG_FAT, type Config, type Day, type DayKey } from "../src/types.js";

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

// ---------------------------------------------------------------- Holt

describe("holtSeries", () => {
  const series = (kgs: number[], step = 1): Sample[] =>
    kgs.map((kg, i) => ({ day: on(i * step), kg }));

  it("handles the empty and single-sample cases", () => {
    assert.deepEqual(holtSeries([], 10, 28), []);
    assert.deepEqual(holtSeries(series([80]), 10, 28), [{ day: DAY0, kg: 80, slope: 0 }]);
  });

  it("starts on the first reading rather than at zero", () => {
    const out = holtSeries(series([80, 81, 82]), 10, 28);
    assert.equal(out[0]!.kg, 80);
    assert.equal(out.length, 3);
  });

  it("holds a constant series constant", () => {
    for (const s of holtSeries(series(Array(30).fill(80)), 10, 28)) close(s.kg, 80, 1e-9);
  });

  it("holds it constant across gaps too", () => {
    // Level and trend both discount by elapsed days, so an irregular weigh-in
    // schedule must not by itself move the line.
    const irregular = [0, 1, 5, 6, 14, 30, 31, 60].map((d) => ({ day: on(d), kg: 80 }));
    for (const s of holtSeries(irregular, 10, 28)) close(s.kg, 80, 1e-9);
  });

  it("tracks a steady ramp without the lag a level-only smoother has", () => {
    // The point of carrying a slope, stated as the thing the module header
    // states it as: how many days behind a moving line the smoother sits.
    // Measured rather than assumed — the residual error scales with the ramp,
    // the lag it implies does not, so the lag is the honest invariant.
    const a = 1 - Math.pow(0.5, 1 / 10);
    const levelOnlyLag = (1 - a) / a; // ~13.9 days, the mean age of an EWMA's weights

    for (const slope of [0.02, 0.05, 0.1]) {
      const kgs = Array.from({ length: 90 }, (_, i) => 80 + slope * i);
      const truth = kgs[kgs.length - 1]!;

      const holt = holtSeries(series(kgs), 10, 28);
      let ewma = kgs[0]!;
      for (const kg of kgs.slice(1)) ewma = a * kg + (1 - a) * ewma;

      const holtLag = Math.abs(holt[holt.length - 1]!.kg - truth) / slope;
      const ewmaLag = Math.abs(ewma - truth) / slope;

      close(ewmaLag, levelOnlyLag, 0.1, `ewma lag at ${slope} kg/day`);
      assert.ok(holtLag < 2, `holt lags ${holtLag.toFixed(2)} days at ${slope} kg/day`);
      assert.ok(holtLag * 5 < ewmaLag, `holt ${holtLag} should beat ewma ${ewmaLag} handily`);
    }
  });

  it("smooths noise far below its amplitude", () => {
    // ±1 kg of alternating day-to-day noise around a flat 80.
    const kgs = Array.from({ length: 60 }, (_, i) => 80 + (i % 2 ? 1 : -1));
    const out = holtSeries(series(kgs), 10, 28).slice(20);
    for (const s of out) close(s.kg, 80, 0.25, `smoothed ${s.day}`);
  });

  it("survives two samples landing on one day", () => {
    // `weightSamples` cannot produce this — a day holds one weight — but the
    // smoother is exported and takes any series. A zero gap divides the slope
    // update by zero, and a single NaN there poisons every later point, so the
    // floor on the gap is load-bearing rather than defensive.
    const sameDay = [
      { day: DAY0, kg: 80 },
      { day: DAY0, kg: 82 },
      { day: on(4), kg: 81 },
    ];
    for (const s of holtSeries(sameDay, 10, 28)) {
      assert.ok(Number.isFinite(s.kg), `${s.day} came out ${s.kg}`);
      close(s.kg, 80.5, 1.5, `smoothed ${s.day}`);
    }
  });

  it("emits one point per sample, on the sample's own day", () => {
    const samples = series([80, 81, 82, 83]);
    assert.deepEqual(
      holtSeries(samples, 10, 28).map((s) => s.day),
      samples.map((s) => s.day),
    );
  });
});

// ------------------------------------------------------------ the slope
//
// The slope used to be an internal of the smoother, with TDEE derived from a
// separate windowed regression. It is now what TDEE is built on, so it carries
// the properties that regression was there to provide — asserted here on the
// estimator that actually ships.

describe("holtSeries slope", () => {
  const series = (kgs: number[]): Sample[] => kgs.map((kg, i) => ({ day: on(i), kg }));
  const slopeOf = (samples: Sample[], lvl = 10, trend = 28) =>
    holtSeries(samples, lvl, trend).at(-1)!.slope;

  it("is zero before there is anything to measure", () => {
    assert.equal(holtSeries(series([80]), 10, 28)[0]!.slope, 0);
  });

  it("finds no trend in a flat series", () => {
    close(slopeOf(series(Array(40).fill(80))), 0, 1e-9);
  });

  it("converges on the true rate of a steady ramp", () => {
    // The property TDEE depends on: given a constant 0.2 kg/day the smoother
    // must report 0.2 kg/day, not merely something proportional to it.
    //
    // The residual error is a fixed *fraction* of the ramp — 0.25% at 120
    // samples, for every rate tried — so the tolerance has to be relative. An
    // absolute one would be slack at 0.01 kg/day and unmeetable at 0.2.
    for (const perDay of [0.2, -0.05, 0.01]) {
      const ramp = (n: number) =>
        slopeOf(series(Array.from({ length: n }, (_, i) => 80 + perDay * i)));
      const err = Math.abs(ramp(120) - perDay) / Math.abs(perDay);
      assert.ok(err < 0.005, `${perDay} kg/day: off by ${(err * 100).toFixed(2)}%`);
      // Converging, not merely close: more data has to mean less error.
      assert.ok(Math.abs(ramp(240) - perDay) < Math.abs(ramp(120) - perDay));
    }
  });

  it("reads elapsed days, not sample index, so gaps do not inflate it", () => {
    // Same underlying ramp, weighed every third day. A smoother that counted
    // samples rather than days would report a rate three times too steep.
    const perDay = 0.1;
    const dense = Array.from({ length: 120 }, (_, i) => ({ day: on(i), kg: 80 + perDay * i }));
    const sparse = dense.filter((_, i) => i % 3 === 0);
    assert.ok(Math.abs(slopeOf(sparse) - perDay) / perDay < 0.01, "sparse finds the true rate");
    assert.ok(Math.abs(slopeOf(sparse) - slopeOf(dense)) / perDay < 0.01, "sparse matches dense");
  });

  it("is unmoved by shifting the whole series in time", () => {
    const base = Array.from({ length: 40 }, (_, i) => ({ day: on(i), kg: 80 + 0.3 * i }));
    const later = base.map((s) => ({ day: addDays(s.day, 500), kg: s.kg }));
    close(slopeOf(later), slopeOf(base), 1e-12);
  });

  it("survives two samples landing on one day", () => {
    // The gap is floored at one day, so a same-day pair must not divide by zero.
    const out = holtSeries([...series([80, 81]), { day: on(1), kg: 82 }], 10, 28);
    for (const p of out) assert.ok(Number.isFinite(p.slope));
  });

  it("has no window to fall out of: an old outlier decays instead of dropping", () => {
    // The whole reason for the change. One bad reading, then a long clean
    // stretch: its influence has to fade *continuously*. A trailing window
    // instead carries its oldest sample at full weight and then loses it in a
    // single step, which is what made TDEE lurch.
    const clean = Array.from({ length: 90 }, (_, i) => ({ day: on(i), kg: 80 }));
    const spiked = clean.map((s, i) => (i === 5 ? { ...s, kg: 83 } : s));

    const influence = clean.map((_, i) =>
      Math.abs(
        holtSeries(spiked.slice(0, i + 1), 10, 28).at(-1)!.slope -
          holtSeries(clean.slice(0, i + 1), 10, 28).at(-1)!.slope,
      ),
    );
    const peak = Math.max(...influence);

    // Continuity is the assertion, and it is the one a window fails: no single
    // day may shed more than a tenth of the peak. Note this is deliberately not
    // a monotonicity check. Every slope estimator's weights sum to zero, so its
    // influence must cross zero and come back up the far side — here around day
    // 31 — and demanding monotone decay would be asserting something false.
    for (let i = 6; i < influence.length; i++) {
      const step = Math.abs(influence[i]! - influence[i - 1]!);
      assert.ok(step < peak / 10, `influence jumped ${step} on day ${i}, peak ${peak}`);
    }
    assert.ok(influence[89]! < peak / 5, "an 84-day-old outlier should be mostly spent");
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
    // the measurement says TDEE is 2600, and full confidence hands it the wheel.
    const cfg = config({ biasGain: 0 });
    const days = history(60, (i) => ({ ...logged(2600, 2600), weight_kg: 80 }));
    const e = estimate(cfg, days, today)!;

    assert.equal(e.countedDays, cfg.estimator.tdeeWindowDays);
    close(e.kgPerWeek!, 0, 1e-9);
    close(e.tdee, 2600, 1e-9);
    close(e.goalKcal, 2600 + cfg.goal.kcalOffset, 1e-9);
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

  it("blends from formula to measurement in proportion to logged days", () => {
    const cfg = config({ biasGain: 0, blendFullConfidenceDays: 14 });
    // Seven logged days out of a fourteen-day confidence horizon: half weight.
    const days = history(60, (i) => {
      const weighed = { items: [], weight_kg: 80 } as Day;
      return i >= 52 && i < 59 ? { ...logged(2600, 2600), weight_kg: 80 } : weighed;
    });
    const e = estimate(cfg, days, today)!;
    const formula = mifflinBmr(cfg.bio, e.trendKg, today) * cfg.estimator.activityFactor;

    assert.equal(e.countedDays, 7);
    close(e.tdee, 0.5 * 2600 + 0.5 * formula, 1e-6);
  });

  it("never lets today move today's own target", () => {
    // Today is excluded from the fit even when ticked, so the bias accumulator
    // cannot be fed by the meal you are about to log against it.
    const cfg = config();
    const base = history(60, () => ({ ...logged(2600, 2600), weight_kg: 80 }));
    const withToday = new Map(base).set(today, { ...logged(9000, 2600), weight_kg: 80 });

    const a = estimate(cfg, base, today)!;
    const b = estimate(cfg, withToday, today)!;
    close(b.targetKcal, a.targetKcal, 1e-9);
    close(b.tdee, a.tdee, 1e-9);
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

    it("moves the band by at most its own half-width", () => {
      const cfg = config({ biasGain: 5, biasMaxKcal: 5000 }, { kcalWindow: 400 });
      const days = history(60, () => ({ ...logged(6000, 2000), weight_kg: 80 }));
      const e = estimate(cfg, days, today)!;
      close(e.goalKcal - e.targetKcal, 200, 1e-9);
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

  it("reports the window it used and hands back the raw and smoothed series", () => {
    const cfg = config({ tdeeWindowDays: 21 });
    const days = history(60, (i) => ({ items: [], weight_kg: 80 + i * 0.01 }));
    const e = estimate(cfg, days, today)!;
    assert.equal(e.windowDays, 21);
    assert.equal(e.samples.length, 60);
    assert.equal(e.trendLine.length, 60);
    assert.equal(e.trendKg, e.trendLine[e.trendLine.length - 1]!.kg);
  });
});
