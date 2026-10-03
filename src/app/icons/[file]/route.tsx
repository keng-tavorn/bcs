import { getTranslations } from 'next-intl/server'
import { defaultLocale } from '@/i18n/locales'
import { appIcon } from '../../_lib/app-icon'

// Manifest icons (spec §9.7), drawn at build time.
const ICONS: Record<string, { size: number; maskable: boolean }> = {
  'icon-192.png': { size: 192, maskable: false },
  'icon-512.png': { size: 512, maskable: false },
  'maskable-512.png': { size: 512, maskable: true },
}

export const dynamic = 'force-static'

export function generateStaticParams() {
  return Object.keys(ICONS).map((file) => ({ file }))
}

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const icon = ICONS[(await params).file]
  if (!icon) return new Response(null, { status: 404 })
  const t = await getTranslations({ locale: defaultLocale, namespace: 'auth' })
  return appIcon(icon.size, icon.maskable, t('brand'))
}
