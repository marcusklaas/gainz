// Entry point: boot, screen navigation, sync plumbing, setup, and the Today
// screen. Lifts, Trend, and Settings/Export live in their own UI modules.
import { installDatalistFallback } from "./datalist.js";
import { addDays, humanDay, monthOf, nowStamp, todayKey } from "./dates.js";
import { $, DASH, msg, num, round, val, type Screen } from "./dom.js";
import {
  dayKcal,
  dayProtein,
  displayBand,
  estimate,
  WEEK_DAYS,
  type Estimate,
} from "./estimate.js";
import { checkAccess } from "./github.js";
import { clearEdit, initLifts, renderLifts } from "./lifts-ui.js";
import { estimateFood } from "./llm.js";
import { updatePlan } from "./notify.js";
import {
  isConfigured,
  loadSettings,
  parseRepo,
  saveSettings,
  type Settings,
} from "./settings.js";
import { fillSettingsForms, initSettings, needsConfig } from "./settings-ui.js";
import {
  cachedConfig,
  flush,
  invalidateMonths,
  pendingWrites,
  readDay,
  readRange,
  refreshConfig,
  updateDay,
  type Source,
} from "./store.js";
import { paintChart, renderWeek, updateTrendHistory, updateTrendWeight } from "./trend-ui.js";
import type { Config, Day, DayKey, FoodItem } from "./types.js";

let day = todayKey();

// ------------------------------------------------------------- the day lock
//
// Past days arrive read-only. Browsing back a few days to check something is a
// tap away and the screen is otherwise identical to today's, so the write
// surface being live is an invitation to log this evening's dinner onto a
// Tuesday in July — where it is not just wrong but load-bearing, since the
// estimator reads those days back as intake and moves every following target.
//
// The lock is off today always, so the common case never meets it at all.

/**
 * Whether the past day on screen has been armed. In memory and nowhere else:
 * not localStorage, not the outbox, not the day file. A reload, a new tab or a
 * fresh boot all start locked, because an unlock is a statement about the next
 * minute rather than a setting.
 */
let unlocked = false;

/**
 * Today is never locked; every other day is — tomorrow included — until the
 * padlock is tapped. Plans deserve the same deliberateness as history: an
 * unlock is a statement about the next minute.
 */
const locked = (): boolean => day !== todayKey() && !unlocked;

/**
 * The only way the day on screen changes. Navigating always re-locks — stepping
 * off an armed day and back onto it lands on it locked, the same as arriving
 * from anywhere else — and routing both arrows through here is what makes that
 * true of any way in that gets added later, rather than a rule each caller has
 * to remember.
 */
function goTo(next: DayKey): void {
  day = next;
  unlocked = false;
  void render();
}

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
    if (!cfg) needsConfig(show);
  } catch {
    // Offline is fine; cached data still renders and writes stay queued.
  }
  fillSettingsForms();
  await render();
  syncStatus();
}

// ----------------------------------------------------------------- screens

const SCREENS: readonly Screen[] = ["today", "lifts", "lift", "trend", "settings"];

function show(name: Screen): void {
  // Leaving the editor ends an edit of a past session, whether that was the
  // back button, the nav, or a save. One place rather than each of them, so
  // there is no route out that forgets. A session in progress is untouched:
  // its whole contract is that it survives this.
  if (name !== "lift") clearEdit();
  // Same reasoning one screen over: leaving Today ends an unlock, so coming
  // back to a past day lands on it locked rather than still armed from before.
  if (name !== "today") unlocked = false;
  for (const s of SCREENS) $(s).hidden = s !== name;
  // The editor is part of Lifts as far as the nav is concerned; nothing else
  // would be lit while it is open.
  const tab = name === "lift" ? "lifts" : name;
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    b.setAttribute("aria-current", String(b.dataset["screen"] === tab));
  }
  // uPlot sizes from the container, which measures zero while hidden, so the
  // chart can only be built once its section is on screen.
  // Unconditional: the three charts are independent, and a log with sessions but
  // no weigh-ins still has a strength index to draw.
  if (name === "trend") void paintChart();
  if (name === "lifts") void renderLifts();
  // Repaints the lock that arriving here just reset. Without this the fields
  // stay looking editable while commit() has already started refusing them,
  // which is the one failure mode worse than the lock itself: typing a meal in
  // and having Add do nothing at all.
  if (name === "today") renderLock();
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

