// Trend chart, built on uPlot (MIT, no transitive dependencies, vendored into
// vendor/ so the deployed site needs neither node_modules nor a CDN).
//
// PLAN.md's "no dependencies" rule is deliberately broken here: axes, tick
// labels, and touch-capable zoom/pan is a large amount of pointer-event code
// with real edge cases, and uPlot is purpose-built for exactly this shape of
// data. It is the only runtime dependency in the project.
import uPlot from "../vendor/uPlot.esm.js";
import { parseDay } from "./dates.js";
import type { Sample } from "./estimate.js";

const DAY_SECONDS = 86_400;

/**
 * Height from width, so a chart given a desktop column does not stay a phone's
 * letterbox. The floor is the height the chart has always had, which is what a
 * phone gets: at 343 px of content the ratio asks for far less, and the shape
 * only starts growing past about 570 px. The ceiling stops a wide window from
 * turning the trend into a cliff — the y-axis spans a couple of kilos, and how
 * steep that looks is a property of the aspect ratio, not of the data.
 */
const MIN_HEIGHT = 240;
const MAX_HEIGHT = 340;
const RATIO = 0.42;

const heightFor = (width: number) =>
  Math.round(Math.min(Math.max(width * RATIO, MIN_HEIGHT), MAX_HEIGHT));

/**
 * How much history the chart opens on. Recent enough that day-to-day movement
 * is legible, long enough that the trend line means something. Everything older
 * is still there — zoom or pan out to reach it.
 */
const DEFAULT_SPAN_DAYS = 21;

/** Local midnight as unix seconds — uPlot's native x unit. */
const toX = (s: Sample) => parseDay(s.day).getTime() / 1000;

let plot: uPlot | null = null;
/** Full data extent, so pan/zoom can be clamped to it. */
let bounds = { min: 0, max: 0 };

/** The window the chart opens at and returns to on double-click. */
function defaultView(): { min: number; max: number } {
  return {
    min: Math.max(bounds.max - DEFAULT_SPAN_DAYS * DAY_SECONDS, bounds.min),
    max: bounds.max,
  };
}

/**
 * Wheel and pinch to zoom, drag to pan, double-click to reset. Replaces uPlot's
 * built-in drag-to-zoom, since drag is far more useful as scroll on a phone.
 */
function panZoom(): uPlot.Plugin {
  return {
    hooks: {
      ready(u: uPlot) {
        const over = u.over;

        /** Keeps the view inside the data and never narrower than a day. */
        const clamp = (min: number, max: number) => {
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

        over.addEventListener("dblclick", () => u.setScale("x", defaultView()));
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

function options(width: number): uPlot.Options {
  const c = theme();
  const axis = {
    stroke: c.dim,
    grid: { stroke: c.line, width: 1 },
    ticks: { stroke: c.line, width: 1 },
    font: "11px system-ui, sans-serif",
  };

  return {
    width,
    height: heightFor(width),
    padding: [8, 8, 0, 0],
    cursor: { drag: { x: false, y: false }, points: { size: 7 } },
    legend: { show: true, live: true, markers: { show: false } },
    scales: { x: { time: true } },
    axes: [
      { ...axis },
      { ...axis, size: 44, values: (_u, vals) => vals.map((v) => `${v.toFixed(1)}`) },
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
    ],
    plugins: [panZoom()],
  };
}

/**
 * Draws or updates the chart. Must be called while the container is visible —
 * uPlot sizes from the element, and a hidden section measures zero.
 */
export function drawTrend(el: HTMLElement, samples: Sample[], ewma: Sample[]): void {
  if (samples.length < 2) {
    plot?.destroy();
    plot = null;
    el.replaceChildren();
    return;
  }

  const data: uPlot.AlignedData = [samples.map(toX), samples.map((s) => s.kg), ewma.map((s) => s.kg)];
  bounds = { min: data[0][0]!, max: data[0][data[0].length - 1]! };

  const width = el.clientWidth;
  if (!width) return; // container still hidden; caller redraws on show

  if (plot) {
    // setData re-ranges x to the full extent, so the view has to be reapplied.
    plot.setData(data);
    plot.setSize({ width, height: heightFor(width) });
    plot.setScale("x", defaultView());
    return;
  }

  el.replaceChildren();
  plot = new uPlot(options(width), data, el);
  plot.setScale("x", defaultView());

  // Both dimensions, since the height is now a function of the width: a window
  // dragged wider, a phone turned sideways, or the sidebar appearing at 48rem
  // all change the shape and not just the span.
  new ResizeObserver(() => {
    const w = el.clientWidth;
    if (plot && w) plot.setSize({ width: w, height: heightFor(w) });
  }).observe(el);
}
