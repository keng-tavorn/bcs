// Names of people, departments and positions in the reader's language: English when it exists and the screen is in
// English, Thai otherwise (names are data, not screen text; FR-PLT-002 AC2).

export interface Named {
  readonly nameTh: string
  readonly nameEn: string | null
}

export function nameIn(locale: string, named: Named): string {
  return locale === 'en' && named.nameEn ? named.nameEn : named.nameTh
}

/** A member as the pickers list them: "สมชาย ใจดี (req_con)" */
export function memberLabel(locale: string, m: Named & { readonly employeeCode: string | null }): string {
  return m.employeeCode ? `${nameIn(locale, m)} (${m.employeeCode})` : nameIn(locale, m)
}

/** A department as the pickers list it, indented by its depth in the tree */
export function departmentOption(locale: string, d: Named & { readonly code: string; readonly depth: number }): string {
  return `${' '.repeat(Math.min(d.depth, 8))}${nameIn(locale, d)} (${d.code})`
}
