// Shared DOM lookup, inline status messages, and tiny display helpers used by
// every screen module.

/** "lift" is the session editor. It has no nav button — it is reached by
 *  starting or opening a session, and leaves by going back to the list. */
export type Screen = "today" | "lifts" | "lift" | "trend" | "settings";

export const DASH = "—";

export const round = (n: number): string => String(Math.round(n));

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

export const val = (id: string): string => $<HTMLInputElement>(id).value.trim();
export const num = (id: string): number => Number($<HTMLInputElement>(id).value);
export const checked = (id: string): boolean => $<HTMLInputElement>(id).checked;

/** Pending flash() clears, one per element, so a new message cancels the old
 *  one's timer instead of being wiped by it. */
const clears = new Map<string, number>();

export function msg(id: string, text: string, kind: "ok" | "err" | "" = ""): void {
  clearTimeout(clears.get(id));
  clears.delete(id);
  const e = $(id);
  e.textContent = text;
  e.className = `msg ${kind}`;
}

/** Confirmation that has been read once it has been seen. Left up, a "Saved."
 *  from an hour ago still reads as news about whatever was just typed. */
export function flash(id: string, text: string, kind: "ok" | "err" = "ok"): void {
  msg(id, text, kind);
  clears.set(id, setTimeout(() => msg(id, ""), 4000));
}
