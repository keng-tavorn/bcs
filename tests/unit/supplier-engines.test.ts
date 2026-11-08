import { describe, expect, it } from 'vitest'
import type { BusinessCalendar } from '@/core/sla'
import { addDays, canVerify, dateIn, documentExpiry, documentStatus, normalizeScope } from '@/core/supplier-docs'
import { checkSod } from '@/core/sod'
import { applicationSla, businessDayMinutes, findSupplierDuplicates, g7Median, normalizeSupplierName, sameHash, verifyOtp } from '@/core/supplier-onboarding'

// S7-03: the branches of src/core/supplier-onboarding and src/core/supplier-docs the golden files do not reach (§7.0
// branch coverage 100%) — the rules are BR-SUP ข้อ 09 ข้อ 12 ข้อ 13 · BR-PORTAL ข้อ 02 · BR-SDOC ข้อ 02 ถึง 04.

const calendar: BusinessCalendar = { timezone: 'Asia/Bangkok', workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start: '08:00', end: '12:00', holidays: [] }
const settings = { otpMinutes: 10, otpMaxAttempts: 5, otpLockMinutes: 15 }

describe('[BR-SUP-09] names and duplicates beyond the golden cases', () => {
  it('drops a legal word that is the whole name, a word after a bracket, and the forms of a public company', () => {
    expect(normalizeSupplierName('บริษัท')).toBe('')
    expect(normalizeSupplierName('บริษัท ไทยรุ่งเรือง จำกัด (มหาชน)')).toBe('ไทยรุ่งเรือง')
    expect(normalizeSupplierName('บมจ. ไทยรุ่งเรือง')).toBe('ไทยรุ่งเรือง')
    // a Thai legal word inside a name is part of the name
    expect(normalizeSupplierName('บริษัทดีจำกัดคุณภาพ')).toBe('บริษัทดีจำกัดคุณภาพ')
    // a bracket that is the whole text stays as it is
    expect(normalizeSupplierName('(สาขา)')).toBe('(สาขา)')
    // a trailing bracket with no legal word before it
    expect(normalizeSupplierName('ร้านดี (สาขา 2)')).toBe('ร้านดี(สาขา2)')
    expect(normalizeSupplierName('ACME Inc.')).toBe('acme')
    expect(normalizeSupplierName('Siam PLC')).toBe('siam')
  })

  it('a taxpayer id with dashes and spaces is compared as its digits; no e-mail compares with none; a blank id is no id', () => {
    const existing = [{ ref: 'A', taxId: '0-9999-98010-01-4', branchCode: '00000', nameTh: 'ก', emails: [] }]
    expect(findSupplierDuplicates({ taxId: '0999998010014', branchCode: '00000', nameTh: 'ข', email: null }, existing)).toMatchObject({ ok: false, code: 'DUPLICATE_SUPPLIER', matches: ['A'] })
    expect(findSupplierDuplicates({ taxId: '  ', branchCode: '00000', nameTh: 'ข', email: '' }, existing)).toEqual({ ok: true, warnings: [] })
    expect(findSupplierDuplicates({ taxId: '0999998010014', branchCode: '00000', nameTh: 'ข', email: null }, [{ ...existing[0]!, taxId: null }])).toEqual({ ok: true, warnings: [] })
  })
})

describe('[BR-PORTAL-02] OTP beyond the golden cases', () => {
  it('hashes of different length never match; a wrong code with the lock passed and time left counts again', () => {
    expect(sameHash('abc', 'abcd')).toBe(false)
    expect(sameHash('abcd', 'abc')).toBe(false)
    expect(sameHash('abc', 'abc')).toBe(true)
    const challenge = { createdAt: new Date('2026-11-02T02:00:00Z'), codeHash: 'h1', attempts: 0, lockedUntil: new Date('2026-11-02T02:01:00Z') }
    expect(verifyOtp(challenge, 'h2', new Date('2026-11-02T02:02:00Z'), settings)).toEqual({ ok: false, code: 'OTP_INVALID', attempts: 1, remaining: 4 })
  })
})

