// Estimates module entry point. Importing this side-effect-loads
// every built-in plugin (each plugin file calls registerEstimator()
// at module load). Outside callers only need:
//
//   import { classify, estimate } from './estimates/index.js'
//
// Adding a new kind = drop a file alongside image-gen.ts and import
// it below. No other code in the codebase needs to change.

// Order matters: more-specific estimators register first so they win
// classify() over the catch-all task estimators. image-gen and other
// user-input matchers can run first because they explicitly DON'T
// match when ctx.taskKind is set.
import './image-gen.js'
import './browser-task.js'   // catches all [ASYNC-BROWSER:] tasks
import './async-task.js'      // catches all [ASYNC:] tasks
// future: import './browser-ig.js'   // more specific than browser-task
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
