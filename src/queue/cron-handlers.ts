// In-process handler registry for the 'internal' cron target.
//
// Not every periodic task fits the queue→worker model. Things like
// "run the journal observer sweep" or "regenerate compressed memory"
// are pure in-process work — there's no queue to enqueue into, the
// orchestrator just needs to call a function.
//
// Mechanism: cron rows with enqueue_into='internal' carry a payload
// with `handler: <name>`. The dispatcher looks up the name in this
// registry and invokes the function. Registry is populated at boot,
// before the orchestrator starts polling.

import { logger } from '../logger.js'

export type InternalCronHandler = () => Promise<void> | void

const registry = new Map<string, InternalCronHandler>()

export function registerInternalCronHandler(
  name: string,
  handler: InternalCronHandler,
): void {
  if (registry.has(name)) {
    logger.warn({ name }, 'internal cron handler already registered; overwriting')
  }
  registry.set(name, handler)
}

export function getInternalCronHandler(
  name: string,
): InternalCronHandler | undefined {
  return registry.get(name)
}

export function listInternalCronHandlers(): string[] {
  return [...registry.keys()]
}
