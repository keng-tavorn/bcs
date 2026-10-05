import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadFromButton, UploadButtonView, type UploadActions, type UploadButtonStatus } from '@/ui/request-form/upload-button'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-PLT-004 · the upload button of the request form's documents and the supplier form's proof
// (src/ui/request-form/upload-button.tsx) runs the workspace's one upload (src/ui/files/upload.ts). A photo the browser
// cannot decode is refused before anything goes out — the camera's file would carry its position (AC3) — and the button
// says why and what to do (files.unreadable: choose a JPG or PNG photo), never "check your connection", which is for an
// upload that broke off. The browser's decoders are stand-ins that cannot decode (as in tests/unit/file-prepare.test.ts);
// prepareFile itself is the real one. Static markup only (no DOM here).

const html = (node: ReactNode, locale: 'th' | 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
const view = (status: UploadButtonStatus, locale: 'th' | 'en') => html(<UploadButtonView id="quote" label="แนบใบเสนอราคา" status={status} showRule onChange={() => undefined} />, locale)
/** The words of the button's alert, or null when it has none */
const alertOf = (page: string) => /<div role="alert">(.*?)<\/div>/.exec(page)?.[1]?.replace(/<[^>]+>/g, '') ?? null

const heic = new File([new Uint8Array([1, 2, 3])], 'IMG_0042.HEIC', { type: 'image/heic' })
const brokenJpeg = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'site.jpg', { type: 'image/jpeg' })
const pdf = new File([new TextEncoder().encode('%PDF-1.7 quote')], 'quote.pdf', { type: 'application/pdf' })

let calls: string[]
let puts: string[]
let putStatus: number
const actions: UploadActions = {
  requestUpload: async (input) => {
    calls.push(`request ${input.fileName} ${input.mimeType}`)
    return { ok: true, uploadUrl: 'http://storage.test/put?X-Amz-Signature=abc', ticket: 'ticket-1' }
  },
  completeUpload: async (ticket) => {
    calls.push(`complete ${ticket}`)
    return { ok: true, fileId: 'file-1', fileName: 'quote.pdf' }
  },
}

beforeEach(() => {
  calls = []
  puts = []
  putStatus = 200
  vi.stubGlobal('fetch', async (url: string) => {
    puts.push(url)
    return new Response(null, { status: putStatus })
  })
  // A browser that cannot decode the photo: createImageBitmap refuses it and an <img> cannot decode it either
  vi.stubGlobal('createImageBitmap', async () => {
    throw new Error('unsupported format')
  })
  vi.stubGlobal(
    'Image',
    class {
      decoding = ''
      src = ''
      naturalWidth = 0
      naturalHeight = 0
      decode() {
        return Promise.reject(new Error('cannot decode'))
      }
    },
  )
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Runs one upload of the button and returns what it showed, in order, and whether the file was attached */
async function choose(file: File, onUploaded: (file: { fileId: string; fileName: string }) => Promise<void> | void = () => undefined) {
  const shown: UploadButtonStatus[] = []
  const attached: Array<{ fileId: string; fileName: string }> = []
  await uploadFromButton(file, actions, async (f) => {
    attached.push(f)
    await onUploaded(f)
  }, (status) => shown.push(status))
  return { shown, attached }
}

describe('[FR-PLT-004/AC3] [FR-PLT-004/AC1] the upload button refuses a photo the browser cannot decode, and says so', () => {
  it('sends nothing at all and shows why with what to do, in both languages — not the words of a broken connection', async () => {
    for (const photo of [heic, brokenJpeg]) {
      const { shown, attached } = await choose(photo)
      expect(shown, photo.name).toEqual([{ kind: 'error', reason: 'UNREADABLE' }])
      expect(attached, photo.name).toEqual([])
    }
    expect(calls).toEqual([])
    expect(puts).toEqual([])

    const thPage = view({ kind: 'error', reason: 'UNREADABLE' }, 'th')
    expect(alertOf(thPage)).toBe('ใช้รูปนี้ไม่ได้ เพราะเบราว์เซอร์เปิดรูปนี้ไม่ได้ จึงลบตำแหน่งที่ถ่ายออกไม่ได้ เลือกรูป JPG หรือ PNG')
    expect(thPage).not.toContain(th.files.failed)
    // The file input names the error as its description
    expect(thPage).toMatch(/<input id="quote"[^>]*aria-describedby="quote-error"/)
    const enPage = view({ kind: 'error', reason: 'UNREADABLE' }, 'en')
    expect(alertOf(enPage)).toBe('This photo cannot be used: the browser cannot open it to remove where it was taken. Choose a JPG or PNG photo.')
    expect(enPage).not.toContain(en.files.failed)
  })

  it('an upload that broke off still says to check the connection', async () => {
    putStatus = 503
    expect((await choose(pdf)).shown).toEqual([{ kind: 'busy', name: 'quote.pdf' }, { kind: 'error', reason: 'FAILED' }])
    expect(calls).toEqual(['request quote.pdf application/pdf'])
    expect(alertOf(view({ kind: 'error', reason: 'FAILED' }, 'th'))).toBe(th.files.failed)
    expect(alertOf(view({ kind: 'error', reason: 'FAILED' }, 'en'))).toBe('The upload did not work. Check your connection and try again.')
  })

  it('a file that is not a photo goes as it is: on its way, recorded, attached, and the button is ready again', async () => {
    const { shown, attached } = await choose(pdf)
    expect(shown).toEqual([{ kind: 'busy', name: 'quote.pdf' }, { kind: 'idle' }])
    expect(attached).toEqual([{ fileId: 'file-1', fileName: 'quote.pdf' }])
    expect(calls).toEqual(['request quote.pdf application/pdf', 'complete ticket-1'])
    expect(puts).toEqual(['http://storage.test/put?X-Amz-Signature=abc'])
    expect(alertOf(view({ kind: 'idle' }, 'th'))).toBeNull()
  })

  it('a recorded file the form could not attach (a server action with no answer) is a failed upload', async () => {
    const { shown } = await choose(pdf, () => Promise.reject(new Error('no answer')))
    expect(shown.at(-1)).toEqual({ kind: 'error', reason: 'FAILED' })
  })
})