/**
 * Every change to the day on screen goes through here. Write, redraw, push — in
 * that order, and the push last because it is the only step allowed to fail.
 */
async function commit(fn: (d: Day) => void): Promise<void> {
  // The controls are disabled as well, so this is the backstop rather than the
  // mechanism: it is what makes "a locked day is not written to" a property of
  // the funnel every write already goes through, and not of eight handlers.
  if (locked()) return;
  await updateDay(day, fn);
  await render();
  await sync();
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

$("prev-day").addEventListener("click", () => goTo(addDays(day, -1)));

/**
 * One day past today and no further: tomorrow is the meal-prep scratch space,
 * and anything beyond it is a calendar nobody asked for.
 */
$("next-day").addEventListener("click", () => {
  if (day === addDays(todayKey(), 1)) return;
  goTo(addDays(day, 1));
});

// Toggles both ways, so a day can be deliberately put back down once it is
// dealt with rather than only by walking away from it.
$("day-lock").addEventListener("click", () => {
  unlocked = !unlocked;
  renderLock();
});

$("weight-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kg = num("f-weight");
  if (!kg) return;
  await commit((d) => {
    d.weight_kg = kg;
  });
});

// ---------------------------------------------------------------- food entry
//
// One description is one entry. Estimate only fills the two number fields, so
// the model is a convenience over the manual path rather than a separate flow
// with its own review step — and anything it gets wrong is fixed by typing over
// it before pressing Add.

/** Set when the numbers currently in the boxes came from the model. */
let estimatedBy: string | null = null;
/** The model's sd on those numbers. Voided together with the tag: typing over
 *  the numbers breaks the correspondence the sd was judged against. */
let estimatedSd: number | null = null;

const desc = () => $<HTMLTextAreaElement>("f-desc").value.trim();

for (const id of ["f-kcal", "f-protein"]) {
  // Typing over an estimate makes it the user's number, not the model's.
  $(id).addEventListener("input", () => {
    estimatedBy = null;
    estimatedSd = null;
  });
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
    estimatedSd = est.kcal_sd ?? null;
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
    at: nowStamp(),
    name: desc(),
    kcal: num("f-kcal"),
    protein_g: num("f-protein"),
    ...(estimatedBy ? { model: estimatedBy } : {}),
    ...(estimatedBy && estimatedSd !== null ? { kcal_sd: estimatedSd } : {}),
  };
  ($("food-form") as HTMLFormElement).reset();
  estimatedBy = null;
  estimatedSd = null;
  msg("food-msg", "");
  $("f-desc").focus();
  await commit((d) => {
    d.items.push(item);
  });
});

$("f-logging").addEventListener("change", async () => {
  const on = $<HTMLInputElement>("f-logging").checked;
  await commit((d) => {
    if (on) d.logging = "complete";
    else delete d.logging;
  });
});

/**
 * The padlock and the fields it governs — the whole of the lock on screen.
 * There is no banner and no tint beyond this: the region that cannot be typed
 * into is dimmed, which says where you are by saying what you cannot do.
 */
