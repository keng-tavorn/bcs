// Account e-mails (FR-AUTH-001). Templates live in code in Thai and English (spec §4.7 rule 5); the button
// text says what will happen (§9.9 principle 7). Links carry one-time tokens — never log them.

export type EmailLocale = 'th' | 'en'

export interface RenderedEmail {
  readonly subject: string
  readonly text: string
  readonly html: string
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function layout(title: string, paragraphs: string[], action: { label: string; url: string }, footer: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f7f8;font-family:'IBM Plex Sans Thai',Tahoma,sans-serif;color:#1c2b33;line-height:1.6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #dde3e7;border-radius:6px"><tr><td style="padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:16px">${escapeHtml(p)}</p>`).join('')}
<p style="margin:20px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#0b6e5f;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:16px;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0;font-size:14px;color:#4a5a63">${escapeHtml(footer)}</p>
</td></tr></table></td></tr></table></body></html>`
}

export function inviteEmail(locale: EmailLocale, p: { orgName: string; inviterName: string | null; link: string; expiresHours: number }): RenderedEmail {
  if (locale === 'en') {
    const lines = [
      `${p.inviterName ?? 'Your administrator'} invited you to ${p.orgName} on BCS.`,
      `Set your password to activate your account. The link works once and expires in ${p.expiresHours} hours.`,
    ]
    return {
      subject: `Invitation to ${p.orgName} on BCS`,
      text: `${lines.join('\n')}\n\nSet password: ${p.link}\n`,
      html: layout(`Invitation to ${p.orgName}`, lines, { label: 'Set password and activate', url: p.link }, 'If you did not expect this e-mail, ignore it.'),
    }
  }
  const lines = [
    `${p.inviterName ?? 'ผู้ดูแลระบบ'} เชิญคุณเข้าใช้ BCS ขององค์กร ${p.orgName}`,
    `ตั้งรหัสผ่านเพื่อเปิดใช้บัญชี ลิงก์ใช้ได้ครั้งเดียวและหมดอายุใน ${p.expiresHours} ชั่วโมง`,
  ]
  return {
    subject: `คำเชิญเข้าใช้ BCS ของ ${p.orgName}`,
    text: `${lines.join('\n')}\n\nตั้งรหัสผ่าน: ${p.link}\n`,
    html: layout(`คำเชิญเข้าใช้ ${p.orgName}`, lines, { label: 'ตั้งรหัสผ่านและเปิดใช้บัญชี', url: p.link }, 'ถ้าคุณไม่ได้คาดว่าจะได้รับอีเมลนี้ ไม่ต้องทำอะไร'),
  }
}

export function resetPasswordEmail(locale: EmailLocale, p: { link: string; expiresMinutes: number }): RenderedEmail {
  if (locale === 'en') {
    const lines = [`Someone asked to reset your BCS password.`, `The link expires in ${p.expiresMinutes} minutes. All signed-in devices will be signed out.`]
    return {
      subject: 'Reset your BCS password',
      text: `${lines.join('\n')}\n\nReset password: ${p.link}\n`,
      html: layout('Reset your password', lines, { label: 'Set a new password', url: p.link }, 'If you did not ask for this, ignore this e-mail; your password stays the same.'),
    }
  }
  const lines = ['มีการขอรีเซ็ตรหัสผ่าน BCS ของคุณ', `ลิงก์หมดอายุใน ${p.expiresMinutes} นาที และทุกอุปกรณ์ที่เข้าระบบอยู่จะถูกออกจากระบบ`]
  return {
    subject: 'รีเซ็ตรหัสผ่าน BCS',
    text: `${lines.join('\n')}\n\nตั้งรหัสผ่านใหม่: ${p.link}\n`,
    html: layout('รีเซ็ตรหัสผ่าน', lines, { label: 'ตั้งรหัสผ่านใหม่', url: p.link }, 'ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้'),
  }
}
