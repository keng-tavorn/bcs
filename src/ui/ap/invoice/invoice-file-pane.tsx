'use client'

import { ExternalLink } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FileButton } from '../../finance/file-button'
import { Button } from '../../form/button'
import { Notice } from '../../form/notice'
import { ListEmpty } from '../../page/page'
import { Skeleton } from '../../shadcn/skeleton'

// The left of the invoice's split page (NEW-115 · FR-AP-102 AC7): the supplier's file beside the values, from 1280 px up,
// so FINANCE checks one against the other without leaving the page. Only then is its address asked for: it is valid 5
// minutes and a phone never needs it (a phone downloads the file from the tab ที่มา, as before). A PDF or a picture opens
// in the page; an e-Tax XML has no page to show, and is downloaded.

const WIDE = '(min-width: 80rem)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia(WIDE)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function InvoiceFilePane({
  file,
  etax,
  open,
}: {
  file: { readonly id: string; readonly fileName: string; readonly inline: boolean } | null
  /** The values were read from this file: it says so where a page would be */
  etax: boolean
  open: (fileId: string) => Promise<string | null>
}) {
  const t = useTranslations('apInvoice')
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false)
  const [shown, setShown] = useState<{ readonly attempt: number; readonly url: string | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [newTabFailed, setNewTabFailed] = useState(false)
  const inPage = file?.inline ? file.id : null
  // The page refreshes after every save and hands a new action: the file stays as it is, scrolled where it was
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])
  useEffect(() => {
    if (!wide || !inPage) return
    let gone = false
    void openRef
      .current(inPage)
      .catch(() => null)
      .then((url) => {
        if (!gone) setShown({ attempt, url })
      })
    return () => {
      gone = true
    }
  }, [wide, inPage, attempt])

  /** A new address each time: the page may have been open longer than the last one lasts */
  async function openInNewTab() {
    if (!file) return
    setNewTabFailed(false)
    const tab = window.open('', '_blank')
    const url = await open(file.id).catch(() => null)
    if (url && tab) tab.location.href = url
    else {
      tab?.close()
      setNewTabFailed(true)
    }
  }

  const url = shown?.attempt === attempt ? shown.url : null
  const failed = shown?.attempt === attempt && !shown.url
  return (
    <section
      aria-label={t('viewer.region')}
      data-invoice-file-pane
      className="hidden min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-bg xl:sticky xl:top-[4.5rem] xl:flex xl:h-[calc(100dvh-5.5rem)]"
    >
      {file ? (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-3 py-1">
          <span className="min-w-0 truncate font-medium text-ink" title={file.fileName}>
            {file.fileName}
          </span>
          {file.inline ? (
            <Button variant="secondary" className="shrink-0" onClick={() => void openInNewTab()}>
              <ExternalLink data-icon="inline-start" aria-hidden="true" />
              {t('viewer.newTab')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {newTabFailed ? <Notice tone="danger">{t('file.failed')}</Notice> : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {!file ? (
          <ListEmpty title={t('file.none')} hint={t('viewer.noneHint')} className="my-auto" />
        ) : !file.inline ? (
          <div className="my-auto flex flex-col items-center gap-3 p-6 text-center">
            <p className="font-medium text-ink">{t('viewer.notInPage')}</p>
            <p className="max-w-md text-ink-muted">{etax ? t('viewer.etaxHint') : t('viewer.notInPageHint')}</p>
            <FileButton fileId={file.id} label={t('file.open', { name: file.fileName })} busyLabel={t('file.opening', { name: file.fileName })} failedText={t('file.failed')} open={open} />
          </div>
        ) : failed ? (
          <div className="my-auto flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-ink">{t('file.failed')}</p>
            <Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
              {t('viewer.retry')}
            </Button>
          </div>
        ) : url ? (
          <iframe title={t('viewer.title', { name: file.fileName })} src={url} className="min-h-0 w-full flex-1 bg-surface" />
        ) : (
          <div className="flex flex-1 flex-col gap-3 p-4" role="status" aria-label={t('viewer.loading')}>
            <Skeleton className="h-full w-full" />
          </div>
        )}
      </div>
    </section>
  )
}
