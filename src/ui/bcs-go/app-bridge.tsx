'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { listenForPushTaps } from './native'

// In the BCS Go app only (S17-10, FR-PLT-301 AC1): a tapped push opens its page inside the app (data.path, a path of
// BCS itself). In a browser it does nothing and loads nothing: the plugin is imported only inside the app.
export function AppBridge() {
  const router = useRouter()
  useEffect(() => {
    let stop: (() => void) | null = null
    let ended = false
    void listenForPushTaps((path) => router.push(path)).then((off) => {
      if (ended) off()
      else stop = off
    })
    return () => {
      ended = true
      stop?.()
    }
  }, [router])
  return null
}
