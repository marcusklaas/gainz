// Two daily reminders: weigh in, and tick the day off.
//
// A static site has no push server, so nothing here can promise a notification
// at a given minute. There are two best-effort paths and they read the same
// plan:
//
//   - while a tab or the installed app is open, an ordinary timer;
//   - while it is closed, periodic background sync, which Chrome on Android
//     wakes at its own discretion for installed apps — and which does not
//     exist on iOS or in a plain browser tab.
//
// The plan lives in the Cache API rather than localStorage because that is the
// only store both the page and the service worker can reach. sw.js reads the
// same shape and the same two strings; the pair is kept in step by hand.
import { todayKey } from "./dates.js";
import type { Config, Day, DayKey, Notifications, Reminder } from "./types.js";

const PLAN_CACHE = "gainz-plan";
const PLAN_URL = "./notification-plan";
const SYNC_TAG = "gainz-reminders";

export type Kind = "weight" | "nutrition";

const KINDS = ["weight", "nutrition"] as const;

const TEXT: Record<Kind, { title: string; body: string }> = {
  weight: { title: "Weigh-in", body: "No weight logged today yet." },
  nutrition: { title: "Food log", body: "Today has not been ticked off as fully logged." },
};

interface Slot extends Reminder {
  /** Whether the thing being nudged about has already happened. */
  done: boolean;
  /** The day this slot last fired on, so neither path repeats itself. */
  notified?: DayKey;
}

interface Plan {
  day: DayKey;
  weight: Slot;
  nutrition: Slot;
}

/** Off, because a reminder nobody asked for is worse than no reminder. */
export function defaultNotifications(): Notifications {
  return {
    weight: { enabled: false, time: "08:00" },
    nutrition: { enabled: false, time: "21:00" },
  };
}

/** Reads the block out of a config, tolerating one written before it existed. */
export function notificationsOf(cfg: Config | null): Notifications {
  const d = defaultNotifications();
  const n = cfg?.notifications;
  return {
    weight: { ...d.weight, ...n?.weight },
    nutrition: { ...d.nutrition, ...n?.nutrition },
  };
}

// ------------------------------------------------------------------- the plan

async function readPlan(): Promise<Plan | null> {
  try {
    const hit = await caches.match(PLAN_URL, { cacheName: PLAN_CACHE });
    return hit ? ((await hit.json()) as Plan) : null;
  } catch {
    return null; // No Cache API, or a private window that refuses it.
  }
}

async function writePlan(p: Plan): Promise<void> {
  const cache = await caches.open(PLAN_CACHE);
  const body = new Response(JSON.stringify(p), {
    headers: { "content-type": "application/json" },
  });
  await cache.put(PLAN_URL, body);
}

const isPending = (p: Plan, k: Kind) => p[k].enabled && !p[k].done && p[k].notified !== p.day;

/**
 * Rebuilds the plan from today's data and re-arms the timer. Idempotent and
 * cheap, so it simply runs after every render — which is what makes a reminder
 * go quiet the moment the weight is saved or the box is ticked.
 */
export async function updatePlan(cfg: Config | null, today: Day): Promise<void> {
  if (!("Notification" in window) || !("caches" in window)) return;

  const day = todayKey();
  const n = notificationsOf(cfg);
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

// ------------------------------------------------------------------ in-page

let timer = 0;

/** Milliseconds from now until "HH:MM" on today's local clock; negative once past. */
function untilToday(time: string): number {
  const [h, m] = time.split(":").map(Number);
  const at = new Date();
  at.setHours(h ?? 0, m ?? 0, 0, 0);
  return at.getTime() - Date.now();
}

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

async function ring(kind: Kind, armedOn: DayKey): Promise<void> {
  // The page can sit open for hours. Re-read rather than trusting the plan the
  // timer was armed with, and say nothing if it has since been dealt with.
  const plan = await readPlan();
  if (!plan || plan.day !== armedOn || !isPending(plan, kind)) return;

  const { title, body } = TEXT[kind];
  const options = {
    body,
    tag: `gainz-${kind}`,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
  };
  // Android only shows notifications the worker owns; the constructor is for
  // desktop browsers, where there may be no worker at all.
  const reg = await navigator.serviceWorker?.ready;
  if (reg) await reg.showNotification(title, options);
  else new Notification(title, options);

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
