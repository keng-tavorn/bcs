'use client'

import { CirclePlus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { DocumentFields } from './document-fields'
import { documentDraftOf, documentOf, type DocumentDraft, type DocumentField, type TestCaseValue } from './model'
import type { WorkflowContext, WorkflowWords } from './words'

// The test cases of a draft (as BR-DOA-08 (ง)): a document and the rules it must match; every case must pass before
// the draft is sent. Edited one at a time in place, in the list (no dialog over the page's other dialog, §9.9).

export interface TestCasesProps {
  readonly testCases: readonly TestCaseValue[]
  readonly onChange: (testCases: readonly TestCaseValue[]) => void
  readonly ruleCodes: readonly string[]
  /** Names of the cases that do not pass on the saved draft */
  readonly failing: readonly string[]
  readonly editable: boolean
  readonly context: WorkflowContext
  readonly words: WorkflowWords
  readonly categoryCodes: readonly string[]
  readonly accountCodes: readonly string[]
}

type Editing = { readonly index: number | 'new'; readonly name: string; readonly document: DocumentDraft; readonly expected: readonly string[] }

export function TestCases({ testCases, onChange, ruleCodes, failing, editable, context, words, categoryCodes, accountCodes }: TestCasesProps) {
  const { t } = words
  const id = useId()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [errors, setErrors] = useState<{ name?: string; document: Partial<Record<DocumentField, 'REQUIRED' | 'MONEY' | 'NET_ABOVE_GROSS'>> }>({ document: {} })

  function start(index: number | 'new') {
    const tc = index === 'new' ? null : testCases[index]!
    setErrors({ document: {} })
    setEditing({ index, name: tc?.name ?? '', document: documentDraftOf(tc?.input ?? null, context.requestTypes[0]?.code ?? ''), expected: tc?.expected.ruleCodes ?? [] })
  }

  function save() {
    if (!editing) return
    const name = editing.name.trim()
    const doc = documentOf(editing.document)
    const duplicate = testCases.some((tc, i) => tc.name === name && i !== editing.index)
    const nameError = name === '' ? t('testCases.nameRequired') : duplicate ? t('testCases.nameDuplicate') : undefined
    if (nameError || !doc.ok) return setErrors({ name: nameError, document: doc.ok ? {} : doc.errors })
    const value: TestCaseValue = { name, input: doc.value, expected: { ruleCodes: ruleCodes.filter((c) => editing.expected.includes(c)) } }
    onChange(editing.index === 'new' ? [...testCases, value] : testCases.map((tc, i) => (i === editing.index ? value : tc)))
    setEditing(null)
  }

  const editor = (e: Editing) => (
    <fieldset className="flex flex-col gap-4 border-l-4 border-primary py-1 pl-3">
      <legend className="float-left mb-1 w-full font-semibold">{e.index === 'new' ? t('testCases.addTitle') : t('testCases.editTitle', { name: testCases[e.index as number]!.name })}</legend>
      <Field id={`${id}-name`} label={t('testCases.name')} value={e.name} maxLength={200} onChange={(ev) => setEditing({ ...e, name: ev.currentTarget.value })} error={errors.name} />
      <DocumentFields
        id={`${id}-doc`}
        draft={e.document}
        onChange={(document) => setEditing({ ...e, document })}
        errors={errors.document}
        context={context}
        words={words}
        categoryCodes={categoryCodes}
        accountCodes={accountCodes}
      />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-medium">{t('testCases.expected')}</legend>
        <p className="text-base text-ink-muted md:text-sm">{t('testCases.expectedHint')}</p>
        <div className="grid gap-x-6 sm:grid-cols-3">
          {ruleCodes.map((code) => (
            <label key={code} className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={e.expected.includes(code)}
                onChange={(ev) => {
                  const checked = ev.currentTarget.checked
                  setEditing({ ...e, expected: checked ? [...e.expected, code] : e.expected.filter((c) => c !== code) })
                }}
                className="size-5 shrink-0"
              />
              <span>{code}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save}>{e.index === 'new' ? t('testCases.addSave') : t('testCases.save')}</Button>
        <Button variant="secondary" onClick={() => setEditing(null)}>
          {t('testCases.cancel')}
        </Button>
        {e.index !== 'new' ? (
          <Button
            variant="danger"
            className="ml-auto"
            aria-label={t('testCases.removeNamed', { name: testCases[e.index]!.name })}
            onClick={() => {
              onChange(testCases.filter((_, i) => i !== e.index))
              setEditing(null)
            }}
          >
            <Trash2 className="size-4 shrink-0" aria-hidden="true" />
            {t('testCases.remove')}
          </Button>
        ) : null}
      </div>
    </fieldset>
  )

  return (
    <div className="flex flex-col gap-3">
      {testCases.length === 0 ? <p className="text-ink-muted">{t('testCases.none')}</p> : null}
      {testCases.length ? (
        <ul aria-label={t('testCases.title')} className="flex flex-col divide-y divide-line border-y border-line">
          {testCases.map((tc, i) => (
            <li key={`${tc.name}-${i}`} className="flex flex-col gap-2 py-3">
              {editing?.index === i ? (
                editor(editing)
              ) : (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="font-medium break-words">{tc.name}</p>
                    <p className="text-base text-ink-muted md:text-sm">
                      {t('testCases.summary', { type: words.requestType(tc.input.requestType), amount: words.money(tc.input.amountGross) })}
                    </p>
                    <p className="text-base text-ink-muted md:text-sm">{tc.expected.ruleCodes.length ? t('testCases.expects', { rules: tc.expected.ruleCodes.join(', ') }) : t('testCases.expectsNone')}</p>
                    {failing.includes(tc.name) ? <p className="text-base text-danger md:text-sm">{t('testCases.failing')}</p> : null}
                  </div>
                  {editable ? (
                    <Button variant="secondary" className="self-start" aria-label={t('testCases.editNamed', { name: tc.name })} onClick={() => start(i)}>
                      {t('testCases.edit')}
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {editable ? (
        editing?.index === 'new' ? (
          editor(editing)
        ) : (
          <Button variant="secondary" className="self-start" onClick={() => start('new')}>
            <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
            {t('testCases.add')}
          </Button>
        )
      ) : null}
    </div>
  )
}
