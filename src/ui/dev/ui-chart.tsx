'use client'

import { useTranslations } from 'next-intl'
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/ui/shadcn/chart'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/shadcn/table'

// The chart of /dev/ui (§9.10): horizontal bars in --chart-1 with a value label on every bar and the same figures as a
// table. Loaded with import() by the showcase, so recharts is not in the page's first JavaScript.

const ROWS = [
  { key: 'construction', value: 412 },
  { key: 'operations', value: 268 },
  { key: 'office', value: 95 },
] as const

export function UiChart() {
  const t = useTranslations('devUi.chart')
  const data = ROWS.map((row) => ({ name: t(row.key), value: row.value }))
  const config = { value: { label: t('value'), color: 'var(--chart-1)' } } satisfies ChartConfig
  return (
    <figure className="flex flex-col gap-4">
      <figcaption className="font-semibold">{t('title')}</figcaption>
      <ChartContainer config={config} className="aspect-auto h-48 w-full">
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 48 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" width={96} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="value" fill="var(--color-value)" radius={4}>
            <LabelList dataKey="value" position="right" className="fill-ink tabular" />
          </Bar>
        </BarChart>
      </ChartContainer>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('department')}</TableHead>
            <TableHead className="text-right">{t('value')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => (
            <TableRow key={row.name}>
              <TableCell>{row.name}</TableCell>
              <TableCell className="money">{row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </figure>
  )
}
