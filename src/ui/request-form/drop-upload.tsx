'use client'

import { Upload } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type ChangeEvent } from 'react'
import { useDropzone } from 'react-dropzone'
import { cn } from '../cn'
import { UploadButtonView, uploadFromButton, type UploadActions, type UploadButtonStatus } from './upload-button'

// The workspace form's upload (FR-INT-011 AC5, §9.10 "ไฟล์ | Attachment กับ react-dropzone"): the same button and the same
// steps as UploadButton (FR-PLT-004: prepared in the browser, a presigned PUT, then the server checks the type and size
// again, NFR-SEC-08), inside an area a file may be dropped on. One file at a time, as the button takes. Its state is
// said in words — the area's own line, then the button's (uploading, or why the file was not attached). LIFF keeps the
// plain button: react-dropzone stays out of its JavaScript (ADR-052).

export function DropUploadButton({
  label,
  actions,
  onUploaded,
  disabled,
  className,
  showRule = true,
}: {
  label: string
  actions: UploadActions
  onUploaded: (file: { fileId: string; fileName: string }) => Promise<void> | void
  disabled?: boolean
  className?: string
  showRule?: boolean
}) {
  const t = useTranslations('requestForm.wizard')
  const id = useId()
  const [status, setStatus] = useState<UploadButtonStatus>({ kind: 'idle' })
  const busy = status.kind === 'busy'
  const start = (file: File) => void uploadFromButton(file, actions, onUploaded, setStatus)
  // The button opens the file chooser itself; the area only takes what is dropped on it
  const { getRootProps, isDragActive } = useDropzone({
    noClick: true,
    noKeyboard: true,
    multiple: false,
    disabled: disabled || busy,
    onDrop: (files) => {
      const file = files[0]
      if (file) start(file)
    },
  })

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) start(file)
  }

  return (
    <div
      {...getRootProps({
        className: cn('flex min-w-0 flex-col gap-2 rounded-md border border-dashed p-3 transition-colors duration-150', isDragActive ? 'border-primary bg-primary-tint' : 'border-input bg-bg', className),
      })}
    >
      <p className="flex items-center gap-2 text-ink-muted">
        <Upload className="size-4 shrink-0" aria-hidden="true" />
        <span>{isDragActive ? t('dropNow') : t('dropHere')}</span>
      </p>
      <UploadButtonView id={id} label={label} status={status} disabled={disabled} showRule={showRule} onChange={onChange} />
    </div>
  )
}
