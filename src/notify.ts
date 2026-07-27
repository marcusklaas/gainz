// The in-page half of the reminder system: rebuild the plan after a render, and
// keep one timer armed for whatever is due next while the app is open. The plan
// itself, the wording, and the background half live in reminders.ts, which the
// service worker imports too.
import { defaultConfig } from "./config.js";
import { todayKey } from "./dates.js";
import {
  isPending,
  KINDS,
  readPlan,
  show,
  SYNC_TAG,
  untilToday,
  writePlan,
  type Kind,
  type Plan,
} from "./reminders.js";
import type { Config, Day } from "./types.js";

/**
 * Rebuilds the plan from today's data and re-arms the timer. Idempotent and
 * cheap, so it simply runs after every render — which is what makes a reminder
 * go quiet the moment the weight is saved or the box is ticked.
 */
export async function updatePlan(cfg: Config | null, today: Day): Promise<void> {
  if (!("Notification" in window) || !("caches" in window)) return;

  const day = todayKey();
  // Config comes out of the store already merged over the defaults, so the
  // block is always complete; null means there is no config at all yet.
  const n = (cfg ?? defaultConfig()).notifications;
  const previous = await readPlan();
  // Already-fired marks survive the rebuild; ones from an earlier day do not.
  const firedToday = (k: Kind) => (previous?.day === day ? previous[k].notified : undefined);

  const plan: Plan = {
    day,
    weight: { ...n.weight, done: today.weight_kg !== undefined, notified: firedToday("weight") },
    nutrition: {
      ...n.nutrition,
      done: today.logging === "complete",
      notified: firedToday("nutrition"),
    },
  };
  await writePlan(plan);
  arm(plan);
}

let timer = 0;

/** One timer, set for whichever reminder is due next. */
function arm(plan: Plan): void {
  clearTimeout(timer);
  if (Notification.permission !== "granted") return;

  const next = KINDS.filter((k) => isPending(plan, k))
    .map((k) => ({ kind: k, ms: untilToday(plan[k].time) }))
    .filter((d) => d.ms > 0)
    .sort((a, b) => a.ms - b.ms)[0];
  if (!next) return;

  timer = setTimeout(() => void ring(next.kind, plan.day), next.ms);
}

async function ring(kind: Kind, armedOn: string): Promise<void> {
  // The page can sit open for hours. Re-read rather than trusting the plan the
  // timer was armed with, and say nothing if it has since been dealt with.
  const plan = await readPlan();
  if (!plan || plan.day !== armedOn || !isPending(plan, kind)) return;

  await show(kind, (await navigator.serviceWorker?.ready) ?? null);

  plan[kind].notified = plan.day;
  await writePlan(plan);
  arm(plan); // The other reminder may still be ahead of us.
}

// --------------------------------------------------------------- permission

/**
 * Asked for at the moment a reminder is switched on, which is the only moment
 * the prompt makes sense. Returns what to tell the user, or "" if there is
 * nothing worth saying.
 */
export async function requestReminders(): Promise<string> {
  if (!("Notification" in window)) return "This browser has no notifications.";
  if (Notification.permission === "denied") {
    return "Notifications are blocked for this site. Allow them in browser settings.";
  }
  if (
    Notification.permission !== "granted" &&
    (await Notification.requestPermission()) !== "granted"
  ) {
    return "Notifications were not allowed, so none will be sent.";
  }
  return (await registerPeriodicSync())
    ? ""
    : "Heads up: reminders will only fire while gainz is open. This browser will not wake it in the background.";
}

/**
 * Lets the worker check the plan while the app is shut. Chrome on Android
 * grants this to installed apps on its own judgement of how much the site is
 * used, and picks the interval itself. Everywhere else the call simply fails,
 * which is the answer we want.
 */
async function registerPeriodicSync(): Promise<boolean> {
  try {
    const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      periodicSync?: { register(tag: string, o: { minInterval: number }): Promise<void> };
    };
    if (!reg.periodicSync) return false;
    await reg.periodicSync.register(SYNC_TAG, { minInterval: 30 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}
