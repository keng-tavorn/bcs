/** The tab a document page opens on (FR-INT-012 AC2): the one the address names when the page has it, else the first */
export function tabFrom(param: string | string[] | undefined, values: readonly string[]): string {
  const wanted = Array.isArray(param) ? param[0] : param
  return wanted && values.includes(wanted) ? wanted : (values[0] ?? '')
}
