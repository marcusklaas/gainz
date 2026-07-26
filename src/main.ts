import { drawTrend } from "./chart.js";
import { parseWeightCsv, type WeightRow } from "./csv.js";
import { addDays, humanDay, monthOf, nowTime, todayKey } from "./dates.js";
import { correctedTarget, dayKcal, dayProtein, estimate, type Estimate } from "./estimate.js";
import { checkAccess } from "./github.js";
import { estimateFood } from "./llm.js";
import { isConfigured, loadSettings, saveSettings, type Settings } from "./settings.js";
import {
  cachedConfig,
  flush,
  invalidateMonths,
  pendingWrites,
  readDay,
  readRange,
  refreshConfig,
  saveConfig,
  updateDay,
  updateDays,
} from "./store.js";
import type { Config, Day, FoodItem } from "./types.js";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

const val = (id: string) => $<HTMLInputElement>(id).value.trim();
const num = (id: string) => Number($<HTMLInputElement>(id).value);

function msg(id: string, text: string, kind: "ok" | "err" | "" = ""): void {
  const e = $(id);
  e.textContent = text;
  e.className = `msg ${kind}`;
}

let day = todayKey();

// ------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  if (!isConfigured()) {
    $("setup").hidden = false;
    return;
  }
  $("app").hidden = false;
  show("today");

  try {
    await flush();
    const cfg = await refreshConfig();
    if (!cfg) needsConfig();
  } catch {
    // Offline is fine; cached data still renders and writes stay queued.
  }
  fillSettingsForms();
  await render();
  syncStatus();
}

function needsConfig(): void {
  const banner = $("config-banner");
  banner.hidden = false;
  banner.textContent = "No config.json in the repo yet. Review these values and save.";
  banner.className = "msg err";
  show("settings");
}

// ----------------------------------------------------------------- screens

type Screen = "today" | "trend" | "settings";

/** Latest estimate, kept so the chart can be drawn when Trend becomes visible. */
let latest: Estimate | null = null;

function show(name: Screen): void {
  for (const s of ["today", "trend", "settings"] as const) $(s).hidden = s !== name;
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    b.setAttribute("aria-current", String(b.dataset["screen"] === name));
  }
  // uPlot sizes from the container, which measures zero while hidden, so the
  // chart can only be built once its section is on screen.
  if (name === "trend" && latest) drawTrend($("chart"), latest.samples, latest.trendLine);
}

for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
  b.addEventListener("click", () => show(b.dataset["screen"] as Screen));
}

function syncStatus(): void {
  const n = pendingWrites();
  $("sync").textContent = n ? `${n} pending` : "";
}

async function sync(): Promise<void> {
  try {
    await flush();
  } catch {
    // Stays queued.
  }
  syncStatus();
}

// ------------------------------------------------------------------- setup

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s: Settings = {
    owner: val("s-owner"),
    repo: val("s-repo"),
    branch: val("s-branch"),
    pat: val("s-pat"),
    anthropicKey: "",
    openaiKey: "",
  };
  msg("setup-msg", "Checking...");
  try {
    await checkAccess(s);
  } catch (err) {
    msg("setup-msg", String((err as Error).message), "err");
    return;
  }
  saveSettings(s);
  $("setup").hidden = true;
  await boot();
});

// -------------------------------------------------------------------- today

$("prev-day").addEventListener("click", () => {
  day = addDays(day, -1);
  void render();
});

$("next-day").addEventListener("click", () => {
  if (day === todayKey()) return;
  day = addDays(day, 1);
  void render();
});

$("weight-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kg = num("f-weight");
  if (!kg) return;
  await updateDay(day, (d) => {
    d.weight_kg = kg;
  });
  await render();
  await sync();
});

// ---------------------------------------------------------------- food entry

/**
 * One description is one entry. Estimate only fills the two number fields, so
 * the model is a convenience over the manual path rather than a separate flow
 * with its own review step — and anything it gets wrong is fixed by typing over
 * it before pressing Add.
 */

