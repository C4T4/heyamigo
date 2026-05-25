// Estimator registry + the single entry points the rest of the bot
// uses: classify() and estimate(). Plugins self-register by importing
// this module and calling registerEstimator().

import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { inbound } from '../db/schema.js'
import type {
  DurationSample,
  EstimateResult,
  EstimationContext,
  JobKindEstimator,
} from './types.js'

const REGISTRY: JobKindEstimator[] = []

export function registerEstimator(e: JobKindEstimator): void {
  // Idempotent on kind so hot-reload during dev doesn't duplicate.
  const i = REGISTRY.findIndex((x) => x.kind === e.kind)
  if (i >= 0) REGISTRY[i] = e
  else REGISTRY.push(e)
}

export function listEstimators(): readonly JobKindEstimator[] {
  return REGISTRY
}

// Find the first estimator whose matches() returns true. First-match
// wins — order matters when registering. More-specific kinds should
// register before broad fallbacks.
export function classify(ctx: EstimationContext): JobKindEstimator | null {
  for (const e of REGISTRY) {
    if (e.matches(ctx)) return e
  }
  return null
}

// Pull the last N completed inbound rows for this kind. Returns
// newest-first; estimators that care about recency can use that
// order directly, the mean-based aggregator below doesn't.
//
// Limited to N=20 by default. The mean is fast and stable past 5-10
// samples; older data isn't helpful and risks staleness.
const SAMPLE_LIMIT = 20

export function querySamplesForKind(
  kind: string,
  limit: number = SAMPLE_LIMIT,
): DurationSample[] {
  const db = getDb()
  const rows = db
    .select({
      claimedAt: inbound.claimedAt,
      updatedAt: inbound.updatedAt,
    })
    .from(inbound)
    .where(
      and(
        eq(inbound.kind, kind),
        eq(inbound.status, 'done'),
        isNotNull(inbound.claimedAt),
      ),
    )
    .orderBy(desc(inbound.id))
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

// Public entry point. Returns the kind + formatted text, or null
// when no estimator matched (i.e. this isn't a job-kind we estimate).
// If an estimator matches, the result is ALWAYS non-null — the
// estimator falls back to its defaultMs when no samples exist.
export function estimate(
  ctx: EstimationContext,
): { kind: string; result: EstimateResult; text: string } | null {
  const e = classify(ctx)
  if (!e) return null
  // Estimator's own querySamples (if provided) takes precedence —
  // browser/async estimators pull from their dedicated tables. Otherwise
  // fall back to the inbound-by-kind default.
  const samples = e.querySamples ? e.querySamples() : querySamplesForKind(e.kind)
  const result = e.estimate(samples)
  const text = (e.format ?? formatEstimateDefault)(result)
  return { kind: e.kind, result, text }
}

// Default UX-friendly rendering. Each estimator can override.
export function formatEstimateDefault(r: EstimateResult): string {
  if (r.rangeMs) {
    return `anywhere from ~${humanDur(r.rangeMs.lowMs)} to ~${humanDur(r.rangeMs.highMs)}`
  }
  return `~${humanDur(r.pointMs)}`
}

export function humanDur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}min`
  return `${Math.round(m / 60)}h`
}

// Shared aggregator used by built-in estimators. Each estimator may
// implement its own estimate() but most just call this.
export function aggregateMean(
  samples: DurationSample[],
  defaultMs: number,
): EstimateResult {
  if (samples.length === 0) {
    return { pointMs: defaultMs, sampleSize: 0, confidence: 'low' }
  }
  const ds = samples.map((s) => s.durationMs)
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length
  if (samples.length === 1) {
    return { pointMs: mean, sampleSize: 1, confidence: 'low' }
  }
  const variance =
    ds.reduce((acc, x) => acc + (x - mean) ** 2, 0) / ds.length
  const std = Math.sqrt(variance)
  const confidence =
    samples.length >= 10 ? 'high' : samples.length >= 5 ? 'medium' : 'low'
  // Disclose range when stddev is a large fraction of the mean.
  // Threshold chosen at 50% — beyond that, a single point estimate
  // hides too much.
  return std / mean > 0.5
    ? {
        pointMs: mean,
        sampleSize: samples.length,
        confidence,
        rangeMs: {
          lowMs: Math.max(0, mean - std),
          highMs: mean + std,
        },
      }
    : { pointMs: mean, sampleSize: samples.length, confidence }
}
