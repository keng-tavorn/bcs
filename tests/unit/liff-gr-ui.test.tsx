import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LiffFrame } from '@/ui/liff/frame'
import { LiffProvider } from '@/ui/liff/liff-provider'
import { LiffPhotoButton } from '@/ui/liff/receiving/photo-button'
import { LiffPhotos, LiffRemovePhotoQuestion, type LiffPhotosProps } from '@/ui/liff/receiving/photos'
import { LiffReceipts, photoNames } from '@/ui/liff/receiving/receipts'
import { LiffReceiveFlow, type LiffReceiveActions } from '@/ui/liff/receiving/receive-flow'
import { LiffReceiptReview } from '@/ui/liff/receiving/review'
import { LiffPoSummary, liffPoStatus } from '@/ui/liff/receiving/summary'
import type { ReceiptPreviewView, ReceiptView, ReceiveLineView } from '@/ui/receiving/types'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S5-06 · the pieces of /liff/gr/[poId] (§9.4, FR-LINE-003 AC3, FR-P2P-006, FR-P2P-007): the camera input, the
// receiving steps' first screen with its bar, step 2 with the receiver's choices, the PO's summary and the receipts with
// their photos. Static markup only (no DOM here): the steps run in the LINE-sized browser in tests/e2e/liff-gr.spec.ts
// with axe, at 375 px and 1440 px — the photo that holds the receipt while it is sent included.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      <LiffProvider config={{ liffId: null, mock: { lineUserId: 'U00000000000000000000000000000000', cookie: 'bcs-liff-mock-user' }, session: 'liff' }}>{node}</LiffProvider>
    </NextIntlClientProvider>,
  )

const never = () => Promise.reject(new Error('not called in markup'))
/** The <input> tags of the markup that carry every one of these attributes, in whatever order React writes them */
const inputsWith = (page: string, ...attributes: string[]) => (page.match(/<input [^>]*>/g) ?? []).filter((tag) => attributes.every((a) => tag.includes(a)))
const actions: LiffReceiveActions = { preview: never, post: never, requestUpload: never, completeUpload: never }
const LINES: ReceiveLineView[] = [
  { id: '0192a3b4-0000-7000-8000-000000000001', description: 'ไม้อัด 10 มม.', uom: 'แผ่น', ordered: '10', received: '0', outstanding: '10', cancelled: null, keepPending: null },
  { id: '0192a3b4-0000-7000-8000-000000000002', description: 'ชุด PPE', uom: 'ชุด', ordered: '10', received: '10', outstanding: '0', cancelled: null, keepPending: null },
]
const photosProps = (overrides: Partial<LiffPhotosProps> = {}): LiffPhotosProps => ({
  inputId: 'gr-camera',
  photos: [],
  status: { kind: 'idle' },
  busy: false,
  onTake: () => undefined,
  onRemove: () => undefined,
  ...overrides,
})

