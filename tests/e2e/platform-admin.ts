// A BCS-team account (PLATFORM_ADMIN, §2.2) for the e2e database only. The demo seed has no platform admin (Appendix A
// lists customer users only), so tests/e2e/prepare-db.ts adds this one after the seed. Password and TOTP come from
// SEED_DEV_PASSWORD and SEED_TOTP_KEY like the seeded users, so nothing secret is written in the repository.
export const E2E_PLATFORM_ADMIN = {
  email: 'platform-e2e@bcs.local',
  code: 'platform-e2e',
  displayName: 'ทีม BCS (ทดสอบ)',
} as const
