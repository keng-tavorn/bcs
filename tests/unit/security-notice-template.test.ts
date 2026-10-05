import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderNotification } from '@/server/notifications/templates'

// §10.1 security.notice: the account owner's e-mail about a change to their account's security. ADR-049 item 10 adds the
// notice of a new LINE link (kind LINE_LINKED) with the page that undoes it; the other kinds keep their words and pages.
// What the notice tells the owner to do names the pages as the owner finds them: their own page is "บัญชี LINE"
// (/settings/line, its title and menu entry — "ตั้งค่า LINE" is the organization's channel, /admin/line), which links to
// "ลืมรหัสผ่าน" where a new password is set (a signed-in member has no change-password screen, and /login sends them
// away). A new password ends every session of the account, the one in use too, so the notice says "everywhere".

const render = (data: Record<string, unknown>, locale: 'th' | 'en') => renderNotification({ templateKey: 'security.notice', data, subjectType: 'Member', subjectId: 'm' }, locale)

const messages = (locale: 'th' | 'en') =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'messages', `${locale}.json`), 'utf8')) as {
    lineLink: { title: string; unlink: { forgotLink: string } }
    lineSettings: { title: string }
    shell: { items: { lineLink: string; line: string } }
    auth: { forgot: { title: string } }
  }

describe('[FR-LINE-001/AC1] security.notice tells the owner of a new LINE link, with the page to undo it', () => {
  it('has the words of ADR-049 item 10 in Thai and English and links to /settings/line', () => {
    expect(render({ kind: 'LINE_LINKED' }, 'th')).toEqual({
      title: 'มีการผูกบัญชี LINE กับบัญชี BCS ของคุณ',
      body: 'ถ้าไม่ใช่คุณ ให้ยกเลิกการผูกที่หน้าบัญชี LINE แล้วกดลิงก์ ลืมรหัสผ่าน ในหน้าเดียวกันเพื่อตั้งรหัสผ่านใหม่ทันที ซึ่งจะออกจากระบบทุกอุปกรณ์',
      href: '/settings/line',
    })
    expect(render({ kind: 'LINE_LINKED' }, 'en')).toEqual({
      title: 'A LINE account was linked to your BCS account',
      body: 'If this was not you, unlink it on your LINE account page, then use the Forgot password link on that page to set a new password at once, which signs you out everywhere',
      href: '/settings/line',
    })
  })

  it('says a new password signs the owner out everywhere, not only on the other devices (Better Auth ends every session)', () => {
    expect(render({ kind: 'LINE_LINKED' }, 'th').body).toContain('ออกจากระบบทุกอุปกรณ์')
    expect(render({ kind: 'LINE_LINKED' }, 'th').body).not.toContain('อุปกรณ์อื่น')
    expect(render({ kind: 'LINE_LINKED' }, 'en').body).toContain('signs you out everywhere')
    expect(render({ kind: 'LINE_LINKED' }, 'en').body).not.toContain('other device')
  })

  it('names the pages by the names the member sees: the LINE account page it links to, never the organization LINE settings', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messages(locale)
      const body = render({ kind: 'LINE_LINKED' }, locale).body!
      // /settings/line is called the same in its title and in the menu, and the notice uses that name
      expect(m.lineLink.title, locale).toBe(m.shell.items.lineLink)
      expect(body, locale).toContain(locale === 'th' ? `หน้า${m.lineLink.title}` : `your ${m.lineLink.title} page`)
      // ...not the name of /admin/line
      expect(body, locale).not.toContain(m.lineSettings.title)
      expect(body, locale).not.toContain(m.shell.items.line)
      // and the page a signed-in member can set a new password on, by the words of the link /settings/line shows to it
      expect(body, locale).toContain(m.auth.forgot.title)
      expect(m.lineLink.unlink.forgotLink, locale).toContain(m.auth.forgot.title)
    }
  })

  it('keeps the other kinds as they were: the PIN lock to /settings/pin, a 2FA reset and anything else to /settings/security', () => {
    expect(render({ kind: 'PIN_LOCKED' }, 'th').href).toBe('/settings/pin')
    expect(render({ kind: 'TWO_FACTOR_RESET' }, 'th')).toMatchObject({ title: 'การยืนยันตัวตนสองชั้นของคุณถูกรีเซ็ต', href: '/settings/security' })
    expect(render({}, 'en')).toMatchObject({ title: 'There was a security change on your account', href: '/settings/security' })
  })
})
