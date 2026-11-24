// LLM nutrition estimate parsing and 90%-interval -> 1-sigma conversion.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEstimate } from "../src/llm.js";

describe("parseEstimate", () => {
  it("rounds kcal, keeps one decimal on protein, and converts the 90% interval to 1-sigma", () => {
    const out = parseEstimate(
      JSON.stringify({ kcal: 542.6, protein_g: 31.46, kcal_low: 450, kcal_high: 650 }),
    );
    assert.deepEqual(out, {
      kcal: 543,
      protein_g: 31.5,
      kcal_sd: Math.round(200 / 3.29),
    });
  });

  it("handles reversed interval bounds without producing a negative sd", () => {
    const out = parseEstimate(
      JSON.stringify({ kcal: 600, protein_g: 40, kcal_low: 720, kcal_high: 480 }),
    );
    assert.equal(out.kcal_sd, Math.round(240 / 3.29));
  });

  it("omits kcal_sd when the interval is missing or non-numeric rather than failing", () => {
    const missing = parseEstimate(JSON.stringify({ kcal: 400, protein_g: 20 }));
    assert.deepEqual(missing, { kcal: 400, protein_g: 20 });
    assert.equal("kcal_sd" in missing, false);

    // Regression guard: Number(null) is 0, which must not fabricate an interval.
    const nulled = parseEstimate(
      JSON.stringify({ kcal: 400, protein_g: 20, kcal_low: null, kcal_high: 500 }),
    );
    assert.equal("kcal_sd" in nulled, false);
  });

  it("rejects malformed, truncated, or non-object JSON with a readable error", () => {
    for (const bad of ["", "{truncated", "null", "[]", "42", '"text"']) {
      assert.throws(() => parseEstimate(bad), /Could not read the estimate/);
    }
  });

  it("rejects missing or non-numeric kcal and protein_g", () => {
    for (const payload of [
      { kcal: "many", protein_g: 20 },
      { kcal: 500, protein_g: null },
      { kcal: null, protein_g: 20 },
      { protein_g: 20 },
    ]) {
      assert.throws(() => parseEstimate(JSON.stringify(payload)), /without usable numbers/);
    }
  });
});
