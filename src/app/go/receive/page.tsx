import { getTranslations } from 'next-intl/server'
import { GoReceiveApp } from '@/ui/go-receive/go-receive-app'

export async function generateMetadata() {
  const t = await getTranslations('goReceive')
  return { title: t('title') }
}

// /go/receive (S17-13, FR-PLT-301 AC7 to AC9): receiving on site with or without a signal, for a receiver in the BCS Go
// app or the PWA. The page is a shell (src/app/go/layout.tsx): its copies of the POs and its queue of receipts live in
// the phone's IndexedDB and go through /api/go/* (src/ui/go-receive). The module and the receiver's scope are checked
// there (BR-APP-13): with BCS_GO off nothing new is prepared, and what is queued still goes.
export default async function GoReceivePage() {
  const t = await getTranslations('goReceive')
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <GoReceiveApp />
    </div>
  )
}