/** Set when the numbers currently in the boxes came from the model. */
let estimatedBy: string | null = null;

const desc = () => $<HTMLTextAreaElement>("f-desc").value.trim();

for (const id of ["f-kcal", "f-protein"]) {
  // Typing over an estimate makes it the user's number, not the model's.
  $(id).addEventListener("input", () => (estimatedBy = null));
}

$("f-estimate").addEventListener("click", async () => {
  const text = desc();
  if (!text) return msg("food-msg", "Describe the food first.", "err");

  const cfg = cachedConfig();
  if (!cfg) return msg("food-msg", "Save your config first.", "err");

  const s = loadSettings();
  const provider = cfg.llm.provider;
  const key = provider === "openai" ? s?.openaiKey : s?.anthropicKey;
  if (!key) return msg("food-msg", `No ${provider} API key yet — add one in Settings.`, "err");

  const button = $<HTMLButtonElement>("f-estimate");
  button.disabled = true;
  msg("food-msg", "Estimating…");
  try {
    const est = await estimateFood(text, { provider, model: cfg.llm.model, key });
    $<HTMLInputElement>("f-kcal").value = String(est.kcal);
    $<HTMLInputElement>("f-protein").value = String(est.protein_g);
    estimatedBy = cfg.llm.model;
    msg("food-msg", "Estimated — edit either number, then Add.", "ok");
  } catch (err) {
    msg("food-msg", (err as Error).message, "err");
  } finally {
    button.disabled = false;
  }
});

$("food-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item: FoodItem = {
    id: crypto.randomUUID(),
    at: nowTime(),
    name: desc(),
    kcal: num("f-kcal"),
    protein_g: num("f-protein"),
    source: estimatedBy ? "llm" : "manual",
    ...(estimatedBy ? { model: estimatedBy } : {}),
  };
  await updateDay(day, (d) => {
    d.items.push(item);
  });
  ($("food-form") as HTMLFormElement).reset();
  estimatedBy = null;
  msg("food-msg", "");
  $("f-desc").focus();
  await render();
  await sync();
});

$("f-logging").addEventListener("change", async () => {
  const v = $<HTMLSelectElement>("f-logging").value;
  await updateDay(day, (d) => {
    if (v) d.logging = v as "complete" | "incomplete";
    else delete d.logging;
  });
  await render();
  await sync();
});

async function render(): Promise<void> {
  const d = await readDay(day);
  $("day-label").textContent = humanDay(day);
  $<HTMLButtonElement>("next-day").disabled = day === todayKey();
  $<HTMLInputElement>("f-weight").value = d.weight_kg ? String(d.weight_kg) : "";
  $<HTMLSelectElement>("f-logging").value = d.logging ?? "";
  renderItems(d);

  const cfg = cachedConfig();
  if (!cfg) return;

  // A config written before a key existed reads back as undefined, which would
  // silently poison every derived number. Name the gap instead of degrading.
  const missing = Object.keys(suggestedConfig().estimator).filter(
    (k) => !Number.isFinite((cfg.estimator as unknown as Record<string, number>)[k]),
  );
  if (missing.length) {
    const note = `Open Settings and press Save config — missing ${missing.join(", ")}.`;
    $("goals").hidden = true;
    $("chart").innerHTML = "";
    $("stats").textContent = note;
    $("trend-note").textContent = note;
    return;
  }

  const e = cfg.estimator;
  $("trend-basis").textContent =
    `Rate is a least-squares fit over the last ${e.tdeeWindowDays} days.` +
    ` Line is Holt smoothing — ${e.levelHalfLifeDays}-day level half-life,` +
    ` ${e.trendHalfLifeDays}-day trend half-life.`;

  const history = await readRange(addDays(day, -e.historyDays), day);
  const est = estimate(cfg, history, day);
  if (est) await recordGoal(d, est);
  renderGoals(d, est);
}

