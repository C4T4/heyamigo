// Derive persons + identities from existing config/access.json. Runs
// at boot, idempotently. The file stays authoritative; the DB rows
// are a *derived view* so future queue rows can reference person_id
// without joining against the file every time.
//
// No schema change to access.json. Phase 0 doesn't touch the file.
// Person mapping:
//   - config.owner.number             → person-owner
//   - each entry in access.users      → person-<sanitized-number>
//   - each entry in access.dms.allowed → ensure a person exists
//   - groups are addresses, not persons — skipped
//
// Re-running the sync on every boot:
//   - upserts display_name (in case access.json was edited)
//   - adds new identities (in case the owner added a number)
//   - never deletes (avoid surprise data loss; explicit cleanup
//     command can come later)

import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { jidToAddress, formatAddress } from './address.js'
import { getDb } from './index.js'
import { identities, persons } from './schema.js'
import { getAccess } from '../wa/whitelist.js'

const OWNER_PERSON_ID = 'person-owner'

function personIdForNumber(number: string): string {
  // Strip non-digits, prefix with 'person-'. Stable + deterministic.
  const sanitized = number.replace(/\D/g, '')
  return `person-${sanitized}`
}

function dmAddressFor(number: string): string {
  const sanitized = number.replace(/\D/g, '')
  return formatAddress(jidToAddress(`${sanitized}@s.whatsapp.net`))
}

type PersonSeed = {
  id: string
  displayName: string | null
  addresses: string[]
}

function collectSeeds(): PersonSeed[] {
  const access = getAccess()
  const now = Math.floor(Date.now() / 1000)
  void now
  const out: Map<string, PersonSeed> = new Map()

  // Owner
  if (config.owner.number) {
    out.set(OWNER_PERSON_ID, {
      id: OWNER_PERSON_ID,
      displayName: 'Owner',
      addresses: [dmAddressFor(config.owner.number)],
    })
  }

  // Users
  for (const [number, entry] of Object.entries(access.users ?? {})) {
    const id =
      number === config.owner.number ? OWNER_PERSON_ID : personIdForNumber(number)
    const existing = out.get(id)
    const addr = dmAddressFor(number)
    if (existing) {
      if (entry.name) existing.displayName = entry.name
      if (!existing.addresses.includes(addr)) existing.addresses.push(addr)
    } else {
      out.set(id, {
        id,
        displayName: entry.name ?? null,
        addresses: [addr],
      })
    }
  }

  // DM allowed — ensure persons exist, even without a name
  for (const dm of access.dms?.allowed ?? []) {
    const id =
      dm.number === config.owner.number ? OWNER_PERSON_ID : personIdForNumber(dm.number)
    const addr = dmAddressFor(dm.number)
    const existing = out.get(id)
    if (existing) {
      if (!existing.addresses.includes(addr)) existing.addresses.push(addr)
    } else {
      out.set(id, { id, displayName: null, addresses: [addr] })
    }
  }

  return [...out.values()]
}

// Idempotent upsert. Inserts new rows; updates display_name on existing
// person rows (in case it was filled in later); never deletes.
export function syncIdentitiesFromAccess(): {
  personsUpserted: number
  identitiesUpserted: number
} {
  const db = getDb()
  const seeds = collectSeeds()
  const now = Math.floor(Date.now() / 1000)

  let personsUpserted = 0
  let identitiesUpserted = 0

  db.transaction((tx) => {
    for (const seed of seeds) {
      const existing = tx
        .select()
        .from(persons)
        .where(eq(persons.id, seed.id))
        .all()
      if (existing.length === 0) {
        tx.insert(persons)
          .values({
            id: seed.id,
            displayName: seed.displayName,
            timezone: config.owner.timezone,
            createdAt: now,
          })
          .run()
        personsUpserted++
      } else if (
        seed.displayName &&
        existing[0]!.displayName !== seed.displayName
      ) {
        tx.update(persons)
          .set({ displayName: seed.displayName })
          .where(eq(persons.id, seed.id))
          .run()
        personsUpserted++
      }

      for (const addr of seed.addresses) {
        const have = tx
          .select()
          .from(identities)
          .where(eq(identities.address, addr))
          .all()
        if (have.length === 0) {
          tx.insert(identities)
            .values({ personId: seed.id, address: addr, addedAt: now })
            .run()
          identitiesUpserted++
        }
        // If have.length > 0 but personId differs, leave it — manual
        // merge required. Don't reassign silently.
      }
    }
  })

  logger.info(
    { personsUpserted, identitiesUpserted, seeded: seeds.length },
    'identity sync from access.json complete',
  )
  return { personsUpserted, identitiesUpserted }
}

// Lookup helper used by the inbound resolution step (in later phases).
// Returns null if the address has no matching person — caller decides
// whether to auto-create or treat as stranger.
export function personIdForAddress(address: string): string | null {
  const db = getDb()
  const row = db
    .select({ personId: identities.personId })
    .from(identities)
    .where(eq(identities.address, address))
    .get()
  return row?.personId ?? null
}
