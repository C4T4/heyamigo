// Generic browser-task estimator. Matches any agent-delegated
// [ASYNC-BROWSER:] task. Pulls duration samples from the durable
// browser_tasks table so the average reflects real observed runtimes.

import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { browserTasks } from '../db/schema.js'
import {
  aggregateMean,
  humanDur,
  registerEstimator,
} from './registry.js'
import type {
  DurationSample,
  EstimateResult,
  EstimationContext,
  JobKindEstimator,
} from './types.js'

class BrowserTaskEstimator implements JobKindEstimator {
  readonly kind = 'browser-task'

  // 5 min is a reasonable ballpark for IG/TT scrapes. Real samples
  // dominate after the first 1-2 jobs.
  readonly defaultMs = 5 * 60 * 1000

  matches(ctx: EstimationContext): boolean {
    return ctx.taskKind === 'async-browser'
  }

  querySamples(limit: number = 20): DurationSample[] {
    const db = getDb()
    // All done browser tasks — single bucket. Could be sliced further
    // (per-domain) later via more-specific estimators registered ahead
    // of this catch-all.
    const rows = db
      .select({
        claimedAt: browserTasks.claimedAt,
        updatedAt: browserTasks.updatedAt,
      })
      .from(browserTasks)
      .where(
        and(
          eq(browserTasks.status, 'done'),
          isNotNull(browserTasks.claimedAt),
        ),
      )
      .orderBy(desc(browserTasks.id))
      .limit(limit)
      .all()
    return rows
      .filter((r) => r.claimedAt !== null)
      .map((r) => ({
        durationMs: (r.updatedAt - (r.claimedAt as number)) * 1000,
        finishedAt: r.updatedAt,
      }))
      .filter((s) => s.durationMs > 0)
  }

  estimate(samples: DurationSample[]): EstimateResult {
    return aggregateMean(samples, this.defaultMs)
  }

  format(estimate: EstimateResult): string {
    if (estimate.rangeMs) {
      return `browser task, ~${humanDur(estimate.rangeMs.lowMs)} to ~${humanDur(estimate.rangeMs.highMs)}`
    }
    return `browser task, ~${humanDur(estimate.pointMs)}`
  }
}

registerEstimator(new BrowserTaskEstimator())
