// Image-generation estimator. Matches when the user message looks
// like a request to produce an image. Tracks duration of the chat-
// track turn that handles it (claimedAt → updatedAt on the inbound
// row).

import { aggregateMean, registerEstimator } from './registry.js'
import type {
  DurationSample,
  EstimateResult,
  EstimationContext,
  JobKindEstimator,
} from './types.js'

// Conservative regex. Requires a generation verb AND an image-class
// noun within 80 chars. Prefers false-negative to false-positive —
// a single mistagged sample drags the average for everyone.
const IMAGE_GEN_RE =
  /\b(generate|create|make|draw|render|design|sketch|paint|illustrate)\b[^.?!\n]{0,80}\b(image|picture|drawing|art|artwork|photo|portrait|illustration|sketch|render|painting|wallpaper|logo|icon|graphic)\b/i

class ImageGenEstimator implements JobKindEstimator {
  readonly kind = 'image-gen'

  // 30s starting point — reasonable ballpark for current
  // image-generation APIs (DALL-E 3, Imagen, Flux, etc.). The very
  // first request shows this; from sample 1 onward it averages real
  // observations.
  readonly defaultMs = 30_000

  matches(ctx: EstimationContext): boolean {
    return IMAGE_GEN_RE.test(ctx.description)
  }

  estimate(samples: DurationSample[]): EstimateResult {
    return aggregateMean(samples, this.defaultMs)
  }

  format(estimate: EstimateResult): string {
    if (estimate.rangeMs) {
      return `generating image, anywhere from ~${secs(estimate.rangeMs.lowMs)} to ~${secs(estimate.rangeMs.highMs)}`
    }
    return `generating image, ~${secs(estimate.pointMs)}`
  }
}

function secs(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.round(s / 60)}min`
}

registerEstimator(new ImageGenEstimator())
