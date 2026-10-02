import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const nextConfig: NextConfig = {
  // Next 16.3+ otherwise writes a managed block into CLAUDE.md and creates AGENTS.md when it detects
  // an AI agent. S1-01 requires keeping the user's CLAUDE.md untouched.
  agentRules: false,
  // e2e builds into a separate folder so they never clash with the shared `next dev` (.next)
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['exceljs'],
}

export default withNextIntl(nextConfig)
