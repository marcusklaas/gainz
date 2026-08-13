// Sessions and the strength index. The index's whole claim is that it moves
// only when the lifts move — not when the basket changes — so most of what is
// below is that invariant approached from different sides.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addDays } from "../src/dates.js";
import {
  confirmedSets,
  draftOf,
  e1rmPoints,
  exerciseKey,
  exerciseNames,
  finish,
  fitTotal,
  lastSessionNamed,
  moved,
  newDraft,
  panelFit,
  sessionsOf,
  strengthIndex,
  strengthOf,
  summarise,
  templateNames,
  type DatedSession,
  type LiftPoint,
} from "../src/lifts.js";
import { EPLEY_REPS, type Day, type DayKey, type Draft, type Session } from "../src/types.js";

// --------------------------------------------------------------- fixtures

const close = (actual: number, expected: number, eps = 1e-9, what = "") =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${what || "value"}: expected ${expected} ± ${eps}, got ${actual}`,
  );

const DAY0 = "2026-01-01";
const on = (n: number): DayKey => addDays(DAY0, n);

let nextId = 0;
const session = (
  exercises: Record<string, [weight: number, reps: number][]>,
  over: Partial<Session> = {},
): Session => ({
  id: `s${nextId++}`,
  at: "2026-01-01T18:00:00.000Z",
  exercises: Object.entries(exercises).map(([name, sets]) => ({
    name,
    sets: sets.map(([weight_kg, reps]) => ({ weight_kg, reps })),
  })),
  ...over,
});

const dated = (day: DayKey, s: Session): DatedSession => ({ day, session: s });

const epley = (weight: number, reps: number) => weight * (1 + reps / EPLEY_REPS);

/** A lift point straight from a level, skipping the session plumbing. */
const point = (day: DayKey, key: string, e1rm: number): LiftPoint => ({
  day,
  key,
  name: key,
  x: Math.log(e1rm),
});

// ----------------------------------------------------------- identity

describe("exerciseKey", () => {
  it("folds the spellings of one movement together", () => {
    const bench = exerciseKey("Bench");
    assert.equal(exerciseKey("bench"), bench);
    assert.equal(exerciseKey("BENCH"), bench);
    assert.equal(exerciseKey("  bench  "), bench);
    assert.equal(exerciseKey("Bench  Press"), exerciseKey("bench press"));
    assert.equal(exerciseKey("Bench-Press"), exerciseKey("bench press"));
    assert.equal(exerciseKey("Bench_Press!"), exerciseKey("bench press"));
  });

  it("keeps genuinely different movements apart", () => {
    assert.notEqual(exerciseKey("bench press"), exerciseKey("incline bench press"));
    assert.notEqual(exerciseKey("row"), exerciseKey("rows"));
  });

  it("keeps digits, which distinguish real variants", () => {
    assert.equal(exerciseKey("Farmer's walk 2x20m"), "farmer s walk 2x20m");
  });

  it("collapses a name of nothing but punctuation to the empty key", () => {
    assert.equal(exerciseKey("---"), "");
  });
});

// ------------------------------------------------------------- history

describe("sessionsOf", () => {
  it("returns every session, newest day first", () => {
    const days = new Map<DayKey, Day>([
      [on(0), { items: [], sessions: [session({ bench: [[100, 5]] }, { name: "Push" })] }],
      [on(5), { items: [], sessions: [session({ row: [[80, 5]] }, { name: "Pull" })] }],
      [on(2), { items: [] }],
    ]);
    assert.deepEqual(
      sessionsOf(days).map((s) => s.day),
      [on(5), on(0)],
    );
  });

  it("lets the day dominate the stamp", () => {
    // A session typed in days after the fact carries the stamp of when it was
    // entered, not of the day it belongs to. History is ordered by the day it
    // happened; the stamp only ever breaks ties within one day.
    const days = new Map<DayKey, Day>([
      [
        on(0),
        // Trained on the 1st, but only logged on the 5th.
        { items: [], sessions: [session({ a: [[1, 1]] }, { at: "2026-01-05T23:00:00.000Z", name: "older" })] },
      ],
      [
        on(1),
        { items: [], sessions: [session({ a: [[1, 1]] }, { at: "2026-01-02T06:00:00.000Z", name: "newer" })] },
      ],
    ]);
    assert.deepEqual(
      sessionsOf(days).map((s) => s.session.name),
      ["newer", "older"],
    );
  });

  it("orders sessions within one day by their stamp, newest first", () => {
    const days = new Map<DayKey, Day>([
      [
        on(0),
        {
          items: [],
          sessions: [
            session({ a: [[1, 1]] }, { at: "2026-01-01T08:00:00.000Z", name: "morning" }),
            session({ a: [[1, 1]] }, { at: "2026-01-01T18:00:00.000Z", name: "evening" }),
          ],
        },
      ],
    ]);
    assert.deepEqual(
      sessionsOf(days).map((s) => s.session.name),
      ["evening", "morning"],
    );
  });

  it("is empty when nothing was trained", () => {
    assert.deepEqual(sessionsOf(new Map([[on(0), { items: [] }]])), []);
  });
});

describe("templateNames", () => {
  it("lists each name once, most recently used first, in its newest spelling", () => {
    const list = [
      dated(on(9), session({ a: [[1, 1]] }, { name: "PUSH" })),
      dated(on(8), session({ a: [[1, 1]] }, { name: "Pull" })),
      dated(on(7), session({ a: [[1, 1]] }, { name: "push" })),
    ];
    assert.deepEqual(templateNames(list), ["PUSH", "Pull"]);
  });

  it("skips unnamed one-offs", () => {
    const list = [dated(on(9), session({ a: [[1, 1]] })), dated(on(8), session({ a: [[1, 1]] }, { name: "Push" }))];
    assert.deepEqual(templateNames(list), ["Push"]);
  });
});

describe("exerciseNames", () => {
  it("lists movements most recently performed first, deduped across spellings", () => {
    const list = [
      dated(on(9), session({ "Bench Press": [[100, 5]], Dips: [[0, 10]] })),
      dated(on(8), session({ "bench press": [[95, 5]], Row: [[80, 5]] })),
    ];
    assert.deepEqual(exerciseNames(list), ["Bench Press", "Dips", "Row"]);
  });
});

describe("lastSessionNamed", () => {
  const list = [
    dated(on(9), session({ bench: [[105, 5]] }, { id: "new", name: "Push" })),
    dated(on(7), session({ bench: [[100, 5]] }, { id: "old", name: "push  PRESS" })),
    dated(on(6), session({ bench: [[95, 5]] }, { id: "older", name: "Push" })),
  ];

  it("finds the most recent session of that name", () => {
    assert.equal(lastSessionNamed(list, "push")!.id, "new");
  });

  it("matches on the normalised name", () => {
    assert.equal(lastSessionNamed(list, "Push Press")!.id, "old");
  });

  it("skips the session being edited, so it cannot prefill from itself", () => {
    assert.equal(lastSessionNamed(list, "Push", "new")!.id, "older");
  });

  it("is null when no session carries the name", () => {
    assert.equal(lastSessionNamed(list, "Legs"), null);
  });
});

// -------------------------------------------------------------- drafts

describe("newDraft", () => {
  it("starts empty when there is nothing to prefill from", () => {
    const d = newDraft(on(1), "2026-01-02T18:00:00.000Z", "Push", null);
    assert.deepEqual(d.exercises, []);
    assert.equal(d.name, "Push");
    assert.equal(d.day, on(1));
  });

  it("prefills last session's numbers as unconfirmed ghosts", () => {
    const from = session({ bench: [[100, 5], [100, 4]] });
    const d = newDraft(on(1), "2026-01-02T18:00:00.000Z", "Push", from);
    assert.deepEqual(d.exercises, [
      { name: "bench", sets: [{ weight_kg: 100, reps: 5 }, { weight_kg: 100, reps: 4 }] },
    ]);
    // Nothing is `done`: they are a question, not an answer.
    assert.equal(confirmedSets(d), 0);
    assert.equal(finish(d), null);
  });
});

describe("draftOf", () => {
  it("opens a stored session with everything already confirmed", () => {
    const s = session({ bench: [[100, 5]], row: [[80, 8]] }, { name: "Push" });
    const d = draftOf(on(1), s);
    assert.equal(d.id, s.id);
    assert.equal(d.at, s.at);
    assert.equal(confirmedSets(d), 2);
  });

  it("gives an unnamed session an empty name rather than undefined", () => {
    assert.equal(draftOf(on(1), session({ bench: [[100, 5]] })).name, "");
  });

  it("round-trips: opening a session and finishing it changes nothing", () => {
    const s = session({ bench: [[100, 5], [100, 4]], row: [[80, 8]] }, { name: "Push" });
    assert.deepEqual(finish(draftOf(on(1), s)), s);
  });
});

describe("finish", () => {
  const draft = (exercises: Draft["exercises"], name = ""): Draft => ({
    day: on(1),
    id: "d1",
    at: "2026-01-02T18:00:00.000Z",
    name,
    exercises,
  });

  it("drops unconfirmed sets and strips the flag", () => {
    const s = finish(
      draft([
        {
          name: "bench",
          sets: [
            { weight_kg: 100, reps: 5, done: true },
            { weight_kg: 100, reps: 5 },
          ],
        },
      ]),
    )!;
    assert.deepEqual(s.exercises, [{ name: "bench", sets: [{ weight_kg: 100, reps: 5 }] }]);
  });

  it("drops an exercise left with no confirmed sets", () => {
    const s = finish(
      draft([
        { name: "bench", sets: [{ weight_kg: 100, reps: 5, done: true }] },
        { name: "row", sets: [{ weight_kg: 80, reps: 8 }] },
      ]),
    )!;
    assert.deepEqual(s.exercises.map((e) => e.name), ["bench"]);
  });

  it("is null when nothing was confirmed — the same as no session at all", () => {
    assert.equal(finish(draft([{ name: "bench", sets: [{ weight_kg: 100, reps: 5 }] }])), null);
    assert.equal(finish(draft([])), null);
  });

  it("trims the name and omits it entirely when blank", () => {
    const sets = [{ weight_kg: 100, reps: 5, done: true }];
    assert.equal(finish(draft([{ name: "bench", sets }], "  Push  "))!.name, "Push");
    assert.ok(!("name" in finish(draft([{ name: "bench", sets }], "   "))!));
  });
});

describe("moved", () => {
  const list = ["a", "b", "c", "d"];

  it("moves forwards and backwards", () => {
    assert.deepEqual(moved(list, 0, 2), ["b", "c", "a", "d"]);
    assert.deepEqual(moved(list, 3, 1), ["a", "d", "b", "c"]);
  });

  it("returns the list untouched for a no-op or an out-of-range index", () => {
    for (const [from, to] of [[1, 1], [-1, 2], [0, 9], [9, 0], [0, -1]] as const) {
      assert.equal(moved(list, from, to), list, `${from} -> ${to} should be the same array`);
    }
  });

  it("does not mutate its input", () => {
    moved(list, 0, 3);
    assert.deepEqual(list, ["a", "b", "c", "d"]);
  });
});

describe("summarise", () => {
  it("counts exercises and sets, with the plurals right", () => {
    assert.equal(summarise(session({ bench: [[100, 5]] })), "1 exercise · 1 set");
    assert.equal(
      summarise(session({ bench: [[100, 5], [100, 5]], row: [[80, 8]] })),
      "2 exercises · 3 sets",
    );
  });
});

// ------------------------------------------------------------- e1RM

describe("e1rmPoints", () => {
  it("uses the Epley e1RM of the best set, not the last or the average", () => {
    const list = [dated(on(0), session({ bench: [[60, 10], [100, 5], [80, 5]] }))];
    const [p] = e1rmPoints(list);
    close(Math.exp(p!.x), epley(100, 5), 1e-9);
  });

  it("compares sets by e1RM rather than by weight", () => {
    // 90×8 is a better set than 100×3: 114 against 110.
    const list = [dated(on(0), session({ bench: [[100, 3], [90, 8]] }))];
    close(Math.exp(e1rmPoints(list)[0]!.x), epley(90, 8), 1e-9);
  });

  it("ignores sets with no load and sets with no reps", () => {
    const list = [dated(on(0), session({ dips: [[0, 12], [20, 6]] }))];
    close(Math.exp(e1rmPoints(list)[0]!.x), epley(20, 6), 1e-9);

    const noReps = [dated(on(0), session({ bench: [[100, 0]] }))];
    assert.deepEqual(e1rmPoints(noReps), []);
  });

  it("drops an exercise with no usable set at all", () => {
    const list = [dated(on(0), session({ dips: [[0, 12]], bench: [[100, 5]] }))];
    assert.deepEqual(e1rmPoints(list).map((p) => p.key), ["bench"]);
  });

  it("emits one point per exercise per day, taking the better of two sessions", () => {
    const list = [
      dated(on(0), session({ bench: [[100, 5]] }, { at: "2026-01-01T08:00:00.000Z" })),
      dated(on(0), session({ bench: [[110, 5]] }, { at: "2026-01-01T18:00:00.000Z" })),
    ];
    const points = e1rmPoints(list);
    assert.equal(points.length, 1);
    close(Math.exp(points[0]!.x), epley(110, 5), 1e-9);
  });

  it("keeps that rule when the better session came first", () => {
    const list = [
      dated(on(0), session({ bench: [[110, 5]] }, { at: "2026-01-01T08:00:00.000Z" })),
      dated(on(0), session({ bench: [[100, 5]] }, { at: "2026-01-01T18:00:00.000Z" })),
    ];
    close(Math.exp(e1rmPoints(list)[0]!.x), epley(110, 5), 1e-9);
  });

  it("folds spellings onto one key while keeping a name for display", () => {
    const list = [dated(on(0), session({ "Bench Press": [[100, 5]] }))];
    const [p] = e1rmPoints(list);
    assert.equal(p!.key, "bench press");
    assert.equal(p!.name, "Bench Press");
  });

  it("comes out oldest first whatever order the sessions arrive in", () => {
    const list = [
      dated(on(5), session({ bench: [[100, 5]] })),
      dated(on(1), session({ bench: [[95, 5]] })),
      dated(on(3), session({ row: [[80, 5]] })),
    ];
    assert.deepEqual(e1rmPoints(list).map((p) => p.day), [on(1), on(3), on(5)]);
  });
});

// --------------------------------------------------------------- index

describe("strengthIndex", () => {
  it("starts at zero — the level is defined only up to a constant", () => {
    const points = [point(on(0), "bench", 120), point(on(7), "bench", 126)];
    assert.equal(strengthIndex(points)[0]!.x, 0);
  });

  it("is empty on no points", () => {
    assert.deepEqual(strengthIndex([]), []);
  });

  it("reports a uniform proportional gain as its log", () => {
    // Both lifts up 5% over a week: the basket is up 5%, and log(1.05) is the
    // level whatever the individual weights were.
    const points = [
      point(on(0), "bench", 120),
      point(on(0), "row", 90),
      point(on(7), "bench", 126),
      point(on(7), "row", 94.5),
    ];
    const index = strengthIndex(points);
    assert.equal(index.length, 2);
    close(index[1]!.x, Math.log(1.05), 1e-12);
  });

  it("is unmoved by an exercise appearing for the first time", () => {
    // The invariant the whole design turns on: a new lift can join the index,
    // never move it — however heavy or light it is on arrival.
    const base = [
      point(on(0), "bench", 120),
      point(on(7), "bench", 126),
      point(on(14), "bench", 130),
    ];
    const expected = strengthIndex(base).map((p) => p.x);

    for (const level of [1, 500]) {
      const withNewcomer = strengthIndex([...base, point(on(14), "deadlift", level)]);
      assert.deepEqual(withNewcomer.map((p) => p.x), expected, `newcomer at ${level} moved the index`);
    }
  });

  it("is unmoved by an exercise leaving", () => {
    // Dropping a lift stops it contributing; it cannot subtract on the way out.
    const points = [
      point(on(0), "bench", 120),
      point(on(0), "row", 90),
      point(on(7), "bench", 126),
      point(on(7), "row", 94.5),
      point(on(14), "bench", 132.3), // row never comes back
    ];
    const index = strengthIndex(points);
    close(index[2]!.x, Math.log(1.05) * 2, 1e-12);
  });

  it("pools exercises trained on different cadences by the time each covers", () => {
    // bench every 7 days, row every 14. Both improving at the same log rate, so
    // the pooled rate is that rate and the index is a straight line.
    const rate = Math.log(1.01) / 7;
    const points: LiftPoint[] = [];
    for (const d of [0, 7, 14, 21, 28]) points.push(point(on(d), "bench", Math.exp(rate * d) * 120));
    for (const d of [0, 14, 28]) points.push(point(on(d), "row", Math.exp(rate * d) * 90));
    points.sort((a, b) => a.day.localeCompare(b.day));

    const index = strengthIndex(points);
    for (const p of index) {
      const elapsed = (Date.parse(p.day) - Date.parse(on(0))) / 864e5;
      close(p.x, rate * elapsed, 1e-12, `level on ${p.day}`);
    }
  });

  it("never revises a past level when a new day is logged", () => {
    const points = [
      point(on(0), "bench", 120),
      point(on(7), "bench", 126),
      point(on(14), "bench", 130),
      point(on(21), "bench", 118),
    ];
    for (let n = 1; n <= points.length; n++) {
      const prefix = strengthIndex(points.slice(0, n));
      const full = strengthIndex(points).slice(0, prefix.length);
      assert.deepEqual(prefix, full, `history changed under ${n} points`);
    }
  });

  it("goes down when the lifts go down", () => {
    const points = [point(on(0), "bench", 120), point(on(7), "bench", 114)];
    assert.ok(strengthIndex(points)[1]!.x < 0);
  });

  it("emits one point per training day", () => {
    const points = [
      point(on(0), "bench", 120),
      point(on(0), "row", 90),
      point(on(7), "bench", 126),
    ];
    assert.deepEqual(strengthIndex(points).map((p) => p.day), [on(0), on(7)]);
  });
});

// ----------------------------------------------------------- the fit

describe("panelFit", () => {
  /** Every exercise on a common rate, each from its own level. */
  const panel = (rate: number, days: number[], levels: Record<string, number>): LiftPoint[] =>
    days.flatMap((d) =>
      Object.entries(levels).map(([key, base]) => point(on(d), key, base * Math.exp(rate * d))),
    );

  it("recovers a common rate exactly, whatever the levels", () => {
    const rate = 0.002;
    const f = panelFit(panel(rate, [0, 7, 14, 21], { bench: 120, row: 90, squat: 160 }), 42)!;
    close(f.perDay, rate, 1e-12, "rate");
    close(f.stdErrPerDay, 0, 1e-12, "stderr");
    assert.equal(f.points, 12);
    assert.equal(f.exercises, 3);
    assert.equal(f.windowDays, 42);
  });

  it("absorbs each exercise's own level, so adding one cannot inflate the rate", () => {
    const rate = 0.002;
    const two = panelFit(panel(rate, [0, 7, 14, 21], { bench: 120, row: 90 }), 42)!;
    const three = panelFit(panel(rate, [0, 7, 14, 21], { bench: 120, row: 90, squat: 300 }), 42)!;
    close(three.perDay, two.perDay, 1e-12);
  });

  it("drops an exercise seen only once, which informs no within-exercise change", () => {
    const points = [...panel(0.002, [0, 7, 14], { bench: 120 }), point(on(7), "cameo", 200)];
    const f = panelFit(points, 42)!;
    assert.equal(f.exercises, 1);
    assert.equal(f.points, 3);
  });

  it("is null when there is nothing left to fit", () => {
    assert.equal(panelFit([], 42), null);
    // One exercise, two points: the intercept and the slope use both up.
    assert.equal(panelFit(panel(0.002, [0, 7], { bench: 120 }), 42), null);
    // Nothing but singletons.
    assert.equal(panelFit([point(on(0), "a", 100), point(on(0), "b", 90)], 42), null);
  });

  it("is null when every point falls on one day", () => {
    const sameDay = [
      point(on(0), "bench", 120),
      point(on(0), "bench", 125),
      point(on(0), "row", 90),
      point(on(0), "row", 95),
    ];
    assert.equal(panelFit(sameDay, 42), null);
  });

  it("reports a real error bar when the exercises disagree", () => {
    const points = [
      point(on(0), "bench", 120),
      point(on(7), "bench", 126),
      point(on(14), "bench", 124),
      point(on(0), "row", 90),
      point(on(7), "row", 89),
      point(on(14), "row", 96),
    ];
    const f = panelFit(points, 42)!;
    assert.ok(f.stdErrPerDay > 0, "disagreeing series must not report certainty");
  });

  it("finds no trend in a flat panel", () => {
    const f = panelFit(panel(0, [0, 7, 14, 21], { bench: 120, row: 90 }), 42)!;
    close(f.perDay, 0, 1e-12);
  });
});

describe("fitTotal", () => {
  const fit = (perDay: number, stdErrPerDay: number) => ({
    perDay,
    stdErrPerDay,
    points: 12,
    exercises: 3,
    windowDays: 42,
  });

  it("compounds the rate over the window", () => {
    close(fitTotal(fit(0.002, 0)), Math.exp(0.084) - 1, 1e-12);
    close(fitTotal(fit(0, 0)), 0, 1e-12);
  });

  it("walks the interval out with sigmas, symmetrically around the estimate", () => {
    const f = fit(0.002, 0.0005);
    const lo = fitTotal(f, -2);
    const hi = fitTotal(f, 2);
    assert.ok(lo < fitTotal(f) && fitTotal(f) < hi);
    close(Math.log(1 + lo), (0.002 - 0.001) * 42, 1e-12);
    close(Math.log(1 + hi), (0.002 + 0.001) * 42, 1e-12);
  });
});

// ------------------------------------------------------------ together

describe("strengthOf", () => {
  const list = [0, 7, 14, 21, 28, 35].map((d) =>
    dated(on(d), session({ bench: [[100 + d, 5]], row: [[80 + d, 5]] })),
  );

  it("indexes the whole history but fits only the window", () => {
    const s = strengthOf(list, on(35), 14);
    assert.equal(s.index.length, 6, "the chart shows everything");
    // on(21), on(28), on(35) are within fourteen days of on(35).
    assert.equal(s.fit!.points, 6);
    assert.equal(s.fit!.exercises, 2);
    assert.equal(s.fit!.windowDays, 14);
  });

  it("bounds the window at the top as well as the bottom", () => {
    // Days after `today` exist while browsing back through history, and a window
    // open at the top would answer about a different stretch than it names.
    const past = strengthOf(list, on(14), 14);
    // on(0), on(7) and on(14) — two exercises each. The three later days the
    // list also holds are on the far side of `today` and must not be fitted.
    assert.equal(past.fit!.points, 6);
    assert.notEqual(past.fit!.perDay, strengthOf(list, on(35), 14).fit!.perDay);
    // The index is not windowed: the chart still shows the whole history.
    assert.equal(past.index.length, 6);
  });

  it("has no verdict before there is enough to fit one", () => {
    assert.equal(strengthOf(list.slice(0, 1), on(0), 42).fit, null);
    assert.equal(strengthOf([], on(0), 42).fit, null);
    assert.deepEqual(strengthOf([], on(0), 42).index, []);
  });

  it("agrees with its parts", () => {
    const s = strengthOf(list, on(35), 42);
    assert.deepEqual(s.index, strengthIndex(e1rmPoints(list)));
    assert.ok(s.fit!.perDay > 0, "a history of adding weight every week is progress");
  });
});
