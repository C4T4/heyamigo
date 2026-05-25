import { formatAddress, jidToAddress } from '../db/address.js'
import type { Job } from './types.js'

export function addressForJob(job: Pick<Job, 'jid' | 'address'>): string {
  return job.address ?? formatAddress(jidToAddress(job.jid))
}

