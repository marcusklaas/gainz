// Trend charts, built on uPlot (MIT, no transitive dependencies, vendored into
// vendor/ so the deployed site needs neither node_modules nor a CDN).
//
// PLAN.md's "no dependencies" rule is deliberately broken here: axes, tick
// labels, and touch-capable zoom/pan is a large amount of pointer-event code
// with real edge cases, and uPlot is purpose-built for exactly this shape of
// data. It is the only runtime dependency in the project.
import uPlot from "../vendor/uPlot.esm.js";
import { parseDay } from "./dates.js";
import { projection, type CaloriePoint, type Sample, type TrendPoint } from "./estimate.js";
import type { IndexPoint, LiftPoint } from "./lifts.js";

const DAY_SECONDS = 86_400;

/**
 * Fixed, and the same everywhere. Every screen is one column of one width now,
 * so a height derived from the width would be answering a question nothing
 * asks: it came out at this constant on a phone and within a few pixels of it
 * on a desktop. A little taller than the 240 it was, because the y-axis spans a
 * couple of kilos and the extra room is where the trend line becomes legible.
 */
const HEIGHT = 280;

/**
 * How much history to open on when there is no config to say — only reachable
 * before the first save, since every configured field has a default.
 */
const FALLBACK_SPAN_DAYS = 21;

/** Local midnight as unix seconds — uPlot's native x unit. */
const toX = (s: { day: string }) => parseDay(s.day).getTime() / 1000;

/** A stretch of the x axis, in the unix seconds uPlot ranges over. */
interface Extent {
  min: number;
  max: number;
}

/** What the default view spans, in days either side of the last weigh-in. */
export interface Span {
  /** History, back from the last weigh-in. */
  historyDays: number;
  /** How far the tangent is carried past it. */
  projectionDays: number;
}

// ----------------------------------------------------------------- shared slot

/**
 * Wheel and pinch to zoom, drag to pan, double-click to reset. Replaces uPlot's
 * built-in drag-to-zoom, since drag is far more useful as scroll on a phone.
 *
 * Every chart on Trend uses it, so what it may reach and where it returns to
 * are read through callbacks rather than closed over: the extents belong to
 * whichever chart installed the plugin, and they change on every redraw.
 */
function panZoom(limits: () => Extent, home: () => Extent): uPlot.Plugin {
  return {
    hooks: {
      ready(u: uPlot) {
        const over = u.over;

        /** Keeps the view inside the data and never narrower than a day. */
        const clamp = (min: number, max: number) => {
          const bounds = limits();
          const span = Math.min(Math.max(max - min, DAY_SECONDS), bounds.max - bounds.min);
          if (min < bounds.min) return { min: bounds.min, max: bounds.min + span };
          if (max > bounds.max) return { min: bounds.max - span, max: bounds.max };
          return { min, max };
        };

        const scale = () => {
          const { min, max } = u.scales["x"]!;
          return min == null || max == null ? null : { min, max };
        };

        const zoomAt = (clientX: number, factor: number) => {
          const s = scale();
          if (!s) return;
          const pivot = u.posToVal(clientX - over.getBoundingClientRect().left, "x");
          u.setScale(
            "x",
            clamp(pivot - (pivot - s.min) * factor, pivot + (s.max - pivot) * factor),
          );
        };

        over.addEventListener(
          "wheel",
          (e) => {
            e.preventDefault();
            zoomAt(e.clientX, e.deltaY < 0 ? 0.8 : 1.25);
          },
          { passive: false },
        );

        // Pointer events cover mouse and touch uniformly. Two live pointers
        // means a pinch; one means a pan.
        const active = new Map<number, number>();
        let prev: { center: number; dist: number } | null = null;

        const gesture = () => {
          const xs = [...active.values()];
          if (xs.length === 1) return { center: xs[0]!, dist: 0 };
          return { center: (xs[0]! + xs[1]!) / 2, dist: Math.abs(xs[0]! - xs[1]!) };
        };

        over.addEventListener("pointerdown", (e) => {
          if (active.size >= 2) return;
          active.set(e.pointerId, e.clientX);
          over.setPointerCapture(e.pointerId);
          prev = gesture();
        });

        over.addEventListener("pointermove", (e) => {
          if (!active.has(e.pointerId)) return;
          active.set(e.pointerId, e.clientX);

          const s = scale();
          const cur = gesture();
          if (!s || !prev) return;

          const perPx = (s.max - s.min) / over.clientWidth;
          const shift = (cur.center - prev.center) * perPx;
          let min = s.min - shift;
          let max = s.max - shift;

          if (cur.dist > 0 && prev.dist > 0) {
            const f = prev.dist / cur.dist;
            const pivot = u.posToVal(cur.center - over.getBoundingClientRect().left, "x");
            min = pivot - (pivot - min) * f;
            max = pivot + (max - pivot) * f;
          }

          prev = cur;
          u.setScale("x", clamp(min, max));
        });

        const release = (e: PointerEvent) => {
          active.delete(e.pointerId);
          prev = active.size ? gesture() : null;
        };
        over.addEventListener("pointerup", release);
        over.addEventListener("pointercancel", release);

        over.addEventListener("dblclick", () => u.setScale("x", home()));
      },
    },
  };
}

