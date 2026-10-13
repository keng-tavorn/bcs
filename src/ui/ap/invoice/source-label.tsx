import { Bot, FileCheck } from 'lucide-react'
import { Badge } from '../../shadcn/badge'
import type { InvoiceFieldSource } from './types'

/**
 * Where a value of the invoice came from (BR-AP-03, FR-AP-101 AC5): "เติมโดย AI โปรดตรวจ" beside a value the AI read,
 * "จาก e-Tax" beside one the e-Tax file gave; nothing for a value a person typed. An icon and words, never colour alone.
 */
export function SourceLabel({ source, labels }: { source: InvoiceFieldSource | undefined; labels: Readonly<Record<InvoiceFieldSource, string>> }) {
  if (!source) return null
  const Icon = source === 'AI_READING' ? Bot : FileCheck
  return (
    <Badge variant={source === 'AI_READING' ? 'warn' : 'info'} data-source={source} className="whitespace-normal">
      <Icon aria-hidden="true" />
      {labels[source]}
    </Badge>
  )
}
