import { ImageResponse } from 'next/og'

// The BCS app icon (spec §9.7): the wordmark (auth.brand) on the primary colour. A maskable icon keeps the mark inside
// the central safe zone so launchers can crop it to any shape.
export function appIcon(size: number, maskable: boolean, wordmark: string): ImageResponse {
  const scale = maskable ? 0.24 : 0.32
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b6e5f',
          color: '#ffffff',
          fontSize: Math.round(size * scale),
          fontWeight: 700,
          letterSpacing: -Math.round(size * 0.01),
        }}
      >
        {wordmark}
      </div>
    ),
    { width: size, height: size },
  )
}
