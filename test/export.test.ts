// The export document. Most of what is below is about the two ways a context
// document can lie without ever being wrong: counting days that were never
// fully logged, and stamping today's derived numbers on historical rows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withDefaults } from "../src/config.js";
import { addDays } from "../src/dates.js";
import { buildContext, contextFrom, WINDOW } from "../src/export.js";
import type { Config, Day, DayKey, FoodItem, Session } from "../src/types.js";

// --------------------------------------------------------------- fixtures

const TODAY = "2026-08-14"; // a Friday
const on = (n: number): DayKey => addDays(TODAY, n);

const cfg = (over: Partial<Config> = {}): Config => ({ ...withDefaults(null), ...over });

let seq = 0;
const item = (kcal: number, protein: number, name = "porridge", model?: string): FoodItem => ({
  id: `i${seq++}`,
  at: `2026-08-14T08:0${seq % 10}:00.000Z`,
  name,
  kcal,
  protein_g: protein,
  ...(model ? { model } : {}),
});

const session = (name: string, exercises: Session["exercises"]): Session => ({
  id: `s${seq++}`,
  at: "2026-08-14T17:00:00.000Z",
  name,
  exercises,
});

const day = (over: Partial<Day> = {}): Day => ({ items: [], ...over });

/** A day that counts: weighed, eaten, ticked off. */
const full = (kg: number, kcal: number, protein: number, goal?: number): Day =>
  day({
    weight_kg: kg,
    ...(goal === undefined ? {} : { goal_kcal: goal }),
    items: [item(kcal, protein)],
    logging: "complete",
  });

/** `n` days ending today, losing weight steadily on a fixed intake. */
function history(n: number, opts: { kcal?: number; goal?: number; from?: number } = {}): Map<DayKey, Day> {
  const days = new Map<DayKey, Day>();
  for (let i = n - 1; i >= 0; i--) {
    days.set(on(-i), full(85 - (n - i) * 0.02, opts.kcal ?? 2200, 150, opts.goal));
  }
  return days;
}

/** The rows of one fenced csv block, header excluded. */
function table(doc: string, heading: string): string[] {
  const start = doc.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `no section starting "${heading}"`);
  const fence = doc.indexOf("```csv", start);
  assert.notEqual(fence, -1, `section "${heading}" has no csv block`);
  const end = doc.indexOf("```", fence + 6);
  const lines = doc.slice(fence + 6, end).trim().split("\n");
  return lines.slice(1);
}

const header = (doc: string, heading: string): string => {
  const start = doc.indexOf(`## ${heading}`);
  const fence = doc.indexOf("```csv", start);
  return doc.slice(fence + 6, doc.indexOf("```", fence + 6)).trim().split("\n")[0]!;
};

const cols = (line: string): string[] => {
  // Enough of a CSV reader for the fields these tests look at.
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
};

const build = (days: Map<DayKey, Day>, c: Config = cfg()) =>
  buildContext(c, days, { today: TODAY, generatedAt: "2026-08-14 21:04" });

// ------------------------------------------------------------------ shape

