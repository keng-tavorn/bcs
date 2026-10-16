import { assetLinksOf } from '@/lib/app-client'
import { ASSET_LINKS_MAX_AGE_S } from '@/lib/constants'
import { getEnv } from '@/lib/env'

// GET /.well-known/assetlinks.json (S17-09, ADR-166): ties this domain to the BCS Go Android app for passkeys in its
// WebView. Public and read-only like every .well-known file; 404 while the environment names no app.
export const dynamic = 'force-dynamic'

const NOT_FOUND = 404

export function GET(): Response {
  const env = getEnv()
  const statements = assetLinksOf(env.BCS_GO_ANDROID_PACKAGE, env.BCS_GO_ANDROID_CERT_SHA256)
  if (!statements) return new Response(null, { status: NOT_FOUND, headers: { 'cache-control': 'no-store' } })
  return Response.json(statements, { headers: { 'cache-control': `public, max-age=${ASSET_LINKS_MAX_AGE_S}` } })
}
