'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { FileUpload, type FileUploadProps } from './file-upload'

// Developer-only page body: both upload modes plus a way to open what was uploaded (used by the e2e tests of
// FR-PLT-004 until request forms provide the real place for attachments in S2-11).
export function UploadHarness({
  requestUpload,
  completeUpload,
  downloadUrl,
}: Pick<FileUploadProps, 'requestUpload' | 'completeUpload'> & { downloadUrl: (fileId: string) => Promise<string | null> }) {
  const t = useTranslations('files')
  const [files, setFiles] = useState<Array<{ fileId: string; fileName: string; url?: string | null }>>([])
  const remember = (file: { fileId: string; fileName: string }) => setFiles((list) => [...list, file])
  return (
    <div className="flex flex-col gap-6">
      <FileUpload requestUpload={requestUpload} completeUpload={completeUpload} onUploaded={remember} />
      <FileUpload requestUpload={requestUpload} completeUpload={completeUpload} mode="photo" onUploaded={remember} />
      <ul className="flex flex-col gap-2">
        {files.map((file) => (
          <li key={file.fileId} className="flex flex-wrap items-center gap-3">
            {file.url ? (
              <a href={file.url} className="font-medium text-primary underline underline-offset-4" data-file-id={file.fileId}>
                {t('download', { name: file.fileName })}
              </a>
            ) : (
              <Button
                variant="secondary"
                onClick={async () => {
                  const url = await downloadUrl(file.fileId)
                  setFiles((list) => list.map((f) => (f.fileId === file.fileId ? { ...f, url } : f)))
                }}
              >
                {t('download', { name: file.fileName })}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