describe('[FR-LINE-003/AC3] the camera of the LIFF receiving page', () => {
  it('opens the phone camera: a file input taking pictures with capture=environment, behind a 44 px button with words', () => {
    const page = html(<LiffPhotos {...photosProps()} />)
    expect(page).toMatch(/<input id="gr-camera" type="file" accept="image\/\*" capture="environment"/)
    expect(page).toMatch(/<label for="gr-camera" class="[^"]*min-h-11[^"]*">.*ถ่ายรูป/)
    // The camera icon is decorative and drawn without lucide's client code; the words say what the button does
    expect(page).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(page).toContain('ระบบย่อรูปในมือถือก่อนส่ง และลบข้อมูลตำแหน่งที่ถ่ายออก แนบได้ไม่เกิน 20 รูป')
  })

  it('lists the photos taken, each with a small picture from the phone and a way to take it out before the receipt is posted', () => {
    const page = html(<LiffPhotos {...photosProps({ photos: [{ fileId: 'f1', fileName: 'site-delivery.jpg', preview: 'blob:http://localhost/1' }] })} />)
    expect(page).toContain('รูป site-delivery.jpg')
    expect(page).toContain('เอารูป site-delivery.jpg ออก')
    expect(page).toContain('url(&quot;blob:http://localhost/1&quot;)')
    expect(page).toContain('ถ่ายรูปเพิ่ม')
  })

  it('takes no other photo, and lets none be taken out, while one is still being made ready or sent, or the receipt is being checked or posted', () => {
    const page = html(<LiffPhotos {...photosProps({ busy: true, status: { kind: 'sending', name: 'image-2.jpg' }, photos: [{ fileId: 'f1', fileName: 'site-delivery.jpg', preview: 'blob:http://localhost/1' }] })} />)
    expect(page).toMatch(/<input id="gr-camera" type="file"[^>]*disabled=""/)
    expect(page).toMatch(/<button type="button"[^>]*disabled="">เอารูป site-delivery.jpg ออก<\/button>/)
    expect(page).toContain('<p role="status">กำลังส่งรูป image-2.jpg</p>')
  })

  it('says how the last photo ended, from the flow that holds it: stopped by the receiver, or refused and why', () => {
    const stopped = html(<LiffPhotos {...photosProps({ status: { kind: 'stopped' } })} />)
    expect(stopped).toMatch(/<div role="status"[^>]*>.*หยุดส่งรูปแล้ว รูปนี้ไม่ได้แนบ ถ่ายใหม่ได้เมื่อสัญญาณดีขึ้น/)
    const refused = html(<LiffPhotos {...photosProps({ status: { kind: 'refused', text: 'อัปโหลดไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองอีกครั้ง' } })} />)
    expect(refused).toMatch(/<div role="alert"[^>]*>.*อัปโหลดไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองอีกครั้ง/)
    const added = html(<LiffPhotos {...photosProps({ status: { kind: 'added', name: 'site.jpg' } })} />)
    expect(added).toContain('<p role="status" class="sr-only">แนบรูป site.jpg แล้ว</p>')
  })

  it('ties the photo rule of damaged goods to the camera input, in words and an icon', () => {
    const page = html(<LiffPhotos {...photosProps({ error: 'ถ่ายรูปของที่เสียหายอย่างน้อย 1 รูปก่อน' })} />)
    expect(page).toMatch(/<input id="gr-camera"[^>]*aria-invalid="true" aria-describedby="gr-camera-error"/)
    expect(page).toMatch(/<p id="gr-camera-error" class="[^"]*"><svg[^>]*aria-hidden="true"[^>]*>.*<\/svg><span>ถ่ายรูปของที่เสียหายอย่างน้อย 1 รูปก่อน<\/span><\/p>/)
  })

  it('says it in English too', () => {
    const page = html(<LiffPhotos {...photosProps()} />, 'en')
    expect(page).toContain('Take a photo')
    expect(page).not.toMatch(/[฀-๿]/)
  })
})

describe('[§9.9] [BR-GR-05] taking a photo out of a LIFF receipt asks first: it cannot be undone (D-05 round 5)', () => {
  const PHOTO = { fileId: 'f1', fileName: 'site-delivery.jpg', preview: 'blob:http://localhost/1' }
  const question = (busy: boolean, locale: 'th' | 'en' = 'th') =>
    html(<LiffRemovePhotoQuestion id="gr-camera-remove-question" name={PHOTO.fileName} busy={busy} onRemove={() => undefined} onKeep={() => undefined} />, locale)
  /** The buttons of some markup: their words and their classes, in order */
  const buttonsOf = (markup: string) => [...markup.matchAll(/<button type="button" class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => ({ words: m[2], classes: m[1]! }))

  it('the list shows the photo’s button — which the focus comes back to when the photo is kept — and no question until it is pressed', () => {
    const page = html(<LiffPhotos {...photosProps({ photos: [PHOTO] })} />)
    expect(page).toMatch(/<button type="button" class="[^"]*" id="gr-camera-remove-f1">เอารูป site-delivery.jpg ออก<\/button>/)
    expect(page).not.toContain('role="group"')
    expect(page).not.toContain('ออกจากการตรวจรับนี้?')
  })

  it('asks in the photo’s place: the photo it is about names the group and takes the focus, what follows says it cannot be brought back, and the two answers stand one under the other — taking it out in danger, keeping it plain', () => {
    const page = question(false)
    expect(page).toMatch(
      /^<div role="group" aria-labelledby="gr-camera-remove-question" class="[^"]*border-danger[^"]*"><p id="gr-camera-remove-question" tabindex="-1" class="[^"]*">เอารูป site-delivery.jpg ออกจากการตรวจรับนี้\?<\/p>/,
    )
    expect(page).toContain('รูปที่เอาออกแล้วเรียกคืนไม่ได้ ถ้ายังต้องใช้ ต้องถ่ายใหม่')
    const buttons = buttonsOf(page)
    expect(buttons.map((b) => b.words)).toEqual(['เอารูปนี้ออก', 'ไม่เอาออก เก็บรูปไว้'])
    expect(buttons[0]!.classes).toContain('border-danger')
    expect(buttons[1]!.classes).not.toContain('danger')
    // 44 px each, one under the other with room between them, so neither is pressed by mistake (§9.9)
    for (const b of buttons) expect(b.classes).toContain('min-h-11')
    expect(page).toMatch(/^<div[^>]*class="[^"]*flex-col gap-3[^"]*"/)
  })

  it('waits to take the photo out while a photo is sent or the receipt is checked or posted; keeping it never waits', () => {
    const page = question(true)
    expect(page).toMatch(/<button type="button"[^>]*disabled="">เอารูปนี้ออก<\/button>/)
    expect(page).toMatch(/<button type="button"(?![^>]*disabled="")[^>]*>ไม่เอาออก เก็บรูปไว้<\/button>/)
  })

  it('in English too', () => {
    const page = question(false, 'en')
    expect(page).toContain('Remove photo site-delivery.jpg from this receipt?')
    expect(buttonsOf(page).map((b) => b.words)).toEqual(['Remove this photo', 'Keep the photo'])
    expect(page).not.toMatch(/[฀-๿]/)
  })
})