/** Colours live in style.css; read them back so the theme has one home. */
function theme() {
  const css = getComputedStyle(document.body);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { fg: v("--fg"), dim: v("--dim"), line: v("--line"), ok: v("--ok") };
}

type Theme = ReturnType<typeof theme>;

/**
 * Shared uPlot frame for every Trend chart: axes, live readout, date series,
 * and pan/zoom. Only the y-axis formatting and the data series differ.
 */
function buildOptions(
  width: number,
  yFormat: (v: number) => string,
  series: (c: Theme) => uPlot.Series[],
  limits: () => Extent,
  home: () => Extent,
): uPlot.Options {
  const c = theme();
  const axis = {
    stroke: c.dim,
    grid: { stroke: c.line, width: 1 },
    ticks: { stroke: c.line, width: 1 },
    font: "11px system-ui, sans-serif",
  };

  return {
    width,
    height: HEIGHT,
    padding: [8, 8, 0, 0],
    cursor: { drag: { x: false, y: false }, points: { size: 7 } },
    legend: { show: true, live: true, markers: { show: false } },
    scales: { x: { time: true } },
    axes: [
      { ...axis },
      { ...axis, size: 44, values: (_u, vals) => vals.map(yFormat) },
    ],
    series: [
      {
        // No year: the readout sits next to a fixed-width label column on a
        // phone, and every point on screen is within a few months of today.
        // The weekday earns its place — weekend weigh-ins read differently.
        label: "date",
        value: (_u, v) =>
          v == null
            ? "—"
            : new Date(v * 1000).toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
              }),
      },
      ...series(c),
    ],
    plugins: [panZoom(limits, home)],
  };
}

/**
 * One mounted uPlot instance plus its bounds and ResizeObserver. Teardown
 * disconnects the observer as well as destroying the plot, so mode switches on
 * a shared container (index <-> e1RM) never leak observers.
 */
class ChartSlot {
  private plot: uPlot | null = null;
  private observer: ResizeObserver | null = null;
  bounds: Extent = { min: 0, max: 0 };

  destroy(el?: HTMLElement): void {
    this.observer?.disconnect();
    this.observer = null;
    this.plot?.destroy();
    this.plot = null;
    el?.replaceChildren();
  }

  /**
   * Draws or updates the chart. Must be called while the container is visible
   * — uPlot sizes from the element, and a hidden section measures zero.
   */
  draw(
    el: HTMLElement,
    data: uPlot.AlignedData,
    home: () => Extent,
    yFormat: (v: number) => string,
    series: (c: Theme) => uPlot.Series[],
  ): void {
    const xs = data[0];
    this.bounds = { min: xs[0]!, max: xs[xs.length - 1]! };

    const width = el.clientWidth;
    if (!width) return; // container still hidden; caller redraws on show

    if (this.plot) {
      // setData re-ranges x to the full extent, so the view has to be reapplied.
      this.plot.setData(data);
      this.plot.setSize({ width, height: HEIGHT });
      this.plot.setScale("x", home());
      return;
    }

    el.replaceChildren();
    this.plot = new uPlot(
      buildOptions(width, yFormat, series, () => this.bounds, home),
      data,
      el,
    );
    this.plot.setScale("x", home());

    // Width only — the height is fixed. Still needed for a window dragged wider,
    // a phone turned sideways, or the sidebar appearing at 48rem, each of which
    // changes how much span fits without uPlot hearing about it.
    this.observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (this.plot && w) this.plot.setSize({ width: w, height: HEIGHT });
    });
    this.observer.observe(el);
  }
}

