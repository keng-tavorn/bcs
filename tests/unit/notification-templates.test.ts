import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderNotification, TEMPLATES } from '@/server/notifications/templates'

// FR-NOTI-001 AC1, §4.7 rule 5: every template key the code notifies with (found by scanning src/, never listed by
// hand) has a template with Thai and English text, and the §10.1 names are used where the spec names one.

const SRC = path.resolve(import.meta.dirname, '..', '..', 'src')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return full.includes(`${path.sep}generated`) ? [] : files(full)
    return /\.tsx?$/.test(e.name) ? [full] : []
  })
}

const literal = /templateKey:\s*'([a-z_.]+)'/g
const keys = new Set(files(SRC).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(literal)].map((m) => m[1]!)))
// Keys built from a pattern in policy-decide.ts (the submitter of a policy change hears the decision)
for (const subject of ['doa_version', 'org_authority_change']) for (const outcome of ['approved', 'rejected']) keys.add(`${subject}.${outcome}`)
// Passed to a helper as an argument (decide.ts notifyRequester)
for (const k of ['request.approved', 'request.decided', 'request.info_requested']) keys.add(k)

describe('[FR-NOTI-001/AC1] notification templates', () => {
  it('finds the keys the code uses', () => expect(keys.size).toBeGreaterThanOrEqual(12))

  for (const k of [...keys].sort()) {
    it(`${k} has Thai and English text`, () => {
      expect(TEMPLATES[k], k).toBeDefined()
      const th = renderNotification({ templateKey: k, data: { number: 'PR-2569-00001', requestId: 'r', taskId: 't', kind: 'DOA_VERSION' }, subjectType: null, subjectId: null }, 'th')
      const en = renderNotification({ templateKey: k, data: { number: 'PR-2569-00001', requestId: 'r', taskId: 't', kind: 'DOA_VERSION' }, subjectType: null, subjectId: null }, 'en')
      expect(th.title.length).toBeGreaterThan(0)
      expect(en.title).not.toBe(th.title)
      expect(en.title).not.toMatch(/[฀-๿]/)
    })
  }

  it('uses the §10.1 template names: task.assigned, request.decided, doa.authority_changed', () => {
    for (const k of ['task.assigned', 'request.decided', 'doa.authority_changed', 'security.notice', 'admin.module_changed']) expect(keys.has(k), k).toBe(true)
    expect([...keys].filter((k) => k === 'approval_task.assigned' || k === 'request.returned' || k === 'request.rejected')).toEqual([])
  })

  it('an unknown key still shows something, without a link', () => {
    expect(renderNotification({ templateKey: 'nope', data: {}, subjectType: null, subjectId: null }, 'th')).toEqual({ title: 'มีการแจ้งเตือนใหม่', body: null, href: null })
  })
})
