// Thai bank codes (ADR-131, BR-SUP-07): a list in the program, as sheet Banks of the phase-1 file has it, not a table
// shared by every organization (§4.8). A new bank is a change of this list with its test and of scripts/inputs_p1.

export interface Bank {
  /** The three digits of the Bank of Thailand's list */
  readonly code: string
  readonly shortName: string
  readonly nameTh: string
}

export const BANKS: readonly Bank[] = [
  { code: '002', shortName: 'BBL', nameTh: 'ธนาคารกรุงเทพ' },
  { code: '004', shortName: 'KBANK', nameTh: 'ธนาคารกสิกรไทย' },
  { code: '006', shortName: 'KTB', nameTh: 'ธนาคารกรุงไทย' },
  { code: '011', shortName: 'TTB', nameTh: 'ธนาคารทหารไทยธนชาต' },
  { code: '014', shortName: 'SCB', nameTh: 'ธนาคารไทยพาณิชย์' },
  { code: '022', shortName: 'CIMBT', nameTh: 'ธนาคารซีไอเอ็มบี ไทย' },
  { code: '024', shortName: 'UOBT', nameTh: 'ธนาคารยูโอบี' },
  { code: '025', shortName: 'BAY', nameTh: 'ธนาคารกรุงศรีอยุธยา' },
  { code: '030', shortName: 'GSB', nameTh: 'ธนาคารออมสิน' },
  { code: '069', shortName: 'KKP', nameTh: 'ธนาคารเกียรตินาคินภัทร' },
  { code: '073', shortName: 'LHB', nameTh: 'ธนาคารแลนด์ แอนด์ เฮ้าส์' },
]

const BY_CODE = new Map(BANKS.map((b) => [b.code, b]))

/** The bank of a code, or null when the list has no such code (BANK_CODE_UNKNOWN) */
export function bankOf(code: string): Bank | null {
  return BY_CODE.get(code) ?? null
}