function renderLock(): void {
  const lock = $<HTMLButtonElement>("day-lock");
  // Today can never be locked (see locked()), so there the padlock would be
  // a control that does nothing.
  lock.hidden = day === todayKey();
  lock.setAttribute("aria-pressed", String(unlocked));
  lock.title = unlocked ? "Lock this day" : "Unlock to edit this day";
  $<HTMLFieldSetElement>("day-edit").disabled = locked();
}

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

  // Started before the first await so that the month holding the day on screen
  // and the months behind the estimator window go out together. readMonth
  // collapses the overlap between the two into one request.
  const history = cfg ? readRange(addDays(day, -cfg.estimator.historyDays), day, src) : null;

  // Always about now, whichever day is on screen — so it cannot read from the
  // history above, which ends at `day` and would be missing the last few days
  // whenever you have browsed backwards. Its months are almost always already
  // inside that range, and readMonth collapses the overlap into no new request.
  const today = todayKey();
  const week = readRange(addDays(today, -(WEEK_DAYS - 1)), today, src);

  const d = await readDay(day, src);
  $("day-label").textContent = humanDay(day);
  renderLock();
  $<HTMLButtonElement>("next-day").disabled = day === addDays(today, 1);

  // Tomorrow is food only, and it says so in place: the weight box and the
  // complete tick are dimmed and disabled rather than hidden, so the layout
  // holds still between today and tomorrow. The tick is what admits a day
  // into the TDEE fit, and a weigh-in for a day that has not happened is a
  // nonsense number — both stay out of reach until the day arrives.
  const future = day > today;
  for (const id of ["weight-form", "logging-row", "logging-note"]) {
    $(id).classList.toggle("dimmed", future);
  }
  $<HTMLInputElement>("f-weight").disabled = future;
  $<HTMLButtonElement>("weight-save").disabled = future;
  $<HTMLInputElement>("f-logging").disabled = future;
  $<HTMLInputElement>("f-weight").value = d.weight_kg ? String(d.weight_kg) : "";
  $<HTMLInputElement>("f-logging").checked = d.logging === "complete";
  renderItems(d);

  // Reminders are always about today, whichever day happens to be on screen,
  // and are re-planned here so that saving a weight silences one immediately.
  // Not awaited: it is a Cache API round trip plus, on an older day, a month
  // read, and nothing on screen waits on the answer.
  void planReminders(cfg, d, src);
  if (!cfg) return;

  const past = await history!;
  const est = estimate(cfg, past, day);

  // Read over the same history and dated to the same day as the weight chart
  // beside it, so browsing back moves both pictures together rather than one.
  updateTrendHistory(day, past, cfg);

  // Only ever pinned from a server read. The cache pass exists to put something
  // on screen fast, and a number derived from a stale month is not one to write
  // down permanently as what today was judged against.
  if (est && src === "server") await recordGoal(d, est);
  renderGoals(d, est, cfg, day >= today);
  updateTrendWeight(est);
  renderWeek(await week, est);
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
  );
}

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

function renderGoals(d: Day, est: Estimate | null, cfg: Config, preview: boolean): void {
  if (!est) {
    resetGoals();
    $("stats").textContent = "Log a weight to get targets.";
    return;
  }
  $("goals").classList.remove("pending");

  const protein = dayProtein(d);
  const hit = protein >= est.proteinTarget;
  $("p-nums").textContent = `${round(protein)} / ${round(est.proteinTarget)} g`;
  bar("p-fill", protein / est.proteinTarget, hit ? "hit" : "");
  $("p-note").textContent = hit ? "Protein hit ✓" : `${round(est.proteinTarget - protein)} g to go`;

  // The band is centred on this day's stored goal, not on today's live
  // TDEE-plus-offset: the offset pins new goals, it never repaints old ones.
  // A past day that never pinned one shows a dash rather than a fabrication.
  const band = displayBand(cfg, est, d.goal_kcal, preview);
  if (!band) {
    $("k-nums").textContent = DASH;
    $("k-note").textContent = "No goal was recorded that day.";
    bar("k-fill", 0, "");
    $("k-band").style.width = "0%";
  } else {
    const kcal = dayKcal(d);
    const scale = Math.max(band.kcalUpper * 1.15, kcal * 1.05);
    $("k-nums").textContent = `${round(kcal)}  [${round(band.kcalLower)} – ${round(band.kcalUpper)}]`;
    bar("k-fill", kcal / scale, kcal > band.kcalUpper ? "over" : kcal >= band.kcalLower ? "hit" : "");
    $("k-band").style.left = `${(band.kcalLower / scale) * 100}%`;
    $("k-band").style.width = `${((band.kcalUpper - band.kcalLower) / scale) * 100}%`;

    // Over the top of the range says so and stops. No deficit is carried and no
    // catch-up is suggested — a cheat day is just a cheat day. See spec.md.
    $("k-note").textContent =
      kcal > band.kcalUpper
        ? "Over for today. Reset tomorrow."
        : kcal >= band.kcalLower
          ? `In range · room for ${round(band.kcalUpper - kcal)} more`
          : `${round(band.kcalLower - kcal)} more to reach range · ${round(band.kcalUpper - kcal)} to spare`;
  }

  // Today carries only what bears on today's targets; the trend lives on Trend.
  $("stats").textContent = `TDEE ${round(est.tdee)}`;
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
    del.addEventListener("click", () =>
      commit((x) => {
        x.items = x.items.filter((i) => i.id !== item.id);
      }),
    );

    li.append(name, macros, del);
    ul.append(li);
  }
}

// -------------------------------------------------------------------- start

initLifts({ show, sync });
initSettings({ sync, render });

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
//
// A module worker, so it can import the reminder logic the page also uses
// rather than carrying a hand-synced copy of it.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { type: "module" }).catch(() => {});
}

installDatalistFallback();

void boot();
