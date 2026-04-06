import fastq from 'fastq'
import type { queueAsPromised } from 'fastq'
import { logger } from '../logger.js'
import { loadPendingJobs, persistJob, removeJob } from './persistence.js'
import type { Job, Result } from './types.js'
import { processJob } from './worker.js'

type JobQueue = queueAsPromised<Job, Result>

const queues = new Map<string, JobQueue>()

function getQueue(jid: string): JobQueue {
  let q = queues.get(jid)
  if (!q) {
    q = fastq.promise<unknown, Job, Result>(async (job: Job) => {
      try {
        const result = await processJob(job)
        removeJob(job)
        return result
      } catch (err) {
        removeJob(job)
        throw err
      }
    }, 1)
    queues.set(jid, q)
  }
  return q
}

export async function enqueue(job: Job): Promise<Result> {
  persistJob(job)
  return getQueue(job.jid).push(job)
}

/**
 * On boot, replay any jobs that were persisted but never completed
 * (process crashed mid-queue). Returns a promise that resolves when
 * all replayed jobs finish or fail. Caller provides a handler for
 * results since the original WAMessage context is gone.
 */
export async function replayPending(
  onResult: (job: Job, result: Result) => Promise<void>,
): Promise<void> {
  const pending = loadPendingJobs()
  if (!pending.length) return

  logger.info(
    { count: pending.length },
    'replaying pending jobs from last session',
  )

  const promises = pending.map(async (job) => {
    try {
      const result = await getQueue(job.jid).push(job)
      await onResult(job, result)
    } catch (err) {
      logger.error(
        { err, jid: job.jid },
        'replayed job failed',
      )
    }
  })

  await Promise.allSettled(promises)
}