/** Trailing window clamped to the chart's full extent. */
const trailingView = (slot: ChartSlot, windowSec: () => number): Extent => ({
  min: Math.max(slot.bounds.max - windowSec(), slot.bounds.min),
  max: slot.bounds.max,
});

// ------------------------------------------------------------------ weight

const weightChart = new ChartSlot();
/** Seconds of `weightChart.bounds` that are projected rather than measured. */
let projected = 0;
/** Seconds of history the default view opens on. */
let history = FALLBACK_SPAN_DAYS * DAY_SECONDS;

/**
 * The window the chart opens at and returns to on double-click: history back
 * from the last real weigh-in, plus where the tangent says the next week goes.
 *
 * History is counted back from the last real weigh-in rather than from the right
 * edge, with the projection added on top — otherwise turning the projection on
 * would silently eat a week of history out of the view.
 *
 * Everything outside is still there. Zoom or pan out to reach it.
 */
function weightDefaultView(): Extent {
  return {
    min: Math.max(weightChart.bounds.max - projected - history, weightChart.bounds.min),
    max: weightChart.bounds.max,
  };
}

export function drawTrend(el: HTMLElement, samples: Sample[], trend: TrendPoint[], span: Span): void {
  if (samples.length < 2) {
    weightChart.destroy(el);
    return;
  }

  // The projection adds days on the right that no weigh-in covers, so all three
  // series are padded onto one x column — which is what uPlot's aligned data
  // wants: one x, and a null wherever a series has nothing to say. `trend`
  // carries one point per sample, so only the projected days extend past them.
  const proj = projection(trend, span.projectionDays); // the anchor, then one per day
  const future = proj.slice(1);
  const xs = [...samples.map(toX), ...future.map(toX)];
  const pad = future.map(() => null);

  // Nulls up to the anchor, which is the last trend point repeated: the dashes
  // start *on* the solid line rather than a day to its right. Empty when the
  // projection is switched off, leaving the series present but blank.
  const tangent: (number | null)[] = xs.map(() => null);
  proj.forEach((p, i) => (tangent[samples.length - 1 + i] = p.kg));

  const data: uPlot.AlignedData = [
    xs,
    [...samples.map((s) => s.kg), ...pad],
    [...trend.map((s) => s.kg), ...pad],
    tangent,
  ];

  projected = future.length * DAY_SECONDS;
  history = Math.max(span.historyDays, 1) * DAY_SECONDS;

  weightChart.draw(
    el,
    data,
    weightDefaultView,
    (v) => v.toFixed(1),
    (c) => [
      {
        label: "weighed",
        stroke: c.dim,
        paths: () => null, // points only — raw weigh-ins are samples, not a line
        points: { show: true, size: 3.5, stroke: c.dim, fill: c.dim },
        value: (_u, v) => (v == null ? "—" : `${v.toFixed(1)} kg`),
      },
      {
        label: "trend",
        stroke: c.ok,
        width: 2,
        points: { show: false },
        value: (_u, v) => (v == null ? "—" : `${v.toFixed(2)} kg`),
      },
      {
        // Same colour as the trend, because it is the same line continued —
        // dashed is the whole distinction, and a second colour would read as a
        // second quantity. Kept out of the readout via `.u-legend tr.unlisted`.
        label: "projected",
        class: "unlisted",
        stroke: c.ok,
        width: 1.5,
        dash: [3, 4],
        points: { show: false },
        value: (_u, v) => (v == null ? "—" : `${v.toFixed(2)} kg`),
      },
    ],
  );
}

// ------------------------------------------------ strength index & single e1RM
//
// Its own chart, below the weight one and not merged with it: the two share an
// x axis and nothing else, and a second y axis on one picture would invite
// exactly the point-to-point reading both are built to avoid.
//
// The index and single-exercise e1RM share the #strength-chart container, so
// entering one tears down the other — otherwise a mode switch would stack
// canvases or leave a stale ResizeObserver attached.

