// Free text -> one calorie and protein estimate, calling the model provider
// directly from the browser.
//
// One description is always one log entry. Committing to that removes the whole
// splitting problem: no item list, no review step, no per-item editing. The
// model fills two numbers and the user can overwrite either before saving.
//
// Two providers are supported. The prompt, the JSON schema, and the validation
// are shared; only the request shape and the place the JSON ends up differ, so
// each provider is a dozen lines.
//
// Keys live on the user's own device and go straight to the provider. That is
// acceptable only under the conditions agreed in PLAN.md: single user, key never
// committed, and a hard monthly spend cap on the account.
import type { Provider } from "./types.js";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_TOKENS = 200;

export interface Estimated {
  kcal: number;
  protein_g: number;
}

const SCHEMA = {
  type: "object",
  properties: {
    kcal: { type: "number", description: "Total calories for everything described" },
    protein_g: { type: "number", description: "Total protein in grams for everything described" },
  },
  required: ["kcal", "protein_g"],
  additionalProperties: false,
};

const PROMPT = [
  "You estimate nutrition for a personal food log.",
  "",
  "The user describes one entry. Return the total kcal and total protein in",
  "grams for everything described, however many foods that turns out to be.",
  "Never break it down and never give per-100 g values.",
  "",
  "- Assume ordinary portion sizes when the user does not say.",
  "- Take the user's hints seriously: \"light\", \"not heavy on calories\", \"big\",",
  "  \"just a bit\" should visibly move the estimate.",
  "- A rough number is useful; refusing is not. Always give your best guess.",
].join("\n");

async function failure(res: Response): Promise<Error> {
  if (res.status === 401) return new Error("API key rejected. Check it in Settings.");
  if (res.status === 429) return new Error("Rate limited. Try again in a moment.");

  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    // Non-JSON error body; the status alone will have to do.
  }
  return new Error(detail || `Request failed (${res.status})`);
}

export interface Options {
  provider: Provider;
  model: string;
  key: string;
}

/**
 * Browser-origin calls need the dangerous-direct-browser-access header; without
 * it Anthropic refuses the preflight and it fails as a CORS error.
 *
 * thinking is disabled: logging a meal is arithmetic over known portions and
 * sits mid-interaction, so latency beats depth.
 */
async function callAnthropic(text: string, o: Options): Promise<string> {
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": o.key,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: o.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      system: PROMPT,
      messages: [{ role: "user", content: text }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    }),
  });
  if (!res.ok) throw await failure(res);

  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  const block = body.content?.find((b) => b.type === "text");
  if (!block?.text) throw new Error("Response contained no text");
  return block.text;
}

/**
 * OpenAI Responses API. `strict: true` requires every property to be listed in
 * `required` and `additionalProperties: false` on every object — SCHEMA already
 * satisfies both, which is why the same schema serves both providers.
 *
 * Reasoning models put a reasoning item in `output` before the message, so the
 * text is found by scanning for the output_text part rather than by index.
 */
async function callOpenAI(text: string, o: Options): Promise<string> {
  const res = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${o.key}`,
    },
    body: JSON.stringify({
      model: o.model,
      instructions: PROMPT,
      input: text,
      max_output_tokens: MAX_TOKENS,
      text: {
        format: { type: "json_schema", name: "estimate", strict: true, schema: SCHEMA },
      },
    }),
  });
  if (!res.ok) throw await failure(res);

  const body = (await res.json()) as {
    output_text?: string;
    output?: { content?: { type: string; text?: string }[] }[];
  };
  if (body.output_text) return body.output_text;

  for (const item of body.output ?? []) {
    const part = item.content?.find((c) => c.type === "output_text");
    if (part?.text) return part.text;
  }
  throw new Error("Response contained no text");
}

export async function estimateFood(text: string, o: Options): Promise<Estimated> {
  const json = o.provider === "openai" ? await callOpenAI(text, o) : await callAnthropic(text, o);

  // Structured output should guarantee JSON, but a refusal or a truncated reply
  // would surface here as a raw parser error otherwise.
  let payload: { kcal?: unknown; protein_g?: unknown };
  try {
    payload = JSON.parse(json) as { kcal?: unknown; protein_g?: unknown };
  } catch {
    throw new Error("Could not read the estimate. Try rephrasing.");
  }

  // The model is untrusted input, so both numbers are checked before use.
  const kcal = Number(payload.kcal);
  const protein = Number(payload.protein_g);
  if (!Number.isFinite(kcal) || !Number.isFinite(protein)) {
    throw new Error("Estimate came back without usable numbers");
  }
  return { kcal: Math.round(kcal), protein_g: Math.round(protein * 10) / 10 };
}
