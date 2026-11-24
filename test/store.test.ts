// Three-way day merges, outbox / sync concurrency guarantees, and GitHub auth error detection.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getFile, isAuthError } from "../src/services/github.js";
import { saveSettings } from "../src/services/settings.js";
import {
  flush,
  invalidateMonths,
  mergeDay,
  pendingWrites,
  readDay,
  readMonth,
  updateDay,
} from "../src/services/store.js";
import type { Day, FoodItem, MonthFile, Session } from "../src/core/types.js";

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

// ---------------------------------------------------------------- outbox / sync

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function fromB64(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}

describe("store sync races", () => {
  const origStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
    saveSettings({
      repo: "u/r",
      branch: "main",
      pat: "tok",
      anthropicKey: "",
      openaiKey: "",
    });
    invalidateMonths("2026-08", "2026-09", "2026-10", "2026-11");
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: origStorage,
      configurable: true,
      writable: true,
    });
    globalThis.fetch = origFetch;
  });

  it("keeps and re-flushes edits that arrive while a PUT is in flight", async () => {
    const server = new Map<string, { text: string; sha: string }>();
    const putGate = deferred();
    const putStarted = deferred();
    let putCount = 0;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.split("/contents/")[1]!;
      if (init?.method === "PUT") {
        putCount++;
        const body = JSON.parse(String(init.body)) as { content: string };
        if (putCount === 1) {
          putStarted.resolve();
          await putGate.promise;
        }
        const sha = `sha-${putCount}`;
        server.set(path, { text: fromB64(body.content), sha });
        return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
      }
      const existing = server.get(path);
      if (!existing) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ content: b64(existing.text), sha: existing.sha }), {
        status: 200,
      });
    }) as typeof fetch;

    const a = item("a", "2026-08-10T08:00:00.000Z");
    const b = item("b", "2026-08-10T09:00:00.000Z");
    await updateDay("2026-08-10", (d) => d.items.push(a));

    const flushing = flush();
    await putStarted.promise;

    // A second edit lands while the first PUT is still awaiting GitHub.
    await updateDay("2026-08-10", (d) => d.items.push(b));
    putGate.resolve();
    await flushing;

    assert.equal(pendingWrites(), 0);
    assert.equal(putCount, 2);
    const saved = JSON.parse(server.get("data/2026/2026-08.json")!.text) as MonthFile;
    assert.deepEqual(
      saved.days["2026-08-10"]!.items.map((x) => x.id),
      ["a", "b"],
    );
  });

  it("coalesces concurrent flush() calls into a single in-flight drain", async () => {
    const putGate = deferred();
    const putStarted = deferred();
    let getCount = 0;
    let putCount = 0;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCount++;
        putStarted.resolve();
        await putGate.promise;
        return new Response(JSON.stringify({ content: { sha: "sha-1" } }), { status: 200 });
      }
      getCount++;
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await updateDay("2026-09-01", (d) => {
      d.weight_kg = 80;
    });
    // updateDay performed one GET (404) to initialize the month.
    getCount = 0;

    const p1 = flush();
    await putStarted.promise;
    const p2 = flush();
    const p3 = flush();
    putGate.resolve();
    await Promise.all([p1, p2, p3]);

    assert.equal(getCount, 1);
    assert.equal(putCount, 1);
    assert.equal(pendingWrites(), 0);
  });

  it("does not clobber dirty local edits on a server readMonth", async () => {
    const remoteMonth: MonthFile = { version: 1, days: { "2026-10-05": { weight_kg: 79, items: [] } } };
    let gets = 0;

    globalThis.fetch = (async () => {
      gets++;
      return new Response(JSON.stringify({ content: b64(JSON.stringify(remoteMonth)), sha: "s1" }), {
        status: 200,
      });
    }) as typeof fetch;

    // Seed remote, then edit locally (making the month dirty).
    await readMonth("2026-10", "server");
    await updateDay("2026-10-05", (d) => {
      d.weight_kg = 81.2;
    });

    // Simulate a refocus invalidation while the outbox still has unsynced edits.
    invalidateMonths("2026-10");
    gets = 0;
    const day = await readDay("2026-10-05", "server");

    assert.equal(gets, 0);
    assert.equal(day.weight_kg, 81.2);
    assert.equal(pendingWrites(), 1);
  });

  it("preserves both mutations when two updateDay calls run concurrently", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

    await readMonth("2026-11", "server");
    const a = item("a", "2026-11-01T08:00:00.000Z");
    const b = item("b", "2026-11-01T09:00:00.000Z");

    await Promise.all([
      updateDay("2026-11-01", (d) => d.items.push(a)),
      updateDay("2026-11-01", (d) => d.items.push(b)),
    ]);

    const day = await readDay("2026-11-01", "cache");
    assert.deepEqual(
      day.items.map((x) => x.id),
      ["a", "b"],
    );
  });

  it("classifies 401 and permission 403 as auth errors, but not 403 rate limits or 500s", async () => {
    const s = { repo: "u/r", branch: "main", pat: "tok", anthropicKey: "", openaiKey: "" };
    const cases: [number, Record<string, string>, boolean][] = [
      [401, {}, true],
      [403, { "x-ratelimit-remaining": "4999" }, true],
      [403, { "x-ratelimit-remaining": "0" }, false],
      [500, {}, false],
    ];
    for (const [status, headers, expected] of cases) {
      globalThis.fetch = (async () => new Response("err", { status, headers })) as typeof fetch;
      await assert.rejects(
        () => getFile(s, "config.json"),
        (err) => {
          assert.equal(isAuthError(err), expected, `status=${status} headers=${JSON.stringify(headers)}`);
          return true;
        },
      );
    }
  });
});
