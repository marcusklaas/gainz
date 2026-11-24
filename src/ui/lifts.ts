// Two screens: the list of what has been done, and the editor for one session.
// The editor is not a tab because it is not a place — it is a session, opened
// from the list and left when it is saved or thrown away.
//
// Nothing here writes to the repo until Save. Until then the whole session is a
// draft in localStorage, which is what makes leaving mid-workout free: there is
// no unsaved state in memory to warn about, and the list offers to resume.
import { addDays, atTime, byAt, humanDay, nowStamp, todayKey } from "../core/dates.js";
import { $, flash, msg, val, type Screen } from "./dom.js";
import {
  confirmedSets,
  draftOf,
  elapsedSec,
  exerciseKey,
  exerciseNames,
  finish,
  formatDuration,
  lastSessionNamed,
  moved,
  newDraft,
  nextUpIndex,
  propagateWeight,
  sessionsOf,
  summarise,
  templateNames,
  type DatedSession,
} from "../core/lifts.js";
import {
  cachedConfig,
  clearDraft,
  readDraft,
  readRange,
  updateDay,
  writeDraft,
  type Source,
} from "../services/store.js";
import type { DayKey, Draft } from "../core/types.js";

/** The window Lifts reads, kept in step with the estimator's own history so the
 *  months are already fetched and the screen costs no extra requests. */
const historyDays = () => cachedConfig()?.estimator.historyDays ?? 180;

/** Sessions in that window, newest first. Re-read whenever one is written. */
let sessions: DatedSession[] = [];

async function loadSessions(src: Source = "cache"): Promise<void> {
  const today = todayKey();
  sessions = sessionsOf(await readRange(addDays(today, -historyDays()), today, src));
}

/**
 * Two ways into the editor, and they are deliberately not the same thing.
 *
 * A session in progress is a `draft`: mirrored to localStorage on every change,
 * offered as "resume" on the list, and outliving the screen and the app itself.
 * A workout is logged over an hour with the phone going in and out of a pocket,
 * so nothing about leaving may cost anything.
 *
 * A past session opened from the list is an `edit`: held in memory and nowhere
 * else. It is already saved, so there is nothing to protect it from — backing
 * out by any route drops the changes, which is what leaving an edit without
 * saving means everywhere else. Keeping the two apart is also what stops an
 * edit from presenting itself as the session you are currently doing, and what
 * lets one be opened mid-workout without the session in progress noticing.
 */
let draft: Draft | null = null;
let edit: Draft | null = null;

/** Whichever of the two the editor is showing. */
const current = (): Draft | null => edit ?? draft;

let showScreen: (name: Screen) => void = () => {};

/** Ends an in-memory edit of a past session when leaving the editor screen. */
export function clearEdit(): void {
  edit = null;
}

function editDraft(fn: (d: Draft) => void): void {
  const d = current();
  if (!d) return;
  fn(d);
  if (d === draft) writeDraft(d);
  renderEditor();
}

export async function renderLifts(): Promise<void> {
  await loadSessions();
  draft ??= readDraft();

  const names = templateNames(sessions);
  const chips = $("templates");
  chips.replaceChildren();
  for (const name of [...names, ""]) {
    const b = document.createElement("button");
    b.textContent = name || "Blank";
    b.className = name ? "chip" : "chip blank";
    b.addEventListener("click", () => start(name));
    chips.append(b);
  }

  // One or the other. Offering to start a second session while one is open is
  // the only way to lose a draft, so the offer is simply not made.
  const resume = $<HTMLButtonElement>("lift-resume");
  $("lift-new").hidden = draft !== null;
  resume.hidden = draft === null;
  // Only ever a session in progress, and so only ever one wording: a draft is
  // now something you started and have not finished, never a past session you
  // happened to open.
  if (draft) {
    const live = formatDuration(elapsedSec(draft.at, Date.now()) ?? undefined);
    resume.textContent =
      `Resume — ${draft.name || "Unnamed session"} · started ${atTime(draft.at)}` +
      (live ? ` · ${live} so far` : "");
  }

  const ul = $("sessions");
  ul.replaceChildren();
  for (const { day: on, session } of sessions) {
    const li = document.createElement("li");
    const row = document.createElement("button");
    row.className = "row";

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = humanDay(on);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = session.name ?? "Unnamed";

    const sum = document.createElement("span");
    sum.className = "macros";
    sum.textContent = summarise(session);

    row.append(when, name, sum);
    row.addEventListener("click", () => open(on, session.id));
    li.append(row);
    ul.append(li);
  }

  $("lifts-note").textContent = sessions.length
    ? `Last ${historyDays()} days.`
    : "No sessions yet. Start one above — name it, and the name becomes a template.";
}

