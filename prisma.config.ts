// Prisma 7 CLI config (spec §5.2). The CLI connects as the migrator role (DIRECT_URL);
// the app connects as bcs_app through the pg driver adapter (src/server/db/client.ts).
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: env('DIRECT_URL') },
})