/**
 * Pins today's target the first time the day is opened, and never touches it
 * again. What the bias accumulator needs is the number the user was actually
 * shown; re-deriving it later from a better estimator would measure deviation
 * from a target that was never on screen.
 *
 * Shadow mode: the correction is logged, not applied. Two or three weeks of
 * this says whether E settles somewhere consistent or just wanders about zero.
 */
async function recordGoal(d: Day, est: Estimate): Promise<void> {
  if (day === todayKey() && d.goal_kcal === undefined) {
    d.goal_kcal = Math.round(est.goalKcal);
    await updateDay(day, (x) => {
      x.goal_kcal ??= d.goal_kcal;
    });
  }
  console.info(
    `bias E=${round(est.bias.kcal)} over ${est.bias.days} d ·` +
      ` target ${round(est.goalKcal)} would become ${round(correctedTarget(est))}`,
    est.bias.series,
  );
}

const round = (n: number) => String(Math.round(n));

function bar(id: string, fraction: number, state: string): void {
  const e = $(id);
  e.style.width = `${Math.min(Math.max(fraction, 0), 1) * 100}%`;
  e.className = state;
}

function renderGoals(d: Day, est: Estimate | null): void {
  latest = est;
  $("goals").hidden = !est;
  if (!$("trend").hidden) drawTrend($("chart"), est?.samples ?? [], est?.trendLine ?? []);

  if (!est) {
    $("stats").textContent = "Log a weight to get targets.";
    $("trend-note").textContent = "No weigh-ins yet. Import the CSV in Settings.";
    return;
  }

  const protein = dayProtein(d);
  const hit = protein >= est.proteinTarget;
  $("p-nums").textContent = `${round(protein)} / ${round(est.proteinTarget)} g`;
  bar("p-fill", protein / est.proteinTarget, hit ? "hit" : "");
  $("p-note").textContent = hit ? "Protein hit ✓" : `${round(est.proteinTarget - protein)} g to go`;

  const kcal = dayKcal(d);
  const scale = Math.max(est.kcalUpper * 1.15, kcal * 1.05);
  $("k-nums").textContent = `${round(kcal)}  [${round(est.kcalLower)} – ${round(est.kcalUpper)}]`;
  bar("k-fill", kcal / scale, kcal > est.kcalUpper ? "over" : kcal >= est.kcalLower ? "hit" : "");
  $("k-band").style.left = `${(est.kcalLower / scale) * 100}%`;
  $("k-band").style.width = `${((est.kcalUpper - est.kcalLower) / scale) * 100}%`;

  // Over the top of the range says so and stops. No deficit is carried and no
  // catch-up is suggested — a cheat day is just a cheat day. See spec.md.
  $("k-note").textContent =
    kcal > est.kcalUpper
      ? "Over for today. Reset tomorrow."
      : kcal >= est.kcalLower
        ? `In range · room for ${round(est.kcalUpper - kcal)} more`
        : `${round(est.kcalLower - kcal)} more to reach range · ${round(est.kcalUpper - kcal)} to spare`;

  // Showing the standard error alongside the rate is what makes it readable:
  // -0.09 ± 0.11 kg/wk is not a loss, it is indistinguishable from flat.
  const t = est.trend;
  const rate = t
    ? `${t.kgPerWeek >= 0 ? "↑" : "↓"}${Math.abs(t.kgPerWeek).toFixed(2)}` +
      ` ± ${t.stdErrKgPerWeek.toFixed(2)} kg/wk over ${est.windowDays} days`
    : `not enough weigh-ins in the last ${est.windowDays} days`;
  const err = est.tdeeStdErr === null ? "" : ` ±${round(est.tdeeStdErr)}`;

  // Today carries only what bears on today's targets; the trend lives on Trend.
  $("stats").textContent =
    `TDEE ${round(est.tdee)}${err} · from ${est.countedDays} of ${est.windowDays} days`;

  const flat = t !== null && Math.abs(t.kgPerWeek) < t.stdErrKgPerWeek;
  $("trend-note").textContent =
    est.samples.length < 2
      ? `${est.samples.length} weigh-in so far — two are needed to draw a chart.`
      : `${est.trendKg.toFixed(1)} kg · ${rate}${flat ? " (flat within noise)" : ""}`;
}