function start(name: string): void {
  const from = name ? lastSessionNamed(sessions, name) : null;
  draft = newDraft(todayKey(), nowStamp(), name, from);
  writeDraft(draft);
  enter();
}

/**
 * Always a fresh read from history rather than anything held over. Nothing an
 * edit does is kept once it is left, so there is never a newer copy to prefer —
 * which is exactly why opening one no longer has to refuse while a session is
 * in progress.
 */
function open(on: DayKey, id: string): void {
  const found = sessions.find((s) => s.day === on && s.session.id === id);
  if (!found) return;
  edit = draftOf(on, found.session);
  enter();
}

/** Opens the editor on whichever of the two is now set. */
function enter(): void {
  const d = current();
  if (!d) return;
  $<HTMLInputElement>("l-name").value = d.name;
  msg("lift-msg", "");
  showScreen("lift");
  renderEditor();
}

/**
 * The set grid. Rebuilt whole on every change, which is what the items list
 * does and is affordable at this size — and the two inputs worth keeping focus
 * in, the session name and the add-exercise box, live outside it in the markup.
 */
function renderEditor(): void {
  const d = current();
  if (!d) return;

  // An edit is a session that already ended: without a stored duration its
  // length is unknown, not still accruing. Only the session in progress
  // (no edit open) gets a live "so far".
  const stored = formatDuration(d.duration_s);
  const live =
    !stored && edit === null ? formatDuration(elapsedSec(d.at, Date.now()) ?? undefined) : null;
  $("lift-when").textContent =
    `${humanDay(d.day)} · started ${atTime(d.at)}` +
    (stored ? ` · ${stored}` : live ? ` · ${live} so far` : "");
  // Delete removes the session from the repo and so is only ever offered for one
  // that is in it. Discard says which of the two it throws away, because in an
  // edit it sits next to Delete and the difference is the whole point.
  $<HTMLButtonElement>("l-delete").hidden = edit === null;
  $("l-discard").textContent = edit ? "Discard changes" : "Discard";

  const list = $("l-exercises");
  list.replaceChildren();

  d.exercises.forEach((ex, ei) => {
    const block = document.createElement("div");
    block.className = "exercise";

    const head = document.createElement("h3");
    const title = document.createElement("span");
    title.className = "ex-name";
    title.textContent = ex.name;
    const drop = document.createElement("button");
    drop.textContent = "×";
    drop.title = "Remove exercise";
    drop.addEventListener("click", () =>
      editDraft((x) => {
        x.exercises.splice(ei, 1);
      }),
    );
    head.append(title, drop);
    block.append(head);

    ex.sets.forEach((set, si) => {
      const row = document.createElement("div");
      // A set that has not been confirmed is last session's number, not this
      // one's. It is shown so it can be agreed with in one tap, and dropped on
      // save if it never was.
      row.className = set.done ? "set" : "set ghost";

      const number = (value: number, step: string, unit: string, apply: (n: number) => void) => {
        const i = document.createElement("input");
        i.type = "number";
        i.inputMode = unit === "kg" ? "decimal" : "numeric";
        i.min = "0";
        i.step = step;
        i.className = unit;
        i.setAttribute("aria-label", unit === "kg" ? "Weight in kilograms" : "Repetitions");
        // Zero shows as empty, which is what a bodyweight set is: no added load.
        i.value = value ? String(value) : "";
        // Typing a number *is* saying you did it that way, so an edit confirms
        // the row. Reps decide, because a set with none did not happen.
        // Confirming a weight also sets it for the sets still to come: the
        // next sets are lifted at this weight far more often than not, so the
        // ghosts after this one follow it and only a set meant to differ needs
        // its own edit.
        i.addEventListener("change", () =>
          editDraft((x) => {
            const raw = Number(i.value);
            const clean = Number.isFinite(raw) && raw > 0 ? (unit === "reps" ? Math.round(raw) : raw) : 0;
            apply(clean);
            set.done = set.reps > 0;
            if (unit === "kg" && set.done) propagateWeight(x.exercises[ei]!, si, set.weight_kg);
          }),
        );
        return i;
      };

      // Same .field pairing the weight and food boxes use: the unit sits beside
      // the input rather than in its placeholder, so it is still there once the
      // box has a number in it — which is the whole of when you need it. Read
      // together the row is the sentence said out loud: "24 kilos times 10".
      const field = (input: HTMLInputElement, text: string) => {
        const wrap = document.createElement("span");
        wrap.className = "field";
        const unit = document.createElement("span");
        unit.className = "unit";
        unit.textContent = text;
        wrap.append(input, unit);
        return wrap;
      };

      const by = document.createElement("span");
      by.className = "by";
      by.textContent = "×";

      const act = document.createElement("button");
      act.textContent = set.done ? "×" : "✓";
      act.title = set.done ? "Remove set" : "Confirm as it stands";
      act.disabled = !set.done && set.reps <= 0;
      act.addEventListener("click", () =>
        editDraft((x) => {
          if (set.done) x.exercises[ei]!.sets.splice(si, 1);
          else set.done = true;
        }),
      );

      row.append(
        field(number(set.weight_kg, "0.5", "kg", (n) => (set.weight_kg = n)), "kg"),
        by,
        field(number(set.reps, "1", "reps", (n) => (set.reps = n)), "reps"),
        act,
      );
      block.append(row);
    });

    const add = document.createElement("button");
    add.className = "add-set";
    add.textContent = "+ set";
    // Cloned from the last row and confirmed on arrival: a set you deliberately
    // added is one you did, and the common case is that it repeats the last.
    add.addEventListener("click", () =>
      editDraft((x) => {
        const sets = x.exercises[ei]!.sets;
        const last = sets[sets.length - 1];
        sets.push({ weight_kg: last?.weight_kg ?? 0, reps: last?.reps ?? 0, done: true });
      }),
    );

    // The arrows share the row rather than taking one of their own, and share it
    // with `+ set` rather than crowding the h3, because both are things done to
    // the exercise as a whole — which is what this row already was. Sized to the
    // same box as the set buttons, they also land in the one right-hand column
    // every other control on this screen keeps to.
    const foot = document.createElement("div");
    foot.className = "ex-foot";
    foot.append(add);

    // An arrow with nowhere to go is not drawn at all, which is also the whole of
    // why a single exercise needs no saying: it is both the first and the last, so
    // both directions fall out and `+ set` takes back the full width.
    for (const dir of [-1, 1] as const) {
      const to = ei + dir;
      if (to < 0 || to >= d.exercises.length) continue;

      const move = document.createElement("button");
      move.className = "move";
      move.textContent = dir < 0 ? "↑" : "↓";
      move.title = dir < 0 ? "Move up" : "Move down";
      move.setAttribute("aria-label", `Move ${ex.name} ${dir < 0 ? "up" : "down"}`);
      move.addEventListener("click", () =>
        editDraft((x) => {
          x.exercises = moved(x.exercises, ei, to);
        }),
      );
      foot.append(move);
    }

    block.append(foot);
    list.append(block);
  });

  const names = exerciseNames(sessions);
  const dl = $("exercise-names");
  dl.replaceChildren();
  for (const name of names) {
    const o = document.createElement("option");
    o.value = name;
    dl.append(o);
  }

  $<HTMLButtonElement>("l-save").disabled = confirmedSets(d) === 0;
}

