// Estimates module entry point. Importing this side-effect-loads
// every built-in plugin (each plugin file calls registerEstimator()
// at module load). Outside callers only need:
//
//   import { classify, estimate } from './estimates/index.js'
//
// Adding a new kind = drop a file alongside image-gen.ts and import
// it below. No other code in the codebase needs to change.

import './image-gen.js'
// future: import './browser-ig.js'
// future: import './voice-gen.js'

export {
  classify,
  estimate,
  formatEstimateDefault,
  humanDur,
  listEstimators,
  querySamplesForKind,
  registerEstimator,
} from './registry.js'
export type {
  Confidence,
  DurationSample,
  EstimateResult,
  EstimationContext,
  JobKindEstimator,
} from './types.js'
