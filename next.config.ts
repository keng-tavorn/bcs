import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

// Messages are compiled when the app is built (next-intl's precompile): the browser then formats them without the ICU
// parser, some 9 KB gzip less in the first JavaScript of every page — a LIFF page loads at most 200 KB gzip with the LINE
// SDK and its page data (§9.4). Every JSON file under messages/ that the app imports is compiled, so code that reads a
// message with arguments formats it through next-intl, never by replacing text in it (src/app/global-error.tsx); a
// message without arguments stays a plain string. tests/unit/messages-precompile.test.ts checks that every message
// compiles and reads as it did before.
const withNextIntl = createNextIntlPlugin({
  requestConfig: './src/i18n/request.ts',
  experimental: { messages: { path: './messages', format: 'json', locales: 'infer', precompile: true } },
})

// react-pdf (ADR-044) reads Sarabun from assets/fonts when it renders, and pdfkit's ESM build loads its standard fonts
// through a require of *.cjs files the file tracer does not follow: both ship with every route that can render a
// printed PR or PO — the procurement and request pages, their downloads, and the jobs (FR-PLT-009, FR-P2P-005).
const PDF_FILES = ['./assets/fonts/sarabun/*.ttf', './node_modules/.pnpm/pdfkit@*/node_modules/pdfkit/js/standard-fonts/**/*.cjs']
// The button on /admin/line that makes every rich menu set again reads their pictures from assets/line when it runs (§9.5, D-02, S17-04)
// The staging seed jobs read the input workbooks and the seed YAML files from the project root when they run (ADR-055): the
// reset reads both workbooks — its guard names the organizations of each, and it seeds either (P1-11, ADR-073)
const SEED_FILES = ['./docs/inputs/BCS_inputs_v1_demo.xlsx', './docs/inputs/BCS_inputs_p1.xlsx', './prisma/seed/*.yaml']
const RICH_MENU_IMAGES = ['./assets/line/*.png']

const nextConfig: NextConfig = {
  // The build's own mark, fixed when it is built: the service worker's version where no commit is given (local, e2e).
  // Read at run time instead, it changed whenever an action revalidated every page — /sw.js too — and the page then
  // offered a "new version" of the same build (P1-09)
  env: { BCS_BUILD_STAMP: String(Date.now()) },
  // Next 16.3+ otherwise writes a managed block into CLAUDE.md and creates AGENTS.md when it detects
  // an AI agent. S1-01 requires keeping the user's CLAUDE.md untouched.
  agentRules: false,
  // e2e builds into a separate folder so they never clash with the shared `next dev` (.next)
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['exceljs', '@react-pdf/renderer'],
  outputFileTracingIncludes: { '/procurement/**': PDF_FILES, '/requests/**': PDF_FILES, '/api/inngest': [...PDF_FILES, ...SEED_FILES], '/admin/line': RICH_MENU_IMAGES },
}

export default withNextIntl(nextConfig)
