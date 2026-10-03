'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'

// The proofs a person attached when the registries could not confirm the supplier (BR-SUP-03): each opens through a
// short-lived address the server signs only for those who see the register in full (FR-PLT-004 AC2). A window opened by
// the click itself is not blocked; the address arrives a moment later.

export interface ProofItem {
  readonly fileId: string
  readonly fileName: string
  /** e.g. the file's size, already formatted */
  readonly detail: string
}

export function ProofList({ proofs, open }: { proofs: readonly ProofItem[]; open: (fileId: string) => Promise<string | null> }) {
  const t = useTranslations('suppliers.detail')
  const [failed, setFailed] = useState(false)
  function openFile(fileId: string) {
    setFailed(false)
    const opened = window.open('', '_blank')
    if (opened) opened.opener = null
    // No answer (a dropped connection) is told like a refusal: the empty window closes and the reason shows
    void open(fileId)
      .catch(() => null)
      .then((url) => {
        if (url && opened) opened.location.href = url
        else {
          opened?.close()
          setFailed(true)
        }
      })
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {proofs.map((p) => (
          <li key={p.fileId} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="min-w-0 break-words">
              <span className="font-medium">{p.fileName}</span>
              <span className="text-ink-muted"> · {p.detail}</span>
            </p>
            <Button variant="link" className="shrink-0 self-start sm:self-auto" onClick={() => openFile(p.fileId)}>
              {t('openProof', { name: p.fileName })}
            </Button>
          </li>
        ))}
      </ul>
      {failed ? <Notice tone="danger">{t('proofNotOpened')}</Notice> : null}
    </div>
  )
}
