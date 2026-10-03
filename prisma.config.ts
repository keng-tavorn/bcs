// Prisma 7 CLI config (spec §5.2). The CLI connects as the migrator role (DIRECT_URL);
// the app connects as bcs_app through the pg driver adapter (src/server/db/client.ts).
// Outside APP_ENV=local every Prisma CLI command checks the whole environment first (src/lib/env.ts), so a
// `prisma migrate deploy` started directly meets the same DIRECT_URL host, role and password rules as
// `pnpm db:migrate` (FR-PLT-006 AC3, §4.12) and stops before it connects.
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'
import { EnvError, envIssuesOutsideLocal } from './src/lib/env'

const issues = envIssuesOutsideLocal(process.env)
if (issues.length > 0) throw new EnvError(issues)

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: env('DIRECT_URL') },
})
