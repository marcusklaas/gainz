// Three-way day merges. Pure over Day records, so every conflict case can be
// checked directly without mocking GitHub or localStorage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeDay } from "../src/services/store.js";
import type { Day, FoodItem, Session } from "../src/core/types.js";

const item = (id: string, at: string, kcal = 500): FoodItem => ({
  id,
  at,
  name: `food-${id}`,
  kcal,
  protein_g: 25,
});

const session = (id: string, at: string, name = "Push"): Session => ({
  id,
  at,
  name,
  exercises: [{ name: "Bench", sets: [{ weight_kg: 80, reps: 8 }] }],
});

describe("mergeDay", () => {
  it("keeps food items added concurrently on two devices and sorts by entry time", () => {
    const shared = item("a", "2026-07-25T08:00:00.000Z");
    const localNew = item("b", "2026-07-25T13:00:00.000Z");
    const remoteNew = item("c", "2026-07-25T10:30:00.000Z");

    const base: Day = { items: [shared] };
    const local: Day = { items: [shared, localNew] };
    const remote: Day = { items: [shared, remoteNew] };

    const merged = mergeDay(base, local, remote);
    assert.deepEqual(
      merged.items.map((x) => x.id),
      ["a", "c", "b"],
    );
  });

  it("honours a local deletion even when the item is still on the server", () => {
    const kept = item("a", "2026-07-25T08:00:00.000Z");
    const deleted = item("b", "2026-07-25T09:00:00.000Z");
    const remoteAdded = item("c", "2026-07-25T12:00:00.000Z");

    const base: Day = { items: [kept, deleted] };
    const local: Day = { items: [kept] };
    const remote: Day = { items: [kept, deleted, remoteAdded] };

    const merged = mergeDay(base, local, remote);
    assert.deepEqual(
      merged.items.map((x) => x.id),
      ["a", "c"],
    );
  });

  it("sorts legacy HH:MM stamps ahead of ISO instants after merging", () => {
    const legacy = item("old", "23:45");
    const instant = item("new", "2026-07-25T07:00:00.000Z");

    const merged = mergeDay(undefined, { items: [instant] }, { items: [legacy] });
    assert.deepEqual(
      merged.items.map((x) => x.id),
      ["old", "new"],
    );
  });

  it("merges sessions by id, keeps local edits, and omits the key when empty", () => {
    const s1 = session("s1", "2026-07-25T09:00:00.000Z", "Push");
    const s1Edited: Session = { ...s1, name: "Push Heavy" };
    const s2 = session("s2", "2026-07-25T17:00:00.000Z", "Pull");

    const merged = mergeDay(
      { items: [], sessions: [s1] },
      { items: [], sessions: [s1Edited] },
      { items: [], sessions: [s1, s2] },
    );
    assert.deepEqual(
      merged.sessions?.map((s) => [s.id, s.name]),
      [
        ["s1", "Push Heavy"],
        ["s2", "Pull"],
      ],
    );

    const noSessions = mergeDay({ items: [] }, { items: [] }, { items: [] });
    assert.equal("sessions" in noSessions, false);
  });

  it("lets a locally edited scalar win and otherwise defers to the server", () => {
    const base: Day = { weight_kg: 80, items: [] };
    // Local touched weight, remote touched logging: both survive.
    const merged = mergeDay(
      base,
      { weight_kg: 80.4, items: [] },
      { weight_kg: 80, items: [], logging: "complete" },
    );
    assert.equal(merged.weight_kg, 80.4);
    assert.equal(merged.logging, "complete");

    // Local cleared logging while remote did not change it: cleared stays absent.
    const cleared = mergeDay(
      { items: [], logging: "complete" },
      { items: [] },
      { items: [], logging: "complete" },
    );
    assert.equal(cleared.logging, undefined);
    assert.equal("logging" in cleared, false);
  });

  it("preserves write-once goal_kcal from whichever side holds it", () => {
    const fromRemote = mergeDay(undefined, { items: [] }, { items: [], goal_kcal: 2400 });
    assert.equal(fromRemote.goal_kcal, 2400);

    const fromLocal = mergeDay(undefined, { items: [], goal_kcal: 2450 }, { items: [], goal_kcal: 2400 });
    assert.equal(fromLocal.goal_kcal, 2450);
  });

  it("works cleanly when either base or remote is absent", () => {
    const a = item("a", "2026-07-25T08:00:00.000Z");
    const merged = mergeDay(undefined, { weight_kg: 79.5, items: [a] }, undefined);
    assert.equal(merged.weight_kg, 79.5);
    assert.deepEqual(merged.items, [a]);
  });
});