const strengthChart = new ChartSlot();
const e1rmChart = new ChartSlot();
let strengthMode: "index" | "e1rm" | null = null;
let strengthWindow = 0;
let e1rmWindow = 0;

/**
 * The index, rebased so the first session on record reads 100, opening on the
 * window the fit below it is computed over.
 *
 * The index alone, with no fitted line over it: the fit uses every session in
 * the window while the index chains, so the gap between them is honest and the
 * headline carries the fit in words instead.
 */
export function drawStrength(el: HTMLElement, index: IndexPoint[], windowDays: number): void {
  if (strengthMode !== "index") {
    e1rmChart.destroy();
    strengthMode = "index";
  }
  if (index.length < 2) {
    strengthChart.destroy(el);
    return;
  }

  const base = index[0]!.x;
  const data: uPlot.AlignedData = [
    index.map(toX),
    index.map((p) => 100 * Math.exp(p.x - base)),
  ];
  strengthWindow = Math.max(windowDays, 1) * DAY_SECONDS;

  strengthChart.draw(
    el,
    data,
    () => trailingView(strengthChart, () => strengthWindow),
    (v) => v.toFixed(0),
    (c) => [
      {
        // A line, unlike the weigh-ins above: consecutive index points are a
        // running total, and the segment between two of them is a real thing.
        label: "index",
        stroke: c.fg,
        width: 2,
        points: { show: true, size: 3.5, stroke: c.fg, fill: c.fg },
        value: (_u, v) => (v == null ? "—" : v.toFixed(1)),
      },
    ],
  );
}

/**
 * One movement's e1RM trajectory, opening on the window the basket was built
 * over. Points arrive as log e1RM — the scale the index is fitted on — and
 * are shown exponentiated, which is the number a lifter recognises.
 */
export function drawE1rm(el: HTMLElement, points: LiftPoint[], windowDays: number): void {
  if (strengthMode !== "e1rm") {
    strengthChart.destroy();
    strengthMode = "e1rm";
  }
  if (points.length < 2) {
    e1rmChart.destroy(el);
    return;
  }

  const data: uPlot.AlignedData = [points.map(toX), points.map((p) => Math.exp(p.x))];
  e1rmWindow = Math.max(windowDays, 1) * DAY_SECONDS;

  e1rmChart.draw(
    el,
    data,
    () => trailingView(e1rmChart, () => e1rmWindow),
    (v) => v.toFixed(1),
    (c) => [
      {
        label: "e1rm",
        stroke: c.fg,
        width: 2,
        points: { show: true, size: 3.5, stroke: c.fg, fill: c.fg },
        value: (_u, v) => (v == null ? "—" : `${v.toFixed(1)} kg`),
      },
    ],
  );
}

// ------------------------------------------------------------ intake vs TDEE

const calorieChart = new ChartSlot();
let calorieWindow = 0;

/**
 * Daily intake against the TDEE trajectory, opening on the window the series
 * was built over. Intake is points only — a missing day is a missing dot rather
 * than a zero — and TDEE is the smoothed reading in the same colour as weight.
 */
export function drawCalories(el: HTMLElement, points: CaloriePoint[], windowDays: number): void {
  const usable = points.filter((p) => p.kcal !== null || p.tdee !== null);
  if (usable.length < 2) {
    calorieChart.destroy(el);
    return;
  }

  const data: uPlot.AlignedData = [
    usable.map(toX),
    usable.map((p) => p.kcal),
    usable.map((p) => p.tdee),
  ];
  calorieWindow = Math.max(windowDays, 1) * DAY_SECONDS;

  calorieChart.draw(
    el,
    data,
    () => trailingView(calorieChart, () => calorieWindow),
    (v) => v.toFixed(0),
    (c) => [
      {
        label: "intake",
        stroke: c.fg,
        paths: () => null, // points only — counted days are samples, not a line
        points: { show: true, size: 3.5, stroke: c.fg, fill: c.fg },
        value: (_u, v) => (v == null ? "—" : `${v.toFixed(0)} kcal`),
      },
      {
        label: "tdee",
        stroke: c.ok,
        width: 2,
        points: { show: false },
        value: (_u, v) => (v == null ? "—" : `${v.toFixed(0)} kcal`),
      },
    ],
  );
}
