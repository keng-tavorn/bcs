'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import { StatusBadge } from '../document/badges'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Switch } from '../shadcn/switch'
import { refusalKey, type ContactActionResult } from './contacts-panel'

// The "พอร์ทัล" tab of /suppliers/[id] (S7-09 · BR-PORTAL ข้อ 01 ข้อ 03): whether the supplier may use the portal
// (Supplier.portalEnabled, set when its application is approved — no command switches it from here yet, so it is read
// only), the sign-in address of the organization's portal to give the contacts, and, for each active contact, whether
// they may sign in. PROCUREMENT (supplier.contact.manage) switches a contact's access; switching it off ends their
// sessions in the same transaction, and it can be switched on again, so it asks nothing first.

export interface PortalContactView {
  readonly id: string
  readonly version: number
  readonly nameTh: string
  readonly nameEn: string | null
  readonly roleLabel: string | null
  readonly isPrimary: boolean
  readonly portalEnabled: boolean
}

export interface PortalView {
  readonly portalEnabled: boolean
  readonly supplierStatus: 'ACTIVE' | 'INACTIVE'
  readonly loginUrl: string
  readonly canManage: boolean
  readonly contacts: readonly PortalContactView[]
}

export function PortalPanel({ view, setAccess }: { view: PortalView; setAccess: (contactId: string, version: number, portalEnabled: boolean, key: string) => Promise<ContactActionResult> }) {
  const t = useTranslations('supplierContacts.portal')
  const tc = useTranslations('supplierContacts.contacts')
  const locale = useLocale()
  const router = useRouter()
  const { key, next } = useSubmissionKey()
  const [pending, setPending] = useState<string | null>(null)
  const [said, setSaid] = useState<{ readonly tone: 'success' | 'danger'; readonly text: string } | null>(null)
  const nameOf = (c: PortalContactView) => (locale === 'en' && c.nameEn ? c.nameEn : c.nameTh)

  async function change(c: PortalContactView, on: boolean) {
    setPending(c.id)
    setSaid(null)
    const r = await setAccess(c.id, c.version, on, key)
    setPending(null)
    next()
    if (!r.ok) return setSaid({ tone: 'danger', text: tc(`errors.${refusalKey(r)}`) })
    setSaid({ tone: 'success', text: on ? tc('done.portalOn', { name: nameOf(c) }) : tc('done.portalOff', { name: nameOf(c) }) })
    router.refresh()
  }

  const usable = view.portalEnabled && view.supplierStatus === 'ACTIVE'
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <StatusBadge look={usable ? { tone: 'ok', icon: 'CircleCheck' } : { tone: 'neutral', icon: 'Ban' }} label={view.portalEnabled ? t('on') : t('off')} className="self-start text-base md:text-sm" />
        <p className="text-ink">{view.portalEnabled ? t('onHint') : t('offHint')}</p>
        {view.supplierStatus === 'INACTIVE' ? <Notice tone="warning">{t('inactive')}</Notice> : null}
        {view.canManage ? <p className="text-base text-ink-muted md:text-sm">{t('readOnly')}</p> : null}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-ink">{t('url')}</h3>
        <p className="break-all text-ink tabular">{view.loginUrl}</p>
        <p className="text-base text-ink-muted md:text-sm">{t('urlHint')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="font-medium text-ink">{t('contactsTitle')}</h3>
        {view.canManage && view.contacts.length ? <p className="text-base text-ink-muted md:text-sm">{t('contactsHint')}</p> : null}
        {said ? <Notice tone={said.tone}>{said.text}</Notice> : null}
        {view.contacts.length === 0 ? (
          <p className="text-ink-muted">{t('noContacts')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {view.contacts.map((c) => {
              const id = `portal-access-${c.id}`
              return (
                <li key={c.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    {view.canManage ? (
                      <label htmlFor={id} className="font-medium text-ink">
                        {nameOf(c)}
                      </label>
                    ) : (
                      <span className="font-medium text-ink">{nameOf(c)}</span>
                    )}
                    {c.roleLabel || c.isPrimary ? <span className="text-base text-ink-muted md:text-sm">{[c.isPrimary ? tc('primary') : null, c.roleLabel].filter(Boolean).join(' · ')}</span> : null}
                  </div>
                  <div className="flex min-h-11 shrink-0 items-center gap-2">
                    <span className="text-base text-ink-muted md:text-sm" aria-hidden={view.canManage ? true : undefined}>
                      {c.portalEnabled ? tc('portalOn') : tc('portalOff')}
                    </span>
                    {view.canManage ? (
                      <Switch id={id} checked={c.portalEnabled} disabled={pending !== null} aria-label={t('switchLabel', { name: nameOf(c) })} onCheckedChange={(on) => void change(c, on)} />
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