describe('[BR-SUP-12] [BR-SUP-13] the SLA on another calendar', () => {
  it('a business day is the hours of the calendar (08:00–12:00 → 240 minutes)', () => {
    expect(businessDayMinutes(calendar)).toBe(240)
    const sla = applicationSla({ invitedAt: new Date('2026-11-02T01:00:00Z'), lastActivityAt: new Date('2026-11-02T01:00:00Z') }, { applicationReminderBusinessDays: 1, applicationEscalateBusinessDays: 2, applicationExpireDays: 1 }, calendar)
    // a full business day from the opening ends at that day's closing (12:00 = 05:00Z)
    expect(sla).toEqual({ remindAt: new Date('2026-11-02T05:00:00Z'), escalateAt: new Date('2026-11-03T05:00:00Z'), expiresAt: new Date('2026-11-03T01:00:00Z') })
  })

  it('the median of one value is that value; a whole number reads as tenths', () => {
    expect(g7Median(['4'])).toBe('4.0')
    expect(g7Median(['4.', '2.15'])).toBe('2.1')
  })
})

describe('[BR-SDOC-02] [BR-SDOC-03] [BR-SDOC-04] documents beyond the golden cases', () => {
  const terms = { validityDays: 180, reminderDaysBefore: 30 }
  it('refuses a date that is not a date, a validity that is not a whole number, and a document issued after today', () => {
    expect(documentExpiry(terms, { issuedOn: '3 Nov 2026' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'DATE' })
    expect(documentExpiry(terms, { issuedOn: '2026-11-03', expiresOn: '2027/05/01' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'DATE' })
    expect(documentExpiry({ ...terms, validityDays: 1.5 }, { issuedOn: '2026-11-03' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'VALIDITY_DAYS' })
    expect(documentExpiry(terms, { issuedOn: '2026-11-04' }, '2026-11-03')).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'ISSUED_IN_FUTURE' })
    expect(documentExpiry(terms, { issuedOn: '2026-11-03' }, '2026-11-03')).toEqual({ ok: true, expiresOn: '2027-05-01', remindOn: '2027-04-01' })
  })

  it('a document not VERIFIED keeps its state and is not reminded of', () => {
    expect(documentStatus({ status: 'PENDING', expiresOn: '2020-01-01', remindOn: '2019-12-01' }, new Date('2027-01-01T00:00:00Z'), 'Asia/Bangkok')).toEqual({ status: 'PENDING', reminderDue: false })
  })

  it('only a PENDING document with a CLEAN file may be verified', () => {
    expect(canVerify({ status: 'PENDING', scanStatus: 'CLEAN' })).toEqual({ ok: true })
    expect(canVerify({ status: 'PENDING', scanStatus: 'INFECTED' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'FILE_INFECTED' })
    expect(canVerify({ status: 'VERIFIED', scanStatus: 'CLEAN' })).toEqual({ ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'VERIFIED' })
  })

  it('dates: days added across a leap day, and the Bangkok date of an instant', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
    expect(dateIn(new Date('2027-05-01T17:00:00Z'), 'Asia/Bangkok')).toBe('2027-05-02')
    expect(normalizeScope(null)).toBe('')
    expect(normalizeScope('\tISO  9001 ')).toBe('iso 9001')
  })
})

describe('[BR-SOD-11] the conflicted people of a supplier application never approve it', () => {
  it('one of them → SOD_VIOLATION BR-SOD-11 (before BR-SOD-01); anyone else may', () => {
    const policy = { approverMayReceive: false, requesterMayReceive: true }
    expect(checkSod({ kind: 'DECIDE_APPROVAL', subject: 'SUPPLIER_APPLICATION', actorMemberId: 'inviter', requesterMemberIds: ['inviter', 'verifier'] }, policy)).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-11' })
    expect(checkSod({ kind: 'DECIDE_APPROVAL', subject: 'SUPPLIER_APPLICATION', actorMemberId: 'manager', requesterMemberIds: ['inviter', 'verifier'] }, policy)).toEqual({ ok: true })
  })
})
