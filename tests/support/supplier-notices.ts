import { sweepSupplierNotices } from '@/server/notifications/supplier-notices'

/**
 * Sends every supplier e-mail waiting in the e2e database (the job supplier-notice-send, which the e2e app does not run):
 * round after round until one sends nothing. A sweep takes the 50 oldest of the whole database, and the specs that ran
 * before (RFx, supplier applications …) leave theirs waiting, so one round can stop short of the calling run's notice.
 */
export async function sendAllSupplierNotices(): Promise<number> {
  let sent = 0
  for (let round = 0; round < 50; round += 1) {
    const n = await sweepSupplierNotices(new Date(Date.now() + 2 * 60_000))
    sent += n
    if (n === 0) break
  }
  return sent
}
