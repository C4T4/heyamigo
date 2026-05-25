// drizzle-kit config. Used only for `generate` and (optionally)
// `check`. The bot's boot path applies migrations directly via
// drizzle-orm's migrator — drizzle-kit is a dev-time tool.

import type { Config } from 'drizzle-kit'

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  // dbCredentials only needed for drizzle-kit's introspection commands
  // (which we don't use). Migrations are applied at boot from code, so
  // drizzle-kit never opens the real DB.
} satisfies Config
