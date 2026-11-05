import { describe, expect, it } from 'vitest'
import { companyNameKey } from '@/core/thai/company-name'

// NEW-120: the Intake Agent finds the supplier the requester named in the register whether or not the name kept its
// legal form ("บริษัท … จำกัด"), as people write it in the home page's box
describe('[FR-AI-302/AC4] companyNameKey', () => {
  it('[FR-AI-302/AC4] the same company with or without its legal form, case or spacing', () => {
    const key = companyNameKey('บริษัท สหมิตรวัสดุสำรวจและรังวัด จำกัด')
    for (const written of ['สหมิตรวัสดุสำรวจและรังวัด จำกัด', 'สหมิตรวัสดุสำรวจและรังวัด', 'บจก. สหมิตรวัสดุสำรวจและรังวัด', 'บริษัท  สหมิตรวัสดุสำรวจและรังวัด  จำกัด']) expect(companyNameKey(written), written).toBe(key)
    expect(companyNameKey('ห้างหุ้นส่วนจำกัด ท่าเรือพาณิชย์มีเดีย')).toBe(companyNameKey('หจก. ท่าเรือพาณิชย์มีเดีย'))
    expect(companyNameKey('บริษัท ปูนใหญ่ จำกัด (มหาชน)')).toBe(companyNameKey('ปูนใหญ่'))
    expect(companyNameKey('ACME Co., Ltd.')).toBe(companyNameKey('acme'))
  })

  it('[FR-AI-302/AC4] other words still tell companies apart; a name that is only a legal form keeps its words', () => {
    expect(companyNameKey('บริษัท ปูนดี จำกัด')).not.toBe(companyNameKey('บริษัท ปูนดีกว่า จำกัด'))
    expect(companyNameKey('บริษัท แสงทองพาณิชย์ไอที โซลูชั่น จำกัด')).not.toBe(companyNameKey('แสงทองพาณิชย์'))
    expect(companyNameKey('บริษัท')).toBe('บริษัท')
  })
})