describe('[FR-P2P-006/AC1] the first step of receiving in LINE', () => {
  it('asks the quantity of each line — named for screen readers — with what is ordered and still to come, and puts its button in the bar at the bottom', () => {
    const page = html(
      <LiffFrame title="ตรวจรับ PO-2569-00012">
        <LiffReceiveFlow poId="0192a3b4-0000-7000-8000-0000000000aa" lines={LINES} open summary={<p>สรุป</p>} history={<p>ประวัติ</p>} actions={actions} />
      </LiffFrame>,
    )
    expect(page).toContain('ขั้น 1 จาก 2')
    expect(page).toContain('<span class="sr-only">ไม้อัด 10 มม.: </span>รับรอบนี้ (แผ่น)')
    expect(page).toContain('รายการนี้รับครบแล้ว')
    expect(page).toMatch(/inputMode="decimal"|inputmode="decimal"/)
    // The bar: a region after the content, its button submitting the form it belongs to
    const form = /<form id="([^"]+)"/.exec(page)?.[1]
    expect(form).toBeTruthy()
    expect(page).toMatch(new RegExp(`</form>.*<section aria-label="บันทึกการตรวจรับ" class="sticky bottom-0[^"]*">.*<button type="submit"[^>]*form="${form}"[^>]*>ตรวจสอบก่อนบันทึก</button>`))
    // No photo is on its way: the button works and the bar has nothing to wait for
    expect(page).not.toMatch(/<button type="submit"[^>]*disabled=""/)
    expect(page).not.toContain('กำลังส่งรูป รอให้เสร็จก่อน')
    // The summary and the receipts come from the server, around the form
    expect(page.indexOf('สรุป')).toBeLessThan(page.indexOf('ขั้น 1 จาก 2'))
    expect(page.indexOf('ประวัติ')).toBeGreaterThan(page.indexOf('ถ่ายรูป'))
  })

  it('offers no form and no bar when the PO takes no goods now: it shows why instead', () => {
    const page = html(
      <LiffReceiveFlow poId="0192a3b4-0000-7000-8000-0000000000aa" lines={LINES} open={false} summary={<p>สรุป</p>} closed={<p>รับของครบทุกรายการแล้ว</p>} history={<p>ประวัติ</p>} actions={actions} />,
    )
    expect(page).toContain('รับของครบทุกรายการแล้ว')
    expect(page).not.toContain('<form')
    expect(page).not.toContain('sticky bottom-0')
    expect(page).not.toContain('ถ่ายรูป')
  })
})

/** A receipt of 11 bags against 10 ordered (beyond a 0% tolerance) and 4 sheets of which 1 is damaged */
const PREVIEW: ReceiptPreviewView = {
  poStatusAfter: 'PARTIALLY_RECEIVED',
  linesOutstandingAfter: 1,
  tolerancePct: 0,
  lines: [
    {
      poLineId: 'l1',
      description: 'ปูนซีเมนต์ 50 กก.',
      uom: 'ถุง',
      received: '11',
      rejected: null,
      accepted: '10',
      outstandingAfter: '0',
      withinTolerance: null,
      hold: null,
      excess: {
        quantity: '1',
        amount: '150.00',
        keep: { kind: 'ROUTE', ruleCode: 'GRV-T1', name: { th: 'สมชาย ใจดี', en: 'Somchai Jaidee' }, actingFor: null, position: { th: 'ผู้จัดการ', en: 'Manager' }, department: { th: 'ฝ่ายทดสอบ', en: 'Test dept' } },
      },
      damaged: null,
    },
    {
      poLineId: 'l2',
      description: 'ไม้อัด 10 มม.',
      uom: 'แผ่น',
      received: '4',
      rejected: '1',
      accepted: '3',
      outstandingAfter: '1',
      withinTolerance: null,
      hold: null,
      excess: null,
      damaged: { quantity: '1', amount: '520.00', keep: { kind: 'BLOCKED', code: 'BEYOND_ORDER' } },
    },
  ],
}

