import { parseWeightCsv, type WeightRow } from "./csv.js";
import { addDays, humanDay, monthOf, nowTime, todayKey } from "./dates.js";
import { dayKcal, dayProtein, estimate, type Estimate } from "./estimate.js";
import { checkAccess } from "./github.js";
import { estimateFood } from "./llm.js";
import { defaultNotifications, notificationsOf, requestReminders, updatePlan } from "./notify.js";
import {
  isConfigured,
  loadSettings,
  parseRepo,
  repoUrl,
  saveSettings,
  type Settings,
} from "./settings.js";
import {
  cachedConfig,
  flush,
  invalidateMonths,
  pendingWrites,
  readDay,
  readRange,
  refreshConfig,
  saveConfig,
  type Source,
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
const checked = (id: string) => $<HTMLInputElement>(id).checked;

function msg(id: string, text: string, kind: "ok" | "err" | "" = ""): void {
  const e = $(id);
  e.textContent = text;
  e.className = `msg ${kind}`;
}

let day = todayKey();

// ------------------------------------------------------------------- boot

/**
 * Two passes on purpose. The first is pure localStorage and paints the day that
 * was on screen last time before a single request goes out; the second is the
 * authoritative one and corrects it. GitHub is a slow data store and always will
 * be, so the fix is to stop the UI waiting on it to draw anything at all.
 *
 * The order of the network half is load-bearing: queued writes have to land
 * before the months are re-read, or fetchMonth would overwrite the cache that
 * holds them. flush() is a no-op with an empty outbox, which is the normal case.
 */
async function boot(): Promise<void> {
  if (!isConfigured()) {
    $("setup").hidden = false;
    return;
  }
  $("app").hidden = false;
  show("today");

  fillSettingsForms();
  await render("cache");

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

/**
 * uPlot is by far the largest thing the app loads and Today never shows it, so
 * it is fetched the first time Trend is actually looked at rather than being
 * parsed on the critical path of every start.
 */
let chartModule: Promise<typeof import("./chart.js")> | null = null;

/**
 * Always draws the newest estimate rather than one captured at call time, so
 * two paints racing across the dynamic import settle on the same picture.
 */
async function paintChart(): Promise<void> {
  const { drawTrend } = await (chartModule ??= import("./chart.js"));
  drawTrend($("chart"), latest?.samples ?? [], latest?.trendLine ?? []);
}

function show(name: Screen): void {
  for (const s of ["today", "trend", "settings"] as const) $(s).hidden = s !== name;
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    b.setAttribute("aria-current", String(b.dataset["screen"] === name));
  }
  // uPlot sizes from the container, which measures zero while hidden, so the
  // chart can only be built once its section is on screen.
  if (name === "trend" && latest) void paintChart();
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
  msg("setup-msg", "Checking...");
  let s: Settings;
  try {
    s = {
      repo: parseRepo(val("s-repo")),
      branch: val("s-branch"),
      pat: val("s-pat"),
      anthropicKey: "",
      openaiKey: "",
    };
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
  const on = $<HTMLInputElement>("f-logging").checked;
  await updateDay(day, (d) => {
    if (on) d.logging = "complete";
    else delete d.logging;
  });
  await render();
  await sync();
});

/** Detached from render(), so a failure here cannot surface as an unhandled rejection. */
async function planReminders(cfg: Config | null, d: Day, src: Source): Promise<void> {
  try {
    await updatePlan(cfg, day === todayKey() ? d : await readDay(todayKey(), src));
  } catch {
    // Reminders are best effort by design; see the note under Settings.
  }
}

async function render(src: Source = "server"): Promise<void> {
  const cfg = cachedConfig();
  const missing = cfg ? missingNumbers(cfg) : [];

  // Started before the first await so that the month holding the day on screen
  // and the months behind the estimator window go out together. readMonth
  // collapses the overlap between the two into one request.
  const history =
    cfg && !missing.length
      ? readRange(addDays(day, -cfg.estimator.historyDays), day, src)
      : null;

  const d = await readDay(day, src);
  $("day-label").textContent = humanDay(day);
  $<HTMLButtonElement>("next-day").disabled = day === todayKey();
  $<HTMLInputElement>("f-weight").value = d.weight_kg ? String(d.weight_kg) : "";
  $<HTMLInputElement>("f-logging").checked = d.logging === "complete";
  renderItems(d);

  // Reminders are always about today, whichever day happens to be on screen,
  // and are re-planned here so that saving a weight silences one immediately.
  // Not awaited: it is a Cache API round trip plus, on an older day, a month
  // read, and nothing on screen waits on the answer.
  void planReminders(cfg, d, src);
  if (!cfg) return;

  if (missing.length) {
    const note = `Open Settings and press Save config — missing ${missing.join(", ")}.`;
    $("goals").hidden = true;
    $("chart").innerHTML = "";
    $("stats").textContent = note;
    $("trend-note").textContent = note;
    return;
  }
  $("goals").hidden = false;

  const e = cfg.estimator;
  $("trend-basis").textContent =
    `Rate is a least-squares fit over the last ${e.tdeeWindowDays} days.` +
    ` Line is Holt smoothing — ${e.levelHalfLifeDays}-day level half-life,` +
    ` ${e.trendHalfLifeDays}-day trend half-life.`;

  const est = estimate(cfg, await history!, day);
  // Only ever pinned from a server read. The cache pass exists to put something
  // on screen fast, and a number derived from a stale month is not one to write
  // down permanently as what today was judged against.
  if (est && src === "server") await recordGoal(d, est);
  renderGoals(d, est);
}

/**
 * Pins today's goal the first time the day is opened, and never touches it
 * again. The bias accumulator needs the number that was in force that day;
 * re-deriving it later from more data would fabricate deviations every time
 * the estimate moved.
 *
 * The correction itself stays out of the UI — the band moving is the whole of
 * what the user sees. The log is here so that when it moves, there is somewhere
 * to look and find out why.
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
      ` goal ${round(est.goalKcal)} shown as ${round(est.targetKcal)}`,
    est.bias.series,
  );
}

const round = (n: number) => String(Math.round(n));

/**
 * Settings a config predating them reads back as undefined, which would poison
 * every derived number in silence. Name the gap instead of degrading — one Save
 * in Settings fills them, since the form falls back to the suggested values.
 * There is no migration code anywhere: this is what stands in for it.
 */
function missingNumbers(cfg: Config): string[] {
  const suggested = suggestedConfig();
  const out: string[] = [];
  for (const section of ["goal", "estimator"] as const) {
    for (const [key, value] of Object.entries(suggested[section])) {
      if (typeof value !== "number") continue;
      if (!Number.isFinite((cfg[section] as unknown as Record<string, number>)[key])) out.push(key);
    }
  }
  return out;
}

const DASH = "—";

/**
 * Back to the state the markup ships in: both trackers present, both empty.
 *
 * The bars are laid out from the first frame and stay laid out — an estimate
 * arriving fills them in rather than making them appear. Waiting on seven month
 * files before drawing the shape of the screen is what made a slow start read as
 * a broken one.
 */
function resetGoals(): void {
  $("goals").classList.add("pending");
  $("p-nums").textContent = `${DASH} / ${DASH} g`;
  $("k-nums").textContent = `${DASH} kcal`;
  $("p-note").textContent = "";
  $("k-note").textContent = "";
  for (const id of ["p-fill", "k-fill"]) bar(id, 0, "");
  $("k-band").style.width = "0%";
}

function bar(id: string, fraction: number, state: string): void {
  const e = $(id);
  e.style.width = `${Math.min(Math.max(fraction, 0), 1) * 100}%`;
  e.className = state;
}

function renderGoals(d: Day, est: Estimate | null): void {
  latest = est;
  if (!$("trend").hidden) void paintChart();

  if (!est) {
    resetGoals();
    $("stats").textContent = "Log a weight to get targets.";
    $("trend-note").textContent = "No weigh-ins yet. Import the CSV in Settings.";
    return;
  }
  $("goals").classList.remove("pending");

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
    goal: { kcalOffset: 0, kcalWindow: 400, proteinGPerKg: 1.6 },
    estimator: {
      levelHalfLifeDays: 10,
      trendHalfLifeDays: 28,
      historyDays: 180,
      tdeeWindowDays: 21,
      blendFullConfidenceDays: 14,
      activityFactor: 1.4,
      biasGain: 0.3,
      biasLeak: 0.96,
      biasMaxKcal: 900,
    },
    llm: { provider: "anthropic", model: "claude-sonnet-5" },
    notifications: defaultNotifications(),
  };
}