function renderItems(d: Day): void {
  const ul = $("items");
  ul.replaceChildren();
  for (const item of d.items) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.name;

    const macros = document.createElement("span");
    macros.className = "macros";
    macros.textContent = `${item.kcal} kcal / ${item.protein_g} g`;

    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", async () => {
      await updateDay(day, (x) => {
        x.items = x.items.filter((i) => i.id !== item.id);
      });
      await render();
      await sync();
    });

    li.append(name, macros, del);
    ul.append(li);
  }
}

// ----------------------------------------------------------------- settings

/**
 * Starting values for the setup form only. The running app never reads these:
 * once saved they live in config.json in the data repo. See PLAN.md.
 */
function suggestedConfig(): Config {
  return {
    version: 1,
    bio: { heightCm: 192, birth: "1991-03", sex: "m" },
    goal: {
      kind: "maintain",
      startedOn: todayKey(),
      kcalRangeOffset: { lower: -200, upper: 200 },
      proteinGPerKg: 1.6,
      endCondition: { type: "review", on: addDays(todayKey(), 90) },
    },
    estimator: {
      levelHalfLifeDays: 10,
      trendHalfLifeDays: 28,
      historyDays: 180,
      tdeeWindowDays: 21,
      blendFullConfidenceDays: 14,
      incompleteDayKcalFraction: 0.5,
      activityFactor: 1.4,
    },
    llm: { provider: "anthropic", model: "claude-sonnet-5" },
  };
}

function fillSettingsForms(): void {
  const s = loadSettings();
  if (s) {
    $<HTMLInputElement>("c-owner").value = s.owner;
    $<HTMLInputElement>("c-repo").value = s.repo;
    $<HTMLInputElement>("c-branch").value = s.branch;
    $<HTMLInputElement>("c-pat").value = s.pat;
    $<HTMLInputElement>("c-anthropic").value = s.anthropicKey ?? "";
    $<HTMLInputElement>("c-openai").value = s.openaiKey ?? "";
  }

  // Keys added after a config was written come through as undefined. The form is
  // the one place suggestions are allowed, so fill the gaps here and let the
  // next save persist them. The running app still reads config.json only.
  const suggested = suggestedConfig();
  const saved = cachedConfig();
  const c: Config = saved
    ? { ...saved, estimator: { ...suggested.estimator, ...saved.estimator } }
    : suggested;
  $<HTMLSelectElement>("g-kind").value = c.goal.kind;
  $<HTMLInputElement>("g-lower").value = String(c.goal.kcalRangeOffset.lower);
  $<HTMLInputElement>("g-upper").value = String(c.goal.kcalRangeOffset.upper);
  $<HTMLInputElement>("g-protein").value = String(c.goal.proteinGPerKg);
  $<HTMLInputElement>("g-started").value = c.goal.startedOn;
  $<HTMLSelectElement>("g-end-type").value = c.goal.endCondition.type;
  $<HTMLInputElement>("g-end-value").value =
    c.goal.endCondition.type === "review"
      ? c.goal.endCondition.on
      : String(c.goal.endCondition.weightKg);
  $<HTMLInputElement>("b-height").value = String(c.bio.heightCm);
  $<HTMLInputElement>("b-birth").value = c.bio.birth;
  $<HTMLSelectElement>("b-sex").value = c.bio.sex;
  $<HTMLInputElement>("e-activity").value = String(c.estimator.activityFactor);
  $<HTMLInputElement>("e-level").value = String(c.estimator.levelHalfLifeDays);
  $<HTMLInputElement>("e-trend").value = String(c.estimator.trendHalfLifeDays);
  $<HTMLInputElement>("e-history").value = String(c.estimator.historyDays);
  $<HTMLInputElement>("e-window").value = String(c.estimator.tdeeWindowDays);
  $<HTMLInputElement>("e-confidence").value = String(c.estimator.blendFullConfidenceDays);
  $<HTMLInputElement>("e-fraction").value = String(c.estimator.incompleteDayKcalFraction);
  $<HTMLSelectElement>("e-provider").value = c.llm.provider ?? "anthropic";
  $<HTMLInputElement>("e-model").value = c.llm.model;
}