// What step 2 shows of the preview the server calculated (display only: the approver here is the fixture's). That LIFF
// names the approver the DOA routes to, and that keeping an excess then waits for that GR_VARIANCE approver, is
// tests/e2e/liff-gr.spec.ts against the demo DOA.
describe('[FR-P2P-007/AC2] step 2 of receiving in LINE asks what happens to an excess or damaged goods, and shows the GR_VARIANCE approver the preview names', () => {
  const review = (locale: 'th' | 'en' = 'th') =>
    html(
      <LiffReceiptReview
        namePrefix="p"
        preview={PREVIEW}
        choices={{ l1: { excess: 'RETURN_EXCESS' } }}
        choiceErrors={new Set(['l2:damaged'])}
        onChoose={() => undefined}
        evidence={{ deliveryNoteNo: 'DN-1', photoCount: 2, notes: '' }}
      />,
      locale,
    )

  it('says the PO’s status after the receipt, and per line what came, what is accepted and what is still to come', () => {
    const page = review()
    expect(page).toContain('หลังบันทึก ใบสั่งซื้อจะเป็น &quot;รับบางส่วน&quot; ยังค้างรับ 1 รายการ')
    expect(page).toContain('มาส่ง 11 ถุง · รับเข้า 10 ถุง · ยังค้าง 0 ถุง')
    expect(page).toContain('มาส่ง 4 แผ่น · รับเข้า 3 แผ่น · ยังค้าง 1 แผ่น')
    expect(page).toContain('ไม่รับ 1 แผ่น')
    expect(page).toContain('ใบส่งของเลขที่ DN-1')
    expect(page).toContain('รูปถ่าย 2 รูป')
  })

  it('offers sending the excess back (no approval) or keeping it with the approver named; the choice made stays chosen', () => {
    const page = review()
    expect(page).toContain('ส่วนเกิน 1 ถุง เกินเกณฑ์ที่รับเกินได้ (0%) จะทำอย่างไร')
    expect(page).toMatch(/มูลค่าตามราคาในใบสั่งซื้อ<\/span><span class="money[^"]*">150.00 บาท/)
    expect(inputsWith(page, 'id="p-l1-excess-choice"', 'type="radio"', 'name="p-l1-excess"', 'value="RETURN_EXCESS"', 'checked=""')).toHaveLength(1)
    expect(page).toContain('ขอเก็บส่วนเกินไว้ ต้องรออนุมัติ')
    expect(page).toContain('ผู้อนุมัติ สมชาย ใจดี ผู้จัดการ ฝ่ายทดสอบ ตาม DOA ข้อ GRV-T1')
  })

  it('asks what happens to damaged goods; keeping more than is still to come is not offered, and a missing choice says so at the group', () => {
    const page = review()
    expect(page).toContain('ของเสียหาย 1 แผ่น จะทำอย่างไร')
    // The first option, which no approval blocks, takes the focus when the choice is missing, and is read with the error
    const replace = inputsWith(page, 'id="p-l2-damaged-choice"', 'name="p-l2-damaged"', 'value="RETURN_REPLACE"', 'aria-describedby="p-l2-damaged-error"')
    expect(replace).toHaveLength(1)
    expect(replace[0]).not.toContain('disabled')
    expect(inputsWith(page, 'name="p-l2-damaged"', 'value="ACCEPT_DAMAGED"', 'disabled=""', 'aria-describedby="p-l2-damaged-error"')).toHaveLength(1)
    // A group whose choice is made carries no error
    expect(inputsWith(page, 'name="p-l1-excess"', 'aria-describedby')).toHaveLength(0)
    expect(page).toContain('เลือกข้อนี้ไม่ได้ เพราะของเสียหายมากกว่าจำนวนที่ยังค้างรับ ของส่วนนี้ต้องคืนผู้ขาย')
    expect(page).toMatch(/<p id="p-l2-damaged-error"[^>]*>.*<span>เลือกว่าจะทำอย่างไรก่อนบันทึก<\/span><\/p>/)
  })

  it('says it in English too', () => {
    const page = review('en')
    expect(page).toContain('After this, the purchase order will be &quot;Partly received&quot; with 1 line still to come')
    expect(page).toContain('Return the excess to the supplier, no approval needed')
    expect(page).toContain('The supplier replaces them, no approval needed')
  })
})