function fillSettingsForms(): void {
  const s = loadSettings();
  if (s) {
    $<HTMLInputElement>("c-repo").value = repoUrl(s);
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
  $<HTMLInputElement>("g-offset").value = String(c.goal.kcalOffset);
  $<HTMLInputElement>("g-window").value = String(c.goal.kcalWindow);
  $<HTMLInputElement>("g-protein").value = String(c.goal.proteinGPerKg);
  $<HTMLInputElement>("b-height").value = String(c.bio.heightCm);
  $<HTMLInputElement>("b-birth").value = c.bio.birth;
  $<HTMLSelectElement>("b-sex").value = c.bio.sex;
  $<HTMLInputElement>("e-activity").value = String(c.estimator.activityFactor);
  $<HTMLInputElement>("e-level").value = String(c.estimator.levelHalfLifeDays);
  $<HTMLInputElement>("e-trend").value = String(c.estimator.trendHalfLifeDays);
  $<HTMLInputElement>("e-history").value = String(c.estimator.historyDays);
  $<HTMLInputElement>("e-window").value = String(c.estimator.tdeeWindowDays);
  $<HTMLInputElement>("e-confidence").value = String(c.estimator.blendFullConfidenceDays);
  $<HTMLInputElement>("e-bias-gain").value = String(c.estimator.biasGain);
  $<HTMLInputElement>("e-bias-leak").value = String(c.estimator.biasLeak);
  $<HTMLInputElement>("e-bias-max").value = String(c.estimator.biasMaxKcal);
  $<HTMLSelectElement>("e-provider").value = c.llm.provider ?? "anthropic";
  $<HTMLInputElement>("e-model").value = c.llm.model;

  const n = notificationsOf(saved);
  $<HTMLInputElement>("n-weight-on").checked = n.weight.enabled;
  $<HTMLInputElement>("n-weight-at").value = n.weight.time;
  $<HTMLInputElement>("n-food-on").checked = n.nutrition.enabled;
  $<HTMLInputElement>("n-food-at").value = n.nutrition.time;
  $("notify-note").textContent =
    "Best effort: the device has to allow notifications, and one can arrive late" +
    " or, if gainz is closed and the browser will not wake it, not at all.";
}

$("goal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const c: Config = {
    version: 1,
    bio: {
      heightCm: num("b-height"),
      birth: val("b-birth"),
      sex: $<HTMLSelectElement>("b-sex").value as "m" | "f",
    },
    goal: {
      kcalOffset: num("g-offset"),
      kcalWindow: num("g-window"),
      proteinGPerKg: num("g-protein"),
    },
    estimator: {
      levelHalfLifeDays: num("e-level"),
      trendHalfLifeDays: num("e-trend"),
      historyDays: num("e-history"),
      tdeeWindowDays: num("e-window"),
      blendFullConfidenceDays: num("e-confidence"),
      activityFactor: num("e-activity"),
      biasGain: num("e-bias-gain"),
      biasLeak: num("e-bias-leak"),
      biasMaxKcal: num("e-bias-max"),
    },
    llm: {
      provider: $<HTMLSelectElement>("e-provider").value as Config["llm"]["provider"],
      model: val("e-model"),
    },
    notifications: {
      weight: { enabled: checked("n-weight-on"), time: val("n-weight-at") },
      nutrition: { enabled: checked("n-food-on"), time: val("n-food-at") },
    },
  };
  saveConfig(c);

  // Permission is asked for here rather than on the toggle: this is the point
  // where the times are settled, and a prompt that appears mid-edit gets
  // dismissed. render() below re-plans against whatever the answer was.
  const wanted = c.notifications.weight.enabled || c.notifications.nutrition.enabled;
  if (wanted) $("notify-note").textContent = await requestReminders();

  await sync();
  await render();
  $("config-banner").hidden = true;
  msg("config-msg", "Saved.", "ok");
});

$("conn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let s: Settings;
  try {
    s = {
      repo: parseRepo(val("c-repo")),
      branch: val("c-branch"),
      pat: val("c-pat"),
      anthropicKey: val("c-anthropic"),
      openaiKey: val("c-openai"),
    };
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
