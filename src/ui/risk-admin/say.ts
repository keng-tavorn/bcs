'use client'

import { useTranslations } from 'next-intl'

// The risk admin screens build message keys from codes the server sends (a refusal's reason, a lint issue, a field of a
// condition) and ask has() first; next-intl's typed keys cannot follow a key made at run time, so these screens read the
// namespace through this loose view of the same translator.

export interface Say {
  (key: string, values?: Record<string, string | number>): string
  has(key: string): boolean
}

export function useSay(namespace: `risk.${string}`): Say {
  return useTranslations(namespace as 'risk') as unknown as Say
}