export function initLifts(deps: {
  show: (name: Screen) => void;
  sync: () => Promise<void>;
  render: (src?: Source) => Promise<void>;
}): void {
  showScreen = deps.show;

  $("lift-resume").addEventListener("click", () => enter());
  $("lift-back").addEventListener("click", () => deps.show("lifts"));

  $("l-name").addEventListener("input", () => {
    // Not through editDraft: the grid does not depend on the name, and rebuilding
    // it under the cursor would be the one place that costs focus mid-word.
    const d = current();
    if (!d) return;
    d.name = $<HTMLInputElement>("l-name").value;
    if (d === draft) writeDraft(d);
  });

  $("l-add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = val("l-exercise");
    if (!name) return;
    ($("l-add-form") as HTMLFormElement).reset();
    // Prefilled from the last time this movement was done in *any* session, not
    // just this template — which is the answer to "what did I lift last time" no
    // matter which day it was on.
    const previous = sessions
      .flatMap((s) => s.session.exercises)
      .find((x) => exerciseKey(x.name) === exerciseKey(name));
    // To the head of the unconfirmed queue, not the foot of the page: the
    // exercise added mid-session is the one about to be done. editDraft redraws
    // synchronously, so the block is in the DOM on return and can be brought
    // into view — otherwise an add from the bottom form would land off-screen
    // and read as lost. Nearest, not centered: no jump when already visible.
    const at = nextUpIndex(current()?.exercises ?? []);
    editDraft((d) => {
      d.exercises.splice(at, 0, {
        name,
        sets: previous
          ? previous.sets.map((s) => ({ weight_kg: s.weight_kg, reps: s.reps }))
          : [{ weight_kg: 0, reps: 0 }],
      });
    });
    $("l-exercises").children[at]?.scrollIntoView({ block: "nearest" });
  });

  $("l-save").addEventListener("click", async () => {
    const d = current();
    if (!d) return;
    const session = finish(d);
    if (!session) return msg("lift-msg", "Confirm at least one set first.", "err");
    // New sessions are stamped with the elapsed wall time; edits keep the
    // duration they opened with. Absent stays absent, so history without it
    // keeps reading as before and a save that cannot measure (legacy stamp,
    // clock skew) writes no duration rather than a zero.
    if (!edit && session.duration_s === undefined) {
      const secs = elapsedSec(d.at, Date.now());
      if (secs !== null) session.duration_s = secs;
    }

    await updateDay(d.day, (x) => {
      const list = x.sessions ?? [];
      const i = list.findIndex((s) => s.id === session.id);
      if (i === -1) list.push(session);
      else list[i] = session;
      x.sessions = list.sort(byAt);
    });
    // Saving an edit finishes nothing: a session left in progress is still in
    // progress afterwards, and show() below is what ends the edit itself.
    if (!edit) {
      clearDraft();
      draft = null;
    }
    // Leave the editor and refresh Trend immediately from cache before pushing
    // to GitHub, so tapping Trend right away sees the new session and a slow
    // network never stalls navigation.
    deps.show("lifts");
    flash("lifts-msg", "Session saved.");
    await deps.render("cache");
    await deps.sync();
  });

  $("l-discard").addEventListener("click", () => {
    // For an edit this throws away the changes only — the session it was opened
    // from stays in the repo, and any session in progress stays in the outbox.
    if (!edit) {
      clearDraft();
      draft = null;
    }
    deps.show("lifts");
  });

  $("l-delete").addEventListener("click", async () => {
    // Hidden unless this is an edit, so it can only ever be a session on disk.
    if (!edit) return;
    const { day: on, id } = edit;
    await updateDay(on, (x) => {
      const left = (x.sessions ?? []).filter((s) => s.id !== id);
      if (left.length) x.sessions = left;
      else delete x.sessions;
    });
    deps.show("lifts");
    flash("lifts-msg", "Session deleted.");
    await deps.render("cache");
    await deps.sync();
  });
}
