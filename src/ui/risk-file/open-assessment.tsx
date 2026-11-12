'use client'

import { useRouter } from 'next/navigation'
import { useId, useState, type FormEvent } from 'react'
import { useFailureText, useRun } from '../risk-admin/run'
import type { RiskAdminOutcome } from '../risk-admin/model'
import { useSay } from '../risk-admin/say'
import { Button } from '../shadcn/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../shadcn/dialog'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'

// "เปิดแบบประเมิน" of the supplier's risk file (S11-10 · FR-RSK-201 · BR-RSK-03 · docs/sub-specs/S11.md "หน้าจอ"): the three
// screening answers of the work, its categories and the standards it asks for, in a Dialog the reader opens (no pop-up of
// its own · NG-13). riskAssessment.open checks risk.assessment.manage and that none is open; the new one opens after.

const SCREENING = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const
type Screening = Record<(typeof SCREENING)[number], 'Y' | 'N'>
export type OpenAssessmentAction = (input: { screening: Screening; categoryCodes: string[]; workScopes: string[] }, key: string) => Promise<RiskAdminOutcome>

const list = (text: string) =>
  text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function OpenAssessmentButton({ open }: { open: OpenAssessmentAction }) {
  const t = useSay('risk.file')
  const failureText = useFailureText()
  const working = useRun()
  const router = useRouter()
  const id = useId()
  const [shown, setShown] = useState(false)
  const [screening, setScreening] = useState<Screening>({ processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' })
  const [categories, setCategories] = useState('')
  const [scopes, setScopes] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const outcome = await working.run((key) => open({ screening, categoryCodes: list(categories), workScopes: list(scopes) }, key))
    if (!outcome.ok) return setFailure(failureText(outcome))
    setShown(false)
    if (outcome.id) router.push(`/risk/assessments/${outcome.id}`)
  }

  return (
    <Dialog open={shown} onOpenChange={setShown}>
      <DialogTrigger asChild>
        <Button className="min-h-11 self-start">{t('openSubmit')}</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('openTitle')}</DialogTitle>
            <DialogDescription>{t('openIntro')}</DialogDescription>
          </DialogHeader>
          {SCREENING.map((field) => (
            <fieldset key={field} className="flex flex-col gap-2">
              <legend className="font-medium">{t(`screening.${field}`)}</legend>
              <RadioGroup value={screening[field]} onValueChange={(v) => setScreening((s) => ({ ...s, [field]: v === 'Y' ? 'Y' : 'N' }))} className="flex gap-6">
                {(['Y', 'N'] as const).map((v) => (
                  <div key={v} className="flex min-h-11 items-center gap-2">
                    <RadioGroupItem value={v} id={`${id}-${field}-${v}`} />
                    <Label htmlFor={`${id}-${field}-${v}`}>{v === 'Y' ? t('yes') : t('no')}</Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
          ))}
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-categories`}>{t('categories')}</Label>
            <Input id={`${id}-categories`} value={categories} onChange={(e) => setCategories(e.target.value)} className="min-h-11" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-scopes`}>{t('workScopes')}</Label>
            <Input id={`${id}-scopes`} value={scopes} onChange={(e) => setScopes(e.target.value)} className="min-h-11" />
          </div>
          {failure ? (
            <p role="alert" className="text-danger">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setShown(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" className="min-h-11" disabled={working.pending}>
              {working.pending ? t('opening') : t('openSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
