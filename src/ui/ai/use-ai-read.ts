'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MS_PER_SECOND } from '@/lib/constants'
import type { AiReadActions, AiResultView } from './types'

// Reading a file with the Document Agent from a screen (FR-AI-303 AC1): start, then ask for the result every
// POLL_MS until it is a draft or failed, at most POLL_LIMIT times (the hourly sweep fails a call that never ends). The
// page may be left meanwhile: the result stays on the AgentAction.

const POLL_MS = (3 * MS_PER_SECOND) / 2
const POLL_LIMIT = 120

export type AiReadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'done'; readonly result: AiResultView }
  /** code: a refusal of the start (a gate, AI_FILE_UNSUPPORTED with its reason) or the failed result's errorCode */
  | { readonly kind: 'failed'; readonly code: string; readonly reason?: string }

export function useAiRead(actions: AiReadActions | undefined) {
  const [state, setState] = useState<AiReadState>({ kind: 'idle' })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const read = useCallback(
    async (input: Parameters<AiReadActions['start']>[0], idempotencyKey: string): Promise<AiResultView | null> => {
      if (!actions) return null
      setState({ kind: 'reading' })
      const started = await actions.start(input, idempotencyKey).catch(() => ({ ok: false as const, code: 'NETWORK' }))
      if (!started.ok) {
        if (alive.current) setState({ kind: 'failed', code: started.code, ...('reason' in started && started.reason ? { reason: started.reason } : {}) })
        return null
      }
      for (let i = 0; i < POLL_LIMIT && alive.current; i++) {
        await new Promise<void>((resolve) => {
          timer.current = setTimeout(resolve, POLL_MS)
        })
        const r = await actions.result(started.agentActionId).catch(() => null)
        if (!alive.current) return null
        if (!r || !r.ok || r.result.status === 'PENDING') continue
        if (r.result.status === 'FAILED') {
          setState({ kind: 'failed', code: r.result.errorCode ?? 'FAILED' })
          return null
        }
        setState({ kind: 'done', result: r.result })
        return r.result
      }
      if (alive.current) setState({ kind: 'failed', code: 'TIMEOUT' })
      return null
    },
    [actions],
  )
  const reset = useCallback(() => setState({ kind: 'idle' }), [])
  return { state, read, reset }
}
