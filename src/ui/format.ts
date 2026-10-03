import { formatEnglishBeDateTime, formatThaiDateTime } from '@/core/thai/date'

/** A date and time as each language shows it (FR-PLT-002 AC3): "2 ต.ค. 2569 16:30 น." · "2 Oct 2569 16:30". */
export function formatDateTime(locale: string, input: Date | string): string {
  return locale === 'en' ? formatEnglishBeDateTime(input) : formatThaiDateTime(input)
}
