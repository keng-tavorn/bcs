import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

// react-pdf (ADR-044) reads Sarabun from assets/fonts when it renders, and pdfkit's ESM build loads its standard fonts
// through a require of *.cjs files the file tracer does not follow: both ship with every route that can render a
// printed PR or PO — the procurement and request pages, their downloads, and the jobs (FR-PLT-009, FR-P2P-005).
const PDF_FILES = ['./assets/fonts/sarabun/*.ttf', './node_modules/.pnpm/pdfkit@*/node_modules/pdfkit/js/standard-fonts/**/*.cjs']
// The button on /admin/line that makes both rich menus again reads their pictures from assets/line when it runs (§9.5, D-02)
const RICH_MENU_IMAGES = ['./assets/line/*.png']

const nextConfig: NextConfig = {
  // Next 16.3+ otherwise writes a managed block into CLAUDE.md and creates AGENTS.md when it detects
  // an AI agent. S1-01 requires keeping the user's CLAUDE.md untouched.
  agentRules: false,
  // e2e builds into a separate folder so they never clash with the shared `next dev` (.next)
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['exceljs', '@react-pdf/renderer'],
  outputFileTracingIncludes: { '/procurement/**': PDF_FILES, '/requests/**': PDF_FILES, '/api/inngest': PDF_FILES, '/admin/line': RICH_MENU_IMAGES },
}

export default withNextIntl(nextConfig)
