import type { MetadataRoute } from 'next'

// PWA manifest (spec §9.7, FR-PLT-005 AC1): installs as "BCS Workspace" with short name "BCS", opens standalone.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BCS Workspace',
    short_name: 'BCS',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    lang: 'th',
    background_color: '#ffffff',
    theme_color: '#0b6e5f',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
