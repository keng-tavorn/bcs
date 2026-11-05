// A company's name as people write it (NEW-120, the Intake Agent's supplier match): the same company whether or not the
// writer kept its legal form — "บริษัท … จำกัด", "บจก.", "ห้างหุ้นส่วนจำกัด", "หจก.", "(มหาชน)", "Co., Ltd." — or the
// spacing. Used to find a supplier of the register by its name; a match still needs exactly one supplier, and the
// requester confirms it.

const LEGAL_FORMS = [
  /^ห้างหุ้นส่วนจำกัด\s*/u,
  /^ห้างหุ้นส่วนสามัญ\s*/u,
  /^หจก\.?\s*/u,
  /^บริษัท\s*/u,
  /^บจก\.?\s*/u,
  /^บมจ\.?\s*/u,
  /\s*\(มหาชน\)$/u,
  /\s*จำกัด$/u,
  /[\s,]*(co\.?,?\s*)?ltd\.?$/u,
  /[\s,]*(public\s+)?company\s+limited$/u,
] as const

/** The words of a company name without its legal form, case or spacing: equal for the same company */
export function companyNameKey(name: string): string {
  let s = name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
  for (let again = true; again; ) {
    again = false
    for (const form of LEGAL_FORMS) {
      const next = s.replace(form, '').trim()
      if (next !== s && next !== '') {
        s = next
        again = true
      }
    }
  }
  return s
}
