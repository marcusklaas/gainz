// Day-key arithmetic. Tested first because both estimators are built on it:
// `daysBetween` is the denominator of the Holt gap, the regression's x axis and
// the strength index's chaining, so an off-by-one here is an off-by-one
// everywhere and would not look like a date bug when it surfaced.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The module's whole claim is that day keys are LOCAL calendar dates. Under UTC
// that claim is untestable, so the suite runs in a zone that has DST. Node
// re-reads TZ on assignment, and nothing in dates.ts captures it at import.
process.env.TZ = "Europe/Amsterdam";

import { addDays, atKey, atTime, byAt, daysBetween, monthOf, parseDay, toDayKey } from "../src/dates.js";

describe("toDayKey / parseDay", () => {
  it("pads month and day to two digits", () => {
    assert.equal(toDayKey(new Date(2026, 0, 5)), "2026-01-05");
    assert.equal(toDayKey(new Date(2026, 11, 31)), "2026-12-31");
  });

  it("uses local components, not UTC ones", () => {
    // 23:30 local on the 25th is already the 26th in UTC. Filing this by UTC is
    // exactly the late-night misfiling the module header warns about.
    assert.equal(toDayKey(new Date(2026, 6, 25, 23, 30)), "2026-07-25");
    assert.equal(toDayKey(new Date(2026, 6, 25, 0, 30)), "2026-07-25");
  });

  it("round-trips through parseDay at local midnight", () => {
    for (const key of ["2026-01-01", "2026-03-29", "2026-10-25", "2026-12-31"]) {
      const d = parseDay(key);
      assert.equal(toDayKey(d), key);
      assert.equal(d.getHours(), 0);
      assert.equal(d.getMinutes(), 0);
    }
  });
});

describe("monthOf", () => {
  it("takes the year and month", () => {
    assert.equal(monthOf("2026-07-25"), "2026-07");
  });
});

describe("addDays", () => {
  it("crosses month, year and leap-day boundaries", () => {
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(addDays("2024-02-28", 1), "2024-02-29"); // leap
    assert.equal(addDays("2025-02-28", 1), "2025-03-01"); // not
  });

  it("is the identity at zero", () => {
    assert.equal(addDays("2026-07-25", 0), "2026-07-25");
  });

  it("advances exactly one calendar day across DST in both directions", () => {
    // Amsterdam springs forward on 2026-03-29 (a 23-hour day) and falls back on
    // 2026-10-25 (25 hours). Adding 86_400_000 ms would skip or repeat a day.
    assert.equal(addDays("2026-03-28", 1), "2026-03-29");
    assert.equal(addDays("2026-03-29", 1), "2026-03-30");
    assert.equal(addDays("2026-10-24", 1), "2026-10-25");
    assert.equal(addDays("2026-10-25", 1), "2026-10-26");
  });

  it("walks a whole year one day at a time without drifting", () => {
    let day = "2026-01-01";
    let steps = 0;
    while (day !== "2027-01-01") {
      day = addDays(day, 1);
      steps++;
      assert.ok(steps <= 400, "walked off the end of the year");
    }
    assert.equal(steps, 365);
  });
});

describe("daysBetween", () => {
  it("is positive when b is later and negative when earlier", () => {
    assert.equal(daysBetween("2026-07-25", "2026-07-28"), 3);
    assert.equal(daysBetween("2026-07-28", "2026-07-25"), -3);
    assert.equal(daysBetween("2026-07-25", "2026-07-25"), 0);
  });

  it("counts whole days across DST, not 24-hour blocks", () => {
    // 23 and 25 real hours respectively; both are one calendar day.
    assert.equal(daysBetween("2026-03-28", "2026-03-29"), 1);
    assert.equal(daysBetween("2026-10-24", "2026-10-25"), 1);
    // A span containing both transitions nets out to a whole number anyway.
    assert.equal(daysBetween("2026-01-01", "2026-12-31"), 364);
  });

  it("inverts addDays for every offset in a year", () => {
    const from = "2026-01-01";
    for (let n = -400; n <= 400; n++) {
      assert.equal(daysBetween(from, addDays(from, n)), n);
    }
  });
});

describe("atKey / byAt", () => {
  it("sorts every legacy clock time ahead of every instant", () => {
    // The bug this fixes: "08:30" compares before an ISO string and "23:50"
    // after it, so the two formats interleave on the one day holding both.
    assert.ok(atKey("08:30") < atKey("2020-01-01T00:00:00.000Z"));
    assert.ok(atKey("23:50") < atKey("2020-01-01T00:00:00.000Z"));
  });

  it("orders instants by the instant and legacy values among themselves", () => {
    const items = [
      { at: "2026-07-25T18:00:00.000Z" },
      { at: "23:50" },
      { at: "2026-07-25T06:00:00.000Z" },
      { at: "08:30" },
    ];
    assert.deepEqual(
      [...items].sort(byAt).map((i) => i.at),
      ["08:30", "23:50", "2026-07-25T06:00:00.000Z", "2026-07-25T18:00:00.000Z"],
    );
  });

  it("separates entries a second apart", () => {
    const a = { at: "2026-07-25T18:00:00.000Z" };
    const b = { at: "2026-07-25T18:00:01.000Z" };
    assert.ok(byAt(a, b) < 0);
    assert.ok(byAt(b, a) > 0);
  });
});

describe("atTime", () => {
  it("passes legacy values through untouched", () => {
    assert.equal(atTime("19:40"), "19:40");
  });

  it("renders an instant as local clock time", () => {
    // 18:00Z in Amsterdam summer time (UTC+2) is 20:00 local.
    assert.equal(atTime("2026-07-25T18:00:00.000Z"), "20:00");
    // 18:00Z in winter (UTC+1) is 19:00.
    assert.equal(atTime("2026-01-25T18:00:00.000Z"), "19:00");
  });

  it("pads single-digit hours and minutes", () => {
    assert.equal(atTime("2026-01-25T06:05:00.000Z"), "07:05");
  });
});
