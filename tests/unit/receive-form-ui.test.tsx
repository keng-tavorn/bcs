import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FileUpload, FileUploadView, type FileUploadStatus } from '@/ui/files/file-upload'
import { ReceiveBar, ReceiveForm, type ReceiveFormActions } from '@/ui/receiving/receive-form'
import type { ReceiveLineView } from '@/ui/receiving/types'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-P2P-006 AC1 · the workspace's receiving form waits for its photos as the LIFF receiving page does
// (src/ui/receiving/receive-form.tsx, src/ui/files/file-upload.tsx): while a photo is being uploaded neither
// "ตรวจสอบก่อนบันทึก" nor "ยืนยันบันทึกการตรวจรับ" works and the bar says why; while the receipt is being checked or
// posted the camera takes no photo and no photo is taken out; an upload under way says so and can be stopped
// (FR-PLT-004; its time limit is tests/unit/file-upload.test.ts). Static markup only (no DOM here): the steps run in
// the browser in tests/e2e/receiving.spec.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

const never = () => Promise.reject(new Error('not called in markup'))
const actions: ReceiveFormActions = { preview: never, post: never, requestUpload: never, completeUpload: never }
const LINES: ReceiveLineView[] = [{ id: '0192a3b4-0000-7000-8000-000000000001', description: 'ไม้อัด 10 มม.', uom: 'แผ่น', ordered: '10', received: '0', outstanding: '10', cancelled: null, keepPending: null }]
const WAIT = 'กำลังอัปโหลดรูป รอให้เสร็จก่อนจึงตรวจสอบหรือบันทึกได้ หรือหยุดอัปโหลดที่ช่องรูปถ่ายด้านบน'

