'use client'

import { OTPInputContext } from 'input-otp'
import { useContext, type ReactNode } from 'react'
import { cn } from '../cn'
import { useHydrated } from '../form/hydrated'
import { InputOTP, InputOTPGroup } from '../shadcn/input-otp'
import { pinFieldDigits } from '../tasks/pin-field'

// The transaction PIN of the decision bar (FR-AUTH-005 AC2, BR-TOK-05, §9.10 "PIN และ TOTP: Input OTP"): six boxes on a
// number keypad, each digit drawn as a dot, never as itself. As the PIN field of the task page (src/ui/tasks/pin-field.tsx)
// it takes digits only, asks browsers and password managers not to keep it (a one-time code), and takes nothing before the
// page's script runs, because the form it is in is sent by the script only (NFR-SEC-09). The page clears it after every
// try; the server checks the six digits again.

const PIN_LENGTH = 6
const SLOTS = Array.from({ length: PIN_LENGTH }, (_, i) => i)

function MaskedSlot({ index, invalid }: { index: number; invalid: boolean }) {
  const context = useContext(OTPInputContext)
  const slot = context?.slots[index]
  return (
    <div
      data-slot="input-otp-slot"
      data-active={slot?.isActive}
      aria-invalid={invalid || undefined}
      className={cn(
        'relative flex size-11 items-center justify-center border-y border-r border-line-strong bg-bg text-lg text-ink first:rounded-l-md first:border-l last:rounded-r-md',
        slot?.isActive && 'z-10 ring-2 ring-focus ring-offset-2',
        invalid && 'border-danger',
      )}
    >
      {slot?.char ? <span aria-hidden="true">•</span> : null}
      {slot?.hasFakeCaret ? <span aria-hidden="true" className="pointer-events-none absolute h-5 w-px animate-caret-blink bg-ink" /> : null}
    </div>
  )
}

export function PinOtp({ id, label, value, onChange, error, disabled }: { id: string; label: ReactNode; value: string; onChange: (value: string) => void; error?: ReactNode; disabled?: boolean }) {
  const hydrated = useHydrated()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <InputOTP
        id={id}
        name="pin"
        maxLength={PIN_LENGTH}
        value={value}
        onChange={(next) => onChange(pinFieldDigits(next))}
        inputMode="numeric"
        pattern="^[0-9]*$"
        autoComplete="one-time-code"
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        disabled={disabled || !hydrated}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        <InputOTPGroup>
          {SLOTS.map((i) => (
            <MaskedSlot key={i} index={i} invalid={Boolean(error)} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      {error ? (
        <p id={`${id}-error`} className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
