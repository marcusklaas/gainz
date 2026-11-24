// LLM nutrition estimate parsing, 90%-interval -> 1-sigma conversion, and
// OpenAI Responses API request/error handling.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { estimateFood, parseEstimate } from "../src/services/llm.js";

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

describe("estimateFood (OpenAI)", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("gives OpenAI enough max_output_tokens for reasoning models and reads output_text", async () => {
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output: [
            { type: "reasoning" },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ kcal: 320, protein_g: 24, kcal_low: 270, kcal_high: 370 }),
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const est = await estimateFood("skyrr bowl", {
      provider: "openai",
      model: "gpt-5-mini",
      key: "sk-test",
    });
    assert.equal(est.kcal, 320);
    assert.equal(est.protein_g, 24);
    assert.ok(Number(sentBody["max_output_tokens"]) >= 1000);
  });

  it("surfaces an explicit error when OpenAI exhausts max_output_tokens with no text", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "reasoning" }],
        }),
        { status: 200 },
      )) as typeof fetch;

    await assert.rejects(
      () => estimateFood("big dinner", { provider: "openai", model: "o4-mini", key: "sk-test" }),
      /ran out of output tokens/,
    );
  });
});
