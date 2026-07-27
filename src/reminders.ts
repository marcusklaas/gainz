// Everything both halves of the reminder system need, in one place.
//
// A static site has no push server, so nothing here can promise a notification
// at a given minute. There are two best-effort paths and they read the same
// plan out of the same cache:
//
//   - while a tab or the installed app is open, an ordinary timer (notify.ts);
//   - while it is closed, periodic background sync, which Chrome on Android
//     wakes at its own discretion for installed apps — and which does not
//     exist on iOS or in a plain browser tab (sw.js).
//
// The plan lives in the Cache API because that is the only store both the page
// and the service worker can reach. This module used to be duplicated by hand
// into sw.js — the shape, the two cache names, the wording, and a copy of the
// date helpers — on the belief that a worker cannot import from the module
// tree. It can, once registered with { type: "module" }, which is what removes
// the copy and the obligation to keep the two in step.
import { todayKey } from "./dates.js";
import type { DayKey, Reminder } from "./types.js";

export const PLAN_CACHE = "gainz-plan";
export const PLAN_URL = "./notification-plan";
export const SYNC_TAG = "gainz-reminders";

export const KINDS = ["weight", "nutrition"] as const;
export type Kind = (typeof KINDS)[number];

const TEXT: Record<Kind, { title: string; body: string }> = {
  weight: { title: "Weigh-in", body: "No weight logged today yet." },
  nutrition: { title: "Food log", body: "Today has not been ticked off as fully logged." },
};

export interface Slot extends Reminder {
  /** Whether the thing being nudged about has already happened. */
  done: boolean;
  /** The day this slot last fired on, so neither path repeats itself. */
  notified?: DayKey;
}

export interface Plan {
  day: DayKey;
  weight: Slot;
  nutrition: Slot;
}

export async function readPlan(): Promise<Plan | null> {
  try {
    const hit = await caches.match(PLAN_URL, { cacheName: PLAN_CACHE });
    return hit ? ((await hit.json()) as Plan) : null;
  } catch {
    return null; // No Cache API, or a private window that refuses it.
  }
}

export async function writePlan(p: Plan): Promise<void> {
  const cache = await caches.open(PLAN_CACHE);
  const body = new Response(JSON.stringify(p), {
    headers: { "content-type": "application/json" },
  });
  await cache.put(PLAN_URL, body);
}

/** Switched on, not yet done, and not already said today. */
export const isPending = (p: Plan, k: Kind): boolean =>
  p[k].enabled && !p[k].done && p[k].notified !== p.day;

/** Milliseconds from now until "HH:MM" on today's local clock; negative once past. */
export function untilToday(time: string): number {
  const [h, m] = time.split(":").map(Number);
  const at = new Date();
  at.setHours(h ?? 0, m ?? 0, 0, 0);
  return at.getTime() - Date.now();
}

export async function show(kind: Kind, reg: ServiceWorkerRegistration | null): Promise<void> {
  const { title, body } = TEXT[kind];
  const options = {
    body,
    tag: `gainz-${kind}`,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
  };
  // Android only shows notifications the worker owns; the constructor is for
  // desktop browsers, where there may be no worker at all.
  if (reg) await reg.showNotification(title, options);
  else new Notification(title, options);
}

/**
 * A plan left over from an earlier day still carries the right settings, and a
 * day the app has not been opened on has by definition logged nothing — which
 * is exactly when the nudge is worth the most. So roll it forward rather than
 * giving up on it. True when anything changed.
 */
export function rollForward(plan: Plan, day: DayKey): boolean {
  if (plan.day === day) return false;
  plan.day = day;
  for (const kind of KINDS) {
    plan[kind].done = false;
    delete plan[kind].notified;
  }
  return true;
}

/**
 * The background path: roll the plan forward, then say whatever is due. Called
 * by the worker on a periodicsync wake, which is the only time it runs.
 */
export async function checkReminders(reg: ServiceWorkerRegistration): Promise<void> {
  const plan = await readPlan();
  if (!plan) return; // The app has not been opened since reminders were set up.

  const day = todayKey();
  let changed = rollForward(plan, day);

  for (const kind of KINDS) {
    if (!isPending(plan, kind) || untilToday(plan[kind].time) > 0) continue;
    await show(kind, reg);
    plan[kind].notified = day;
    changed = true;
  }

  if (changed) await writePlan(plan);
}
