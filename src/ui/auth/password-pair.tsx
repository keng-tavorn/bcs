'use client'

import { useTranslations } from 'next-intl'
import { Field } from '../form/field'

// "New password" + "again" fields used by invitation and reset. Checks happen in the caller on submit.
export function PasswordPair({ min, labels, errors }: { min: number; labels: { password: string; confirm: string }; errors: { password?: string; confirm?: string } }) {
  const t = useTranslations('auth')
  return (
    <>
      <Field
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={min}
        required
        label={labels.password}
        hint={t('passwordRule', { min })}
        error={errors.password}
      />
      <Field id="confirm" name="confirm" type="password" autoComplete="new-password" required label={labels.confirm} error={errors.confirm} />
    </>
  )
}

export function readPasswordPair(form: FormData): { password: string; confirm: string } {
  return { password: String(form.get('password') ?? ''), confirm: String(form.get('confirm') ?? '') }
}
