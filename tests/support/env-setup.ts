// Loaded before every integration/generated test file: point the app at the test database.
import { config } from 'dotenv'
import { testAppUrl, testMigratorUrl } from './test-db'

config({ path: '.env', quiet: true })
process.env.DATABASE_URL = testAppUrl()
process.env.DIRECT_URL = testMigratorUrl()
