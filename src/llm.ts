// Free text -> itemised nutrition estimate, calling the model provider directly
// from the browser.
//
// Two providers are supported. The prompt, the JSON schema, and the validation
// are shared; only the request shape and the place the JSON ends up differ, so
// each provider is a dozen lines.
//
// Keys live on the user's own device and go straight to the provider. That is
// acceptable only under the conditions agreed in PLAN.md: single user, key never
// committed, and a hard monthly spend cap on the account.
//
// The estimate is never saved blind — this module only returns candidates, and
// the review step in main.ts is what writes them.
import type { Favorite, Provider } from "./types.js";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_TOKENS = 2000;

export interface ParsedItem {
  name: string;
  grams: number | null;
  kcal: number;
  protein_g: number;
  /** "low" means the quantity was ambiguous and is worth weighing. */
  confidence: "high" | "low";
}

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short food name, e.g. 'scrambled eggs'" },
          grams: {
            type: ["number", "null"],
            description: "Portion weight in grams if determinable, otherwise null",
          },
          kcal: { type: "number", description: "Calories for the portion eaten, not per 100 g" },
          protein_g: { type: "number", description: "Protein in grams for the portion eaten" },
          confidence: {
            type: "string",
            enum: ["high", "low"],
            description: "low when the quantity is ambiguous or the food varies a lot",
          },
        },
        required: ["name", "grams", "kcal", "protein_g", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

function systemPrompt(favorites: Favorite[]): string {
  const base = [
    "You estimate nutrition for a personal food log.",
    "",
    "GRANULARITY — this matters more than anything else here.",
    "Default to ONE item for everything the user describes. Only split when the",
    "parts are separately served things eaten alongside each other — a burger,",
    "fries and a milkshake are three items. Never break a single dish into its",
    "ingredients: toast with mushrooms, salad and sauce is ONE item, not four.",
    "A sandwich is one item. A curry with rice is one item. A bowl of porridge",
    "with fruit and honey is one item. When in doubt, combine.",
    "",
    "VALUES",
    "- kcal and protein_g are for the portion actually eaten, never per 100 g.",
    "- Give grams for the whole portion when it can be determined, otherwise null.",
    "- Assume ordinary portion sizes when the user does not say.",
    "- Take the user's own hints seriously: \"light\", \"not heavy on calories\",",
    "  \"big\", \"just a bit\" should visibly move the estimate.",
    "- Set confidence to \"low\" when the quantity is vague or the food varies a lot,",
    "  so the user knows that item is worth weighing.",
    "- Name the whole dish in a few words, e.g. \"toast with oyster mushroom & salad\".",
  ].join("\n");

  if (!favorites.length) return base;

  // Recurring foods resolve more consistently when their known values are in
  // context, and it keeps repeated entries from drifting between logs.
  const list = favorites
    .map((f) => `- ${f.name}: ${f.grams ? `${f.grams} g, ` : ""}${f.kcal} kcal, ${f.protein_g} g protein`)
    .join("\n");
  return `${base}\n\nFoods this user logs often, with their usual values. Prefer these when the text matches:\n${list}`;
}

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

/** The model is untrusted input, so every field is checked before it is used. */
function validate(payload: unknown): ParsedItem[] {
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("Response contained no items");

  return items.map((raw, i) => {
    const o = raw as Record<string, unknown>;
    const kcal = Number(o["kcal"]);
    const protein = Number(o["protein_g"]);
    if (!Number.isFinite(kcal) || !Number.isFinite(protein)) {
      throw new Error(`Item ${i + 1} came back without usable numbers`);
    }
    const grams = Number(o["grams"]);
    return {
      name: String(o["name"] ?? "food").slice(0, 80),
      grams: Number.isFinite(grams) && grams > 0 ? Math.round(grams) : null,
      kcal: Math.round(kcal),
      protein_g: Math.round(protein * 10) / 10,
      confidence: o["confidence"] === "low" ? "low" : "high",
    };
  });
}

export interface Options {
  provider: Provider;
  model: string;
  key: string;
  favorites: Favorite[];
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
      system: systemPrompt(o.favorites),
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
      instructions: systemPrompt(o.favorites),
      input: text,
      max_output_tokens: MAX_TOKENS,
      text: {
        format: {
          type: "json_schema",
          name: "food_items",
          strict: true,
          schema: SCHEMA,
        },
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

export async function parseFood(text: string, o: Options): Promise<ParsedItem[]> {
  const json = o.provider === "openai" ? await callOpenAI(text, o) : await callAnthropic(text, o);

  // Structured output should guarantee JSON, but a refusal or a truncated reply
  // would surface here as a raw parser error otherwise.
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("Could not read the estimate. Try rephrasing.");
  }
  return validate(payload);
}