$("goal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const endType = $<HTMLSelectElement>("g-end-type").value;
  const endValue = val("g-end-value");
  const c: Config = {
    version: 1,
    bio: {
      heightCm: num("b-height"),
      birth: val("b-birth"),
      sex: $<HTMLSelectElement>("b-sex").value as "m" | "f",
    },
    goal: {
      kind: $<HTMLSelectElement>("g-kind").value as Config["goal"]["kind"],
      startedOn: val("g-started"),
      kcalRangeOffset: { lower: num("g-lower"), upper: num("g-upper") },
      proteinGPerKg: num("g-protein"),
      endCondition:
        endType === "review"
          ? { type: "review", on: endValue }
          : { type: "weight", weightKg: Number(endValue) },
    },
    estimator: {
      levelHalfLifeDays: num("e-level"),
      trendHalfLifeDays: num("e-trend"),
      historyDays: num("e-history"),
      tdeeWindowDays: num("e-window"),
      blendFullConfidenceDays: num("e-confidence"),
      incompleteDayKcalFraction: num("e-fraction"),
      activityFactor: num("e-activity"),
    },
    llm: {
      provider: $<HTMLSelectElement>("e-provider").value as Config["llm"]["provider"],
      model: val("e-model"),
    },
  };
  saveConfig(c);
  await sync();
  await render();
  $("config-banner").hidden = true;
  msg("config-msg", "Saved.", "ok");
});

$("conn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s: Settings = {
    owner: val("c-owner"),
    repo: val("c-repo"),
    branch: val("c-branch"),
    pat: val("c-pat"),
    anthropicKey: val("c-anthropic"),
    openaiKey: val("c-openai"),
  };
  try {
    await checkAccess(s);
  } catch (err) {
    msg("conn-msg", String((err as Error).message), "err");
    return;
  }
  saveSettings(s);
  msg("conn-msg", "Saved.", "ok");
});

// -------------------------------------------------------------- csv import

$("csv-go").addEventListener("click", async () => {
  const text = $<HTMLTextAreaElement>("csv").value;
  let rows: WeightRow[];
  try {
    rows = parseWeightCsv(text);
  } catch (err) {
    msg("csv-msg", String((err as Error).message), "err");
    return;
  }
  if (!rows.length) {
    msg("csv-msg", "No usable rows.", "err");
    return;
  }

  const byDay = new Map(rows.map((r) => [r.day, r.kg]));
  msg("csv-msg", `Importing ${byDay.size} weigh-ins...`);
  await updateDays([...byDay.keys()], (d, key) => {
    d.weight_kg = byDay.get(key)!;
  });
  await sync();

  const months = new Set([...byDay.keys()].map(monthOf)).size;
  msg("csv-msg", `Imported ${byDay.size} weigh-ins across ${months} months.`, "ok");
  $<HTMLTextAreaElement>("csv").value = "";
  await render();
});

// -------------------------------------------------------------------- start

addEventListener("online", () => void sync());

/**
 * Returning to the app is when another device's changes should show up. Only
 * the months on screen are re-read: older ones do not change in practice, and
 * on a phone every extra request is a visible delay.
 */
async function refresh(): Promise<void> {
  invalidateMonths(monthOf(day), monthOf(todayKey()));
  await sync();
  await render();
}

addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

// The path is relative, so the worker registers at whatever prefix the app is
// served from and its scope covers exactly the app. Failure is ignored: offline
// support is a bonus and must never keep the app from starting.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

void boot();
