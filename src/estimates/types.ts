// Job duration estimation interface. The system stays "blackbox" by
// design — outside callers only touch the registry's classify() /
// estimate() functions. Each kind plugs in via a self-contained file
// in src/estimates/<kind>.ts that calls registerEstimator() at module
// load.

export type EstimationContext = {
  // The message / task description that's about to be processed.
  description: string
  // Attachments on the incoming message. Some estimators key off this
  // (e.g. a future image-analysis estimator that matches when an
  // image is attached).
  attachments?: { kind: 'image' | 'video' | 'audio' | 'document' | 'sticker' }[]
  // Resolved person id, when available. Estimators that want
  // per-user calibration can read this.
  senderPersonId?: string
  // Discriminator for "where is this estimate happening?":
  //   undefined        — direct user input (ingest from gateway)
  //   'async'          — agent-delegated background task ([ASYNC:])
  //   'async-browser'  — agent-delegated browser task ([ASYNC-BROWSER:])
  // User-input estimators (image-gen) match only when this is unset.
  // Task estimators (browser/async) match only when it's set.
  // Prevents image-gen from matching agent-generated [ASYNC-BROWSER:
  // generate marketing image] descriptions and confusing kinds.
  taskKind?: 'async' | 'async-browser'
}

export type DurationSample = {
  durationMs: number
  finishedAt: number   // unix seconds
}

export type Confidence = 'low' | 'medium' | 'high'

export type EstimateResult = {
  // Best-guess duration in milliseconds. Mean of samples, or the
  // estimator's defaultMs when no samples exist.
  pointMs: number
  // How many past samples informed this estimate. 0 = first ever
  // request of this kind.
  sampleSize: number
  // Cheap UX flag: low/medium/high based on sampleSize + variance.
  confidence: Confidence
  // Disclosed range when variance is high (stddev > 50% of mean).
  // Absent when point estimate is "tight."
  rangeMs?: { lowMs: number; highMs: number }
}

// Each kind owns its own classification + aggregation. Outside code
// never inspects the estimator's internals — it just iterates the
// registry, asks each one "is this you?", then calls estimate().
export interface JobKindEstimator {
  readonly kind: string

  // Sensible duration fallback when no samples exist yet. Per-kind
  // because "30s" is right for image-gen and wrong for a 5min
  // browser scrape. Self-corrects as soon as real samples land.
  readonly defaultMs: number

  // Cheap synchronous check. Should be conservative: prefer "no
  // match" over "wrong match" — a misclassified sample poisons the
  // average.
  matches(ctx: EstimationContext): boolean

  // Optional custom sample source. Default (when omitted) is to query
  // `inbound` rows tagged with this kind. Browser-task and async-task
  // estimators override this to query their own respective tables
  // (browser_tasks for the durable browser queue; in-memory async
  // tasks have no samples so the async estimator returns []).
  querySamples?(limit?: number): DurationSample[]

  // Given the last N samples for this kind, produce an estimate.
  // ALWAYS returns a value: 0 samples → use defaultMs; 1+ samples →
  // mean. Never returns null.
  estimate(samples: DurationSample[]): EstimateResult

  // Optional kind-specific rendering. Defaults to "(~Xs / Xmin /
  // Xh)" via formatEstimateDefault() in registry.ts.
  format?(estimate: EstimateResult): string
}