describe("document shape", () => {
  it("holds every section even with no data at all", () => {
    const doc = build(new Map());
    for (const h of ["Profile and goal", "How to read this", "Where things stand", "Weekly", "Daily", "Food log", "Sessions", "Per exercise", "Monthly"]) {
      assert.ok(doc.includes(`## ${h}`) || doc.includes(`## ${h} `), `missing section ${h}`);
    }
    assert.ok(doc.includes("No weigh-ins yet"));
  });

  it("opens every fence it closes", () => {
    const doc = build(history(40));
    assert.equal((doc.match(/```/g) ?? []).length % 2, 0);
  });

  it("gives every row the same number of columns as its header", () => {
    const days = history(40);
    days.get(on(-1))!.items.push(item(400, 20, 'rice, "leftover" chicken\nand greens', "claude-sonnet-5"));
    days.get(on(-2))!.sessions = [session("Push", [{ name: "Bench press", sets: [{ weight_kg: 80, reps: 5 }] }])];
    const doc = build(days);

    for (const h of ["Weekly", "Daily", "Food log", "Sessions", "Per exercise", "Monthly"]) {
      const head = header(doc, h);
      const width = head.split(",").length;
      for (const line of table(doc, h)) {
        assert.equal(cols(line).length, width, `${h}: "${line}" against "${head}"`);
      }
    }
  });

  it("keeps a description with commas, quotes and newlines on one row", () => {
    const days = history(3);
    days.get(on(-1))!.items = [item(400, 20, 'rice, "leftover" chicken\nand greens')];
    const doc = build(days);
    const line = table(doc, "Food log").find((l) => l.includes("leftover"))!;

    assert.ok(line, "the item is in the food log");
    assert.deepEqual(cols(line)[2], 'rice, "leftover" chicken and greens');
    assert.equal(cols(line).length, 6);
  });
});

// ------------------------------------------------------------------ windows

describe("windows", () => {
  it("reaches back to the first of the oldest month it rolls up", () => {
    assert.equal(contextFrom("2026-08-14"), "2024-09-01");
    assert.equal(contextFrom("2026-01-31"), "2024-02-01");
  });

  it("cuts each section at its own window", () => {
    // Two years of data, so every window is the thing doing the cutting.
    const days = history(700);
    for (const [k, d] of days) {
      if (k >= addDays(TODAY, -400)) d.sessions = [session("Push", [{ name: "Bench press", sets: [{ weight_kg: 80, reps: 5 }] }])];
    }
    const doc = build(days);

    assert.equal(table(doc, "Daily").length, WINDOW.dailyDays);
    assert.equal(table(doc, "Food log").length, WINDOW.foodDays);
    assert.equal(table(doc, "Sessions").length, WINDOW.sessionDays);
    assert.equal(table(doc, "Weekly").length, WINDOW.weeks);
    assert.equal(table(doc, "Monthly").length, WINDOW.months);
  });

  it("ends the daily table on today and the weekly one on this week", () => {
    const doc = build(history(120));
    const daily = table(doc, "Daily");
    assert.equal(cols(daily[daily.length - 1]!)[0], TODAY);
    assert.equal(cols(daily[0]!)[0], addDays(TODAY, -(WINDOW.dailyDays - 1)));

    const weekly = table(doc, "Weekly");
    assert.equal(cols(weekly[weekly.length - 1]!)[0], "2026-08-10"); // the Monday
  });

  it("drops the months that predate the log rather than showing them empty", () => {
    const rows = table(build(history(40)), "Monthly").map(cols);
    assert.deepEqual(rows.map((r) => r[0]), ["2026-07", "2026-08"]);
  });

  it("reports an empty window rather than an empty table", () => {
    const doc = build(history(3));
    assert.ok(/## Sessions[^#]*Nothing in this window/.test(doc));
  });
});

// ------------------------------------------------------------- honest numbers

describe("counting", () => {
  it("leaves days that were never ticked off out of every intake average", () => {
    const days = history(14, { kcal: 2200 });
    // A day that was logged but never confirmed. It looks like a 300 kcal day
    // and says nothing about intake — averaging it in is the whole failure.
    days.set(on(-3), day({ weight_kg: 84, items: [item(300, 10)] }));
    const doc = build(days);

    // The current week runs Monday to today, so it holds five days here.
    const week = cols(table(doc, "Weekly").at(-1)!);
    assert.equal(week[1], "4", "four of the five days counted");
    assert.equal(week[2], "2200", "the unconfirmed day did not drag the average down");

    const row = table(doc, "Daily").find((l) => l.startsWith(on(-3)))!;
    assert.equal(cols(row)[4], "300", "its intake is still shown");
    assert.equal(cols(row)[7], "no", "and marked not complete");
  });

  it("writes an empty cell, not a zero, for what was never recorded", () => {
    const days = history(5);
    days.set(on(-2), day({ items: [], logging: "complete" }));
    const doc = build(days);
    const row = cols(table(doc, "Daily").find((l) => l.startsWith(on(-2)))!);

    assert.equal(row[2], "", "no weight");
    assert.equal(row[4], "", "no intake — not 0 kcal");
    assert.equal(row[7], "no", "an empty day is not a complete one");
  });

  it("counts a day in band against the goal it was shown", () => {
    const c = cfg();
    c.goal.kcalWindow = 400; // ±200
    const days = new Map<DayKey, Day>();
    days.set(on(-4), full(85, 2100, 150, 2200)); // in, 100 under
    days.set(on(-3), full(85, 2500, 150, 2200)); // out, 300 over
    days.set(on(-2), full(85, 2400, 150, 2200)); // in, exactly on the edge
    days.set(on(-1), full(85, 3000, 150)); // no recorded goal, unjudgeable
    const doc = build(days, c);

    assert.equal(cols(table(doc, "Weekly").at(-1)!)[4], "2");
  });

  it("re-derives TDEE per row rather than stamping today's on all of them", () => {
    // Intake steps up halfway through while the weight trend holds, so the
    // measured TDEE has to move with it.
    const days = history(120, { kcal: 2000, goal: 2000 });
    for (const [k, d] of days) {
      if (k > addDays(TODAY, -30)) d.items = [item(2800, 150)];
    }
    const doc = build(days);
    const rows = table(doc, "Weekly").map((l) => cols(l));
    const early = Number(rows.at(-10)![7]);
    const late = Number(rows.at(-1)![7]);

    assert.ok(early > 0 && late > 0, "both weeks report a TDEE");
    assert.ok(late > early + 300, `TDEE tracked the change: ${early} -> ${late}`);
  });

  it("never lets a row see data recorded after it", () => {
    const base = history(60, { kcal: 2200, goal: 2200 });
    const doc = build(base);

    // The same history plus a fortnight of enormous days after the row we read.
    const extended = history(60, { kcal: 2200, goal: 2200 });
    for (const k of [...extended.keys()].filter((k) => k > addDays(TODAY, -14))) {
      extended.set(k, full(80, 5000, 300, 2200));
    }
    const later = build(extended);

    const week = (doc: string, i: number) => cols(table(doc, "Weekly").at(i)!);
    assert.deepEqual(week(doc, -4), week(later, -4), "an older week is untouched by newer days");
    assert.notDeepEqual(week(doc, -1), week(later, -1), "the current week did move");
  });
});

// ------------------------------------------------------------------- lifts

describe("lifts", () => {
  const bench = (kg: number, reps = 5) => ({ name: "Bench press", sets: [{ weight_kg: kg, reps }] });

  it("reports the top set's e1RM, and folds spellings into one exercise", () => {
    const days = history(30);
    days.get(on(-8))!.sessions = [session("Push", [{ name: "bench  press", sets: [{ weight_kg: 70, reps: 5 }, { weight_kg: 80, reps: 5 }] }])];
    days.get(on(-1))!.sessions = [session("Push", [bench(85)])];
    const doc = build(days);

    const rows = table(doc, "Sessions").map(cols);
    assert.equal(rows[0]![3], "70x5 80x5");
    assert.equal(rows[0]![4], (80 * (1 + 5 / 30)).toFixed(1));

    const ex = table(doc, "Per exercise").map(cols);
    assert.equal(ex.length, 1, "two spellings, one exercise");
    assert.equal(ex[0]![0], "Bench press", "shown under the most recent spelling");
    assert.equal(ex[0]![1], "2");
  });

  it("orders sessions oldest first, so the table reads as a history", () => {
    const days = history(30);
    days.get(on(-9))!.sessions = [session("Push", [bench(80)])];
    days.get(on(-2))!.sessions = [session("Push", [bench(85)])];
    const rows = table(build(days), "Sessions").map(cols);

    assert.deepEqual(rows.map((r) => r[0]), [on(-9), on(-2)]);
  });

  it("moves the strength index only when the lifts move", () => {
    const days = history(60);
    // Same weight every session for a month, then a jump.
    for (let i = 40; i >= 10; i -= 3) days.get(on(-i))!.sessions = [session("Push", [bench(80)])];
    const flat = table(build(days), "Weekly").map((l) => cols(l)[10]);
    assert.ok(flat.filter(Boolean).every((x) => Math.abs(Number(x)) < 1e-9), "flat lifting, flat index");

    for (let i = 8; i >= 1; i -= 3) days.get(on(-i))!.sessions = [session("Push", [bench(90)])];
    const risen = table(build(days), "Weekly").map((l) => cols(l)[10]);
    assert.ok(Number(risen.at(-1)) > 0.05, `index rose: ${risen.at(-1)}`);
  });

  it("does not move the index when an exercise is merely added", () => {
    const days = history(60);
    for (let i = 30; i >= 1; i -= 3) days.get(on(-i))!.sessions = [session("Push", [bench(80)])];
    const before = table(build(days), "Weekly").map((l) => cols(l)[10]);

    for (let i = 30; i >= 1; i -= 3) {
      days.get(on(-i))!.sessions = [session("Push", [bench(80), { name: "Overhead press", sets: [{ weight_kg: 50, reps: 5 }] }])];
    }
    const after = table(build(days), "Weekly").map((l) => cols(l)[10]);

    assert.deepEqual(after, before);
  });
});

// ----------------------------------------------------------------- preamble

describe("preamble", () => {
  it("states the goal in force, so the numbers can be judged against it", () => {
    const c = cfg();
    c.goal.kcalOffset = -400;
    c.goal.kcalWindow = 300;
    c.goal.proteinGPerKg = 1.8;
    const doc = build(history(30), c);

    assert.ok(doc.includes("-400 kcal (a deficit)"));
    assert.ok(doc.includes("±150"));
    assert.ok(doc.includes("1.8 g per kg"));
  });

  it("says where things stand today, with the interval attached", () => {
    const doc = build(history(60, { kcal: 2200, goal: 2200 }));
    assert.ok(/Smoothed weight \d+\.\d kg, moving [-+]\d+\.\d\d ± \d+\.\d\d kg\/week/.test(doc), doc.slice(doc.indexOf("## Where")));
    assert.ok(/TDEE \d+ kcal/.test(doc));
  });
});