describe('[FR-P2P-006/AC2] the PO and its receipts in LINE', () => {
  it('states the PO with an icon and words (never colour alone), its supplier, site and the requests it orders for', () => {
    const page = html(
      <LiffPoSummary
        locale="th"
        po={{
          status: liffPoStatus('PARTIALLY_RECEIVED'),
          supplier: { th: 'ผู้ขายวัสดุ', en: null },
          site: { th: 'ไซต์งาน A', en: null },
          sentAt: '4 ต.ค. 2569 10:00 น.',
          requests: [{ id: 'r1', number: 'PR-2569-00001', requester: { th: 'สมชาย ใจดี', en: null }, department: { th: 'ฝ่ายก่อสร้าง', en: null } }],
        }}
      />,
    )
    expect(page).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*<\/svg><span>รับบางส่วน<\/span>/)
    expect(page).toContain('ผู้ขาย ผู้ขายวัสดุ')
    expect(page).toContain('ส่งที่ ไซต์งาน A')
    expect(page).toContain('PR-2569-00001 ขอโดย สมชาย ใจดี · ฝ่ายก่อสร้าง')
    expect(liffPoStatus('SOMETHING_ELSE')).toBe('DRAFT')
  })

  const receipt = (photos: ReceiptView['photos']): ReceiptView => ({
    id: 'g1',
    number: 'GR-2569-00007',
    status: 'POSTED',
    when: '4 ต.ค. 2569 10:30 น.',
    receiver: { th: 'ประเสริฐ ตรวจดี', en: null },
    deliveryNoteNo: 'DN-2569-0815',
    notes: null,
    reverseReason: null,
    lines: [{ poLineId: 'l1', description: 'ไม้อัด 10 มม.', uom: 'แผ่น', received: '6', accepted: '6', refused: null, remark: null }],
    photos,
    variances: [],
  })

  it('lists each receipt with its lines and its photos as 44 px buttons that ask for the photo when tapped (no address in the page)', () => {
    const page = html(<LiffReceipts receipts={[receipt([{ fileId: 'f1', fileName: 'site-delivery.jpg' }])]} closeShort={[]} locale="th" open={async () => null} />)
    expect(page).toContain('aria-label="ใบตรวจรับของใบสั่งซื้อนี้"')
    expect(page).toContain('GR-2569-00007')
    expect(page).toContain('ไม้อัด 10 มม. มาส่ง 6 แผ่น รับเข้า 6 แผ่น')
    expect(page).toContain('ใบส่งของเลขที่ DN-2569-0815')
    // A disclosure: the photo opens under its button, in the page
    expect(page).toMatch(/<button type="button" aria-expanded="false" class="[^"]*min-h-11[^"]*">.*เปิดรูป site-delivery.jpg/)
    expect(page).not.toContain('X-Amz')
    expect(page).not.toContain('role="img"')
  })

  it('numbers photos of one receipt that share a name (an iPhone calls every capture image.jpg), so each button has its own name', () => {
    const page = html(
      <LiffReceipts
        receipts={[
          receipt([
            { fileId: 'f1', fileName: 'image.jpg' },
            { fileId: 'f2', fileName: 'IMAGE.jpg' },
            { fileId: 'f3', fileName: 'site.jpg' },
          ]),
        ]}
        closeShort={[]}
        locale="th"
        open={async () => null}
      />,
    )
    expect(page).toContain('เปิดรูป image.jpg (รูปที่ 1)')
    expect(page).toContain('เปิดรูป IMAGE.jpg (รูปที่ 2)')
    expect(page).toContain('เปิดรูป site.jpg<')
    expect(photoNames([{ fileName: 'a.jpg' }, { fileName: 'b.jpg' }], (name, n) => `${name}#${n}`).map((p) => p.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(photoNames([{ fileName: 'a.jpg' }, { fileName: 'a.jpg' }], (name, n) => `${name}#${n}`).map((p) => p.name)).toEqual(['a.jpg#1', 'a.jpg#2'])
  })

  it('names the photo button in English too', () => {
    const page = html(<LiffPhotoButton fileId="f1" name="site.jpg" open={async () => null} />, 'en')
    expect(page).toContain('Open photo site.jpg')
    expect(page).not.toMatch(/[฀-๿]/)
  })
})
