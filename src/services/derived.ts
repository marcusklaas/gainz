// Memoized derived views over the store, keyed by store.revision() and view
// date. Any write to the store bumps the revision automatically, so cached
// estimates stay valid across tab switches without manual invalidation.
import { addDays } from "../core/dates.js";
import { estimate, type Estimate } from "../core/estimate.js";
import { cachedConfig, cachedRange, revision } from "./store.js";
import type { Config, Day, DayKey } from "../core/types.js";

export interface HistorySnapshot {
  rev: number;
  day: DayKey;
  cfg: Config;
  past: Map<DayKey, Day>;
  est: Estimate | null;
}

let cached: HistorySnapshot | null = null;

/**
 * Returns the loaded history window and fitted estimate for `viewDay`,
 * recomputing only when the store revision or target day changed.
 * Null when no config exists yet.
 */
export function historyFor(viewDay: DayKey): HistorySnapshot | null {
  const rev = revision();
  if (cached && cached.rev === rev && cached.day === viewDay) return cached;

  const cfg = cachedConfig();
  if (!cfg) {
    cached = null;
    return null;
  }

  const past = cachedRange(addDays(viewDay, -cfg.estimator.historyDays), viewDay);
  const est = estimate(cfg, past, viewDay);
  cached = { rev, day: viewDay, cfg, past, est };
  return cached;
}
