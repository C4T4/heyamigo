// Generic async-task estimator (non-browser background work).
//
// The general async lane is still on in-memory fastq (no durable
// table). Real duration samples aren't queryable yet → the estimate
// uses defaultMs every time until/unless that lane gets migrated to
// SQLite. Cards still surface useful "long task incoming" UX.

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

class AsyncTaskEstimator implements JobKindEstimator {
  readonly kind = 'async-task'

  // 3 min — generic background work tends to be moderate. A deeper
  // research task might run longer; a quick one shorter. Single
  // ballpark until we have real samples.
  readonly defaultMs = 3 * 60 * 1000

  matches(ctx: EstimationContext): boolean {
    return ctx.taskKind === 'async'
  }

  // No durable samples (general async lane is still in-memory fastq).
  // Returning [] forces aggregateMean to fall back to defaultMs.
  querySamples(): DurationSample[] {
    return []
  }

  estimate(samples: DurationSample[]): EstimateResult {
    return aggregateMean(samples, this.defaultMs)
  }

  format(estimate: EstimateResult): string {
    return `background task, ~${humanDur(estimate.pointMs)}`
  }
}

registerEstimator(new AsyncTaskEstimator())
