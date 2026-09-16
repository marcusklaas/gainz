// The joint weight/TDEE filter. Pure functions over daily arrays, so every
// test is numbers in and numbers out — no clock, no storage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_HYPER,
  eraLoglik,
  ewmaFill,
  filterJoint,
  fitJoint,
  inputsFor,
} from "../src/joint3.js";
import type { Day, DayKey } from "../src/types.js";

const close = (actual: number, expected: number, eps: number, what = "") =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${what || "value"}: expected ${expected} ± ${eps}, got ${actual}`,
  );

/** `n` days of flat weight and flat counted intake. */
const flat = (n: number, kg: number, kcal: number) => ({
  weight: new Array<number | null>(n).fill(kg),
  counted: new Array<number | null>(n).fill(kcal),
});

// ------------------------------------------------------------- inputs gate

describe("inputsFor", () => {
  const day = (d: Partial<Day>): Day => ({ items: [], ...d } as Day);

  it("excludes today from intake but not from weight", () => {
    const days = new Map<DayKey, Day>([
      ["2026-01-01", day({ weight_kg: 80, items: [{ id: "a", at: "x", name: "f", kcal: 2000, protein_g: 0 }], logging: "complete" })],
      ["2026-01-02", day({ weight_kg: 81, items: [{ id: "b", at: "x", name: "f", kcal: 9000, protein_g: 0 }], logging: "complete" })],
    ]);
    const inputs = inputsFor(days, "2026-01-02", "2026-01-02")!;
    assert.deepEqual(inputs.weight, [80, 81]);
    assert.deepEqual(inputs.counted, [2000, null]);
  });

  it("reads unlogged days as gaps, never zero", () => {
    const days = new Map<DayKey, Day>([
      ["2026-01-01", day({ weight_kg: 80 })],
      ["2026-01-02", day({ weight_kg: 81 })],
    ]);
    const inputs = inputsFor(days, "2026-01-02", "2026-01-03")!;
    assert.deepEqual(inputs.counted, [null, null]);
  });
});

// --------------------------------------------------------------- EWMA fill

describe("ewmaFill", () => {
  it("is null before the first counted day and causal after it", () => {
    const counted: (number | null)[] = [null, null, 2000, null, 3000, null];
    const fill = ewmaFill(counted, 12);
    assert.equal(fill[0], null);
    assert.equal(fill[1], null);
    assert.equal(fill[2], null); // the day itself is excluded: nothing before it
    assert.ok(fill[3] !== null && Math.abs(fill[3]! - 2000) < 1e-9);
    // Day 5 sees both logged days; a future feast must not leak backwards.
    const noFuture = ewmaFill([null, null, 2000, null, null, null], 12);
    assert.equal(fill[3], noFuture[3]);
  });
});

// ----------------------------------------------------------------- filter

describe("filterJoint", () => {
  it("holds flat weight on flat intake at that intake", () => {
    const { weight, counted } = flat(60, 80, 2500);
    const { states } = filterJoint(weight, counted, 2400, DEFAULT_HYPER);
    const last = states[59]!;
    close(last.tissue, 80, 0.05, "tissue");
    close(last.tdee, 2500, 1, "tdee");
    close(last.slope, 0, 1e-4, "slope");
  });

  it("parks a one-day scale spike in water, and TDEE recovers", () => {
    // A salty meal, not a kilo of fat overnight — run through the pipeline as
    // shipped (fit, then filter), not at hand-picked hyperparameters.
    const { weight, counted } = flat(60, 80, 2500);
    weight[30] = 81;
    const { hyper } = fitJoint(weight, counted, 2400);
    const { states } = filterJoint(weight, counted, 2400, hyper);
    const before = states[29]!;
    const spike = states[30]!;
    const dTissue = spike.tissue - before.tissue;
    const dWater = spike.water - before.water;
    assert.ok(dWater > 2 * dTissue, `water ${dWater} should dwarf tissue ${dTissue}`);
    // The TDEE channel does answer the surprise — joint inference cuts both
    // ways, ~130 kcal here at production-like drift — but the move is
    // transient: ordinary days walk most of it back, so the calorie target is
    // not permanently repriced by one salty meal. Pinned as a ratio, so the
    // bound survives hyperparameter changes.
    const impact = Math.abs(spike.tdee - before.tdee);
    const later = states[45]!;
    assert.ok(
      Math.abs(later.tdee - before.tdee) < 0.25 * impact,
      `TDEE residual ${later.tdee - before.tdee} should be < 1/4 of impact ${impact}`,
    );
  });

  it("charges a steady loss against intake at the fat-equivalent rate", () => {
    const n = 90;
    const weight = Array.from({ length: n }, (_, i) => 90 - (0.5 / 7) * i);
    const counted = new Array<number | null>(n).fill(2000);
    const { states } = filterJoint(weight, counted, 2400, DEFAULT_HYPER);
    const last = states[n - 1]!;
    close(last.tdee, 2000 + (0.5 * 7700) / 7, 25, "tdee");
    close(last.slope * 7, -0.5, 0.05, "slope");
  });

  it("coasts tissue through gaps with no update", () => {
    // Prior at intake, so the drive is zero from the start: with no
    // observations and no drift there is nothing to move tissue at all.
    const { weight, counted } = flat(30, 80, 2500);
    for (let i = 10; i < 20; i++) weight[i] = null;
    const { states } = filterJoint(weight, counted, 2500, DEFAULT_HYPER);
    close(states[19]!.tissue, states[9]!.tissue, 1e-6, "gap coast");
    assert.ok(states[15]!.tissueSd > states[9]!.tissueSd, "uncertainty must grow over gaps");
  });
});

// -------------------------------------------------------------------- fit

describe("fitJoint", () => {
  it("is deterministic and keeps phi inside (0, 1)", () => {
    const { weight, counted } = flat(60, 80, 2500);
    const a = fitJoint(weight, counted, 2400);
    const b = fitJoint(weight, counted, 2400);
    assert.deepEqual(a.hyper, b.hyper);
    assert.ok(a.hyper.phi > 0 && a.hyper.phi < 1, `phi ${a.hyper.phi}`);
    assert.ok(a.hyper.qTdee > 0 && a.hyper.qWater > 0);
    assert.ok(Number.isFinite(a.loglik));
  });

  it("does not freeze TDEE on a short intake era", () => {
    // Ten logged days after a silent month: the likelihood is ridge-flat and
    // pure MLE wanders to qTdee -> 0, parking TDEE at an overcorrected level
    // (the early-August rows read ~1650 that way). The weak MAP prior keeps
    // the fit near defaults until the era can carry it.
    const n = 40;
    const weight = new Array<number | null>(n).fill(80);
    const counted = new Array<number | null>(n).fill(null);
    for (let i = 30; i < n; i++) counted[i] = 2500;
    const { hyper } = fitJoint(weight, counted, 2400);
    assert.ok(
      hyper.qTdee > DEFAULT_HYPER.qTdee / 10 && hyper.qTdee < DEFAULT_HYPER.qTdee * 10,
      `qTdee ${hyper.qTdee} should stay near ${DEFAULT_HYPER.qTdee}`,
    );
    const { states } = filterJoint(weight, counted, 2400, hyper);
    close(states[n - 1]!.tdee, 2500, 150, "short-era TDEE");
  });

  it("falls back to defaults when there is no intake to fit on", () => {
    const weight = new Array<number | null>(30).fill(80);
    const counted = new Array<number | null>(30).fill(null);
    const fit = fitJoint(weight, counted, 2400);
    assert.deepEqual(fit.hyper, DEFAULT_HYPER);
  });

  it("scores the intake era only, past a warm-up", () => {
    // The likelihood is the Gaussian prediction-error sum over innovations on
    // days at/after the first counted intake, minus warm-up readings still
    // dominated by the wide TDEE prior. Pre-intake residuals never enter the
    // sum (the handoff state legitimately depends on history — that is the
    // filter, not the scoring — so this pins the window, not the state).
    const { weight, counted } = flat(50, 80, 2500);
    for (let i = 0; i < 20; i++) counted[i] = null;
    const era0 = 20;
    const { innov } = filterJoint(weight, counted, 2400, DEFAULT_HYPER);
    let manual = 0;
    let n = 0;
    for (const r of innov) {
      if (r.t < era0 + 5) continue;
      manual += -0.5 * (Math.log(2 * Math.PI) + Math.log(r.f) + (r.v * r.v) / r.f);
      n++;
    }
    assert.ok(n >= 3, "the era must actually score days");
    close(eraLoglik(weight, counted, 2400, DEFAULT_HYPER), manual, 1e-9, "era loglik");
  });
});
