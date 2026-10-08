import type { MetadataRoute } from 'next'
import { THEME_COLORS } from '@/ui/theme'

// PWA manifest (spec §9.7, FR-PLT-005 AC1): installs as "BCS Workspace" with short name "BCS", opens standalone.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BCS Workspace',
    short_name: 'BCS',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    lang: 'th',
    background_color: THEME_COLORS.bg,
    theme_color: THEME_COLORS.primary,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
