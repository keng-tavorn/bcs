// The organization's LINE channel (FR-ADM-006 AC2 AC3, §9.2): settings with sealed secrets, the connection test, the
// opened channel for the server's own work (webhook, senders, rich menus), the lock the link command takes, and the
// demo seed.

export { getLineChannelSettings, saveLineChannelCommand, saveLineChannelSettings, SaveLineChannelInput, type LineChannelSaveRefusal, type SaveLineChannelResult } from './settings'
export {
  LINE_CHECK_REASONS,
  LINE_CONNECTION_CHECKS,
  LINE_CONNECTION_TEST_BUDGET_MS,
  testLineConnection,
  type LineConnectionCheck,
  type LineConnectionCheckId,
  type LineConnectionReport,
  type LineConnectionTestOptions,
} from './connection-test'
export { openLineChannel, type OpenedLineChannel, type OpenLineChannelResult } from './credentials'
export { lockLineChannelForLinking, type LineChannelForLinking } from './linking'
export { describeLineSeed, LINE_SEED_IDEMPOTENCY_KEY, seedLineChannel, type LineSeedEnv, type LineSeedOutcome } from './seed'
