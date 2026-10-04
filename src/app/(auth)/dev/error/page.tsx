import { notFound } from 'next/navigation'
import { getEnv } from '@/lib/env'

// The error page of the app (src/app/error.tsx) on purpose, on developer machines and in e2e runs only (404 on staging and
// production, as /dev/upload): nothing else fails on purpose, and the page needs its §9.9 checks — its words in Thai and
// English, axe, 44 px targets and both widths (tests/e2e/error-page.spec.ts). Rendered on every request, never at build.
export const dynamic = 'force-dynamic'

export default function ErrorOnPurposePage() {
  if (getEnv().APP_ENV !== 'local') notFound()
  throw new Error('the error page on purpose (APP_ENV=local)')
}
