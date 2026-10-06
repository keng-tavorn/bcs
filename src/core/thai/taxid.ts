// Thai taxpayer ID (spec §7.2, BR-TAXID-01): 13 digits after removing spaces and dashes; the check digit is
// (11 − (Σ digit₁…₁₂ × weights 13…2) mod 11) mod 10.

const TAX_ID = /^\d{13}$/

export function normalizeTaxId(input: string): string {
  return input.replace(/[\s-]/g, '')
}

export function isValidThaiTaxId(input: string): boolean {
  const digits = normalizeTaxId(input)
  if (!TAX_ID.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(digits[12])
}
