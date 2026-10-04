import type { LiffRequestFormActions, LiffRequestFormPaths } from '@/ui/liff/requests/request-form'
import { liffHref } from '../../_lib/links'
import { attachFileAction, completeUploadAction, detachFileAction, downloadUrlAction, previewRequestAction, requestUploadAction, submitRequestAction } from '../actions'

// What the LIFF request form gets from its pages (./../new/[type]/page.tsx and ../[id]/edit/page.tsx): the server actions
// on the LIFF session (../actions.ts) and where things are in the LIFF app. A request's LIFF page is the one mapping of
// src/channels/line/links.ts (/requests/<id> → /liff/requests/<id>); its draft is that page plus /edit.

export const LIFF_FORM_ACTIONS: LiffRequestFormActions = {
  preview: previewRequestAction,
  attach: attachFileAction,
  detach: detachFileAction,
  submit: submitRequestAction,
  requestUpload: requestUploadAction,
  completeUpload: completeUploadAction,
  downloadUrl: downloadUrlAction,
}

const CATALOG = liffHref('/requests/new') ?? '/liff/requests/new'

export const LIFF_FORM_PATHS: LiffRequestFormPaths = {
  requests: CATALOG.replace(/\/new$/, ''),
  catalog: CATALOG,
  autosave: `${CATALOG}/autosave`,
}

/** A request's LIFF page (/liff/requests/<id>), and its draft's (/liff/requests/<id>/edit) */
export const liffRequestHref = (requestId: string): string => `${LIFF_FORM_PATHS.requests}/${encodeURIComponent(requestId)}`
export const liffDraftHref = (requestId: string): string => `${liffRequestHref(requestId)}/edit`
