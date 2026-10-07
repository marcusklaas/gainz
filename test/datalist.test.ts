// The pure half of the datalist fallback: who gets it, and what it offers. The
// DOM half is exercised in a browser, not here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { needsDatalistFallback, suggestions } from "../src/datalist.js";

const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0";
const FIREFOX_TABLET = "Mozilla/5.0 (Android 14; Tablet; rv:143.0) Gecko/143.0 Firefox/143.0";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Mobile Safari/537.36";
const FIREFOX_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "FxiOS/141.0 Mobile/15E148 Safari/605.1.15";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/26.0 Safari/605.1.15";
const SAFARI_IPHONE = FIREFOX_IOS.replace("FxiOS/141.0", "Version/26.0");
const SAFARI_IPAD = SAFARI_IPHONE.replace("iPhone", "iPad");
const CHROME_IOS = FIREFOX_IOS.replace("FxiOS/141.0", "CriOS/141.0.0.0");

describe("needsDatalistFallback", () => {
  it("covers Firefox on Android, phone and tablet", () => {
    assert.ok(needsDatalistFallback(FIREFOX_ANDROID));
    assert.ok(needsDatalistFallback(FIREFOX_TABLET));
  });

  it("covers Safari on Mac, iPhone and iPad, and iOS WebKit browsers", () => {
    for (const ua of [SAFARI_MAC, SAFARI_IPHONE, SAFARI_IPAD, FIREFOX_IOS, CHROME_IOS]) {
      assert.ok(needsDatalistFallback(ua), ua);
    }
  });

  it("leaves desktop Firefox and Chromium browsers alone", () => {
    for (const ua of [FIREFOX_LINUX, CHROME_ANDROID,
      CHROME_ANDROID.replace("Mobile Safari", "Safari"),
      CHROME_ANDROID + " Edg/141.0.0.0",
      CHROME_ANDROID + " OPR/120.0.0.0",
    ]) {
      assert.ok(!needsDatalistFallback(ua), ua);
    }
  });
});

describe("suggestions", () => {
  const names = ["Bench press", "Barbell row", "Incline bench press", "Squat", "Deadlift"];

  it("offers everything, in the caller's order, for an empty query", () => {
    assert.deepEqual(suggestions(names, ""), names);
    assert.deepEqual(suggestions(names, "   "), names);
  });

  it("matches anywhere in the name, case-insensitively", () => {
    assert.deepEqual(suggestions(names, "BENCH"), ["Bench press", "Incline bench press"]);
    assert.deepEqual(suggestions(names, "row"), ["Barbell row"]);
  });

  it("floats the entries that start with the query above the rest", () => {
    // "Incline bench press" is the more recent entry and still comes second:
    // what was typed is the start of the other one.
    assert.deepEqual(suggestions(["Incline bench press", "Bench press"], "bench"), [
      "Bench press",
      "Incline bench press",
    ]);
  });

  it("ignores surrounding whitespace on both sides of the match", () => {
    assert.deepEqual(suggestions(["  Bench press  "], " bench "), ["Bench press"]);
  });

  it("drops blanks and repeats, which differ only in case or spacing", () => {
    assert.deepEqual(suggestions(["Squat", "", "  ", "squat", " SQUAT"], ""), ["Squat"]);
  });

  it("has nothing to offer when nothing matches", () => {
    assert.deepEqual(suggestions(names, "zercher"), []);
  });

  it("caps how many it hands back", () => {
    const many = Array.from({ length: 200 }, (_, i) => `Lift ${i}`);
    assert.equal(suggestions(many, "").length, 50);
    assert.deepEqual(suggestions(many, "", 3), ["Lift 0", "Lift 1", "Lift 2"]);
  });
});