/** The submit buttons of the markup, with whether each is disabled */
const submits = (page: string) => [...page.matchAll(/<button type="submit"([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ label: m[2], disabled: m[1]!.includes('disabled=""') }))
const fileInput = (page: string) => /<input id="photo"[^>]*>/.exec(page)?.[0] ?? ''
const view = (status: FileUploadStatus, disabled = false) =>
  html(<FileUploadView id="photo" mode="photo" rule="แนบได้เฉพาะรูป" status={status} disabled={disabled} onChange={() => undefined} onStop={() => undefined} />)

describe('[FR-P2P-006/AC1] the receipt waits for a photo still being uploaded', () => {
  it('step 1: "ตรวจสอบก่อนบันทึก" does not work while a photo is on its way, and the bar says why', () => {
    const page = html(<ReceiveBar step="enter" pending={false} uploading />)
    expect(submits(page)).toEqual([{ label: 'ตรวจสอบก่อนบันทึก', disabled: true }])
    expect(page).toMatch(new RegExp(`<div role="status"[^>]*>.*${WAIT}`))
  })

  it('step 2: "ยืนยันบันทึกการตรวจรับ" does not work while a photo is on its way either, and the bar says why', () => {
    const page = html(<ReceiveBar step="review" pending={false} uploading onBack={() => undefined} />)
    expect(submits(page)).toEqual([{ label: 'ยืนยันบันทึกการตรวจรับ', disabled: true }])
    expect(page).toContain(WAIT)
    // Going back to the quantities stays open: it changes nothing on the server
    expect(page).toMatch(/<button type="button"(?![^>]*disabled="")[^>]*>กลับไปแก้จำนวน<\/button>/)
  })

  it('works when nothing is on its way, and says nothing about waiting', () => {
    for (const step of ['enter', 'review'] as const) {
      const page = html(<ReceiveBar step={step} pending={false} uploading={false} onBack={() => undefined} />)
      expect(submits(page)).toEqual([{ label: step === 'enter' ? 'ตรวจสอบก่อนบันทึก' : 'ยืนยันบันทึกการตรวจรับ', disabled: false }])
      expect(page).not.toContain(WAIT)
    }
  })

  it('a check or a receipt on its way: its button says so and works no more, and going back waits too', () => {
    expect(submits(html(<ReceiveBar step="enter" pending uploading={false} />))).toEqual([{ label: 'กำลังตรวจสอบ', disabled: true }])
    const posting = html(<ReceiveBar step="review" pending uploading={false} onBack={() => undefined} />)
    expect(submits(posting)).toEqual([{ label: 'กำลังบันทึก', disabled: true }])
    expect(posting).toMatch(/<button type="button"[^>]*disabled=""[^>]*>กลับไปแก้จำนวน<\/button>/)
  })

  it('says why on a row of its own above the buttons, which never shrink: nothing squeezes their words out of their 44 px', () => {
    for (const step of ['enter', 'review'] as const) {
      const page = html(<ReceiveBar step={step} pending={false} uploading onBack={() => undefined} />)
      // The bar: the notice, then one row that holds the buttons (stacked on a phone, side by side or wrapped from 640 px)
      const bar = /^<div class="([^"]*)"><div role="status"[^>]*>.*?<\/div><\/div><div class="([^"]*)">(.*)<\/div><\/div>$/.exec(page)
      expect(bar, page).not.toBeNull()
      expect(bar![1]!.split(' ')).not.toContain('sm:flex-row')
      expect(bar![2]!.split(' ')).toEqual(expect.arrayContaining(['flex', 'flex-col', 'sm:flex-row', 'sm:flex-wrap']))
      const buttons = [...bar![3]!.matchAll(/<button [^>]*class="([^"]*)"/g)].map((m) => m[1]!.split(' '))
      expect(buttons).toHaveLength(step === 'review' ? 2 : 1)
      for (const classes of buttons) expect(classes).toContain('shrink-0')
    }
  })

  it('says it in English too', () => {
    const page = html(<ReceiveBar step="enter" pending={false} uploading />, 'en')
    expect(submits(page)).toEqual([{ label: 'Check before recording', disabled: true }])
    expect(page).toContain('A photo is still uploading. Wait for it to finish before checking or recording')
    expect(page).not.toMatch(/[฀-๿]/)
  })

  it('the form opens ready: its button works, the camera takes photos, nothing waits', () => {
    const page = html(<ReceiveForm poId="0192a3b4-0000-7000-8000-0000000000aa" lines={LINES} open listHref="/receiving" actions={actions} />)
    expect(submits(page)).toEqual([{ label: 'ตรวจสอบก่อนบันทึก', disabled: false }])
    expect(page).not.toContain(WAIT)
    expect(page).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"/)
    expect(page).not.toMatch(/<input[^>]*type="file"[^>]*disabled=""/)
  })
})

describe('[FR-PLT-004/AC1] [FR-P2P-006/AC1] the photo upload of the form', () => {
  it('takes no other file while one is on its way, says which, and offers to stop it', () => {
    const page = view({ kind: 'busy', name: 'site-delivery.jpg' })
    expect(fileInput(page)).toContain('disabled=""')
    expect(page).toContain('<p role="status" class="break-words">กำลังอัปโหลด site-delivery.jpg</p>')
    expect(page).toMatch(/<button type="button"(?![^>]*disabled="")[^>]*>หยุดอัปโหลดไฟล์นี้<\/button>/)
  })

  it('puts the stop under the file’s name at every width: in a narrow column nothing squeezes the button', () => {
    const page = view({ kind: 'busy', name: 'IMG_20261004_093015_site-delivery-north-gate.jpg' })
    const row = /<div class="([^"]*)"><p role="status"[^>]*>[^<]*<\/p><button type="button" class="([^"]*)"/.exec(page)
    expect(row, page).not.toBeNull()
    expect(row![1]!.split(' ')).toEqual(['flex', 'flex-col', 'gap-2'])
    // The button is as wide as its words, and its words are short: the file's name is in the line above it
    expect(row![2]!.split(' ')).toContain('self-start')
    expect(page).toMatch(/<button[^>]*>หยุดอัปโหลดไฟล์นี้<\/button>/)
  })

  it('takes no file while the form is being checked or saved (disabled), and offers nothing to stop', () => {
    const page = view({ kind: 'idle' }, true)
    expect(fileInput(page)).toContain('disabled=""')
    expect(page).not.toContain('หยุดอัปโหลด')
    // The same through FileUpload itself, as the receiving form passes it
    const form = html(<FileUpload mode="photo" requestUpload={never} completeUpload={never} disabled />)
    expect(form).toMatch(/<input[^>]*type="file"[^>]*disabled=""/)
  })

  it('takes a file when nothing is on its way and the form is not busy', () => {
    const page = view({ kind: 'idle' })
    expect(fileInput(page)).toMatch(/^<input id="photo" type="file" class="sr-only" accept="image\/\*" capture="environment"/)
    expect(fileInput(page)).not.toContain('disabled')
    expect(page).toContain('แนบได้เฉพาะรูป')
  })

  it('says how the last upload ended: recorded, stopped by the person, or refused and why', () => {
    expect(view({ kind: 'done', name: 'site.jpg' })).toMatch(/<div role="status"[^>]*>.*แนบ site.jpg แล้ว/)
    expect(view({ kind: 'stopped' })).toMatch(/<div role="status"[^>]*>.*หยุดอัปโหลดแล้ว ไฟล์นี้ไม่ได้แนบ/)
    expect(view({ kind: 'error', reason: 'FAILED' })).toMatch(/<div role="alert"[^>]*>.*อัปโหลดไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองอีกครั้ง/)
    const unreadable = view({ kind: 'error', reason: 'UNREADABLE' })
    expect(unreadable).toMatch(/<div role="alert"[^>]*>.*ใช้รูปนี้ไม่ได้ เพราะเบราว์เซอร์เปิดรูปนี้ไม่ได้ จึงลบตำแหน่งที่ถ่ายออกไม่ได้ เลือกรูป JPG หรือ PNG/)
    // After any of these another file can be chosen
    for (const status of [{ kind: 'done', name: 'site.jpg' }, { kind: 'stopped' }, { kind: 'error', reason: 'UNREADABLE' }] as const) {
      expect(fileInput(view(status))).not.toContain('disabled')
    }
  })

  it('says it in English too', () => {
    const page = html(
      <FileUploadView id="photo" mode="photo" status={{ kind: 'busy', name: 'site.jpg' }} disabled={false} onChange={() => undefined} onStop={() => undefined} />,
      'en',
    )
    expect(page).toContain('Uploading site.jpg')
    expect(page).toContain('>Stop this upload</button>')
    expect(page).not.toMatch(/[฀-๿]/)
  })
})
