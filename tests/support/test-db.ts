// Which database integration tests use. Parallel agents set BCS_TEST_DB to their own name (e.g. bcs_test_a1)
// so runs never interfere; the default is bcs_test.
import { appUrl, migratorUrl } from '../../scripts/lib/db-urls'

export const TEST_DB = process.env.BCS_TEST_DB ?? 'bcs_test'
export const testAppUrl = () => appUrl(TEST_DB)
export const testMigratorUrl = () => migratorUrl(TEST_DB)
