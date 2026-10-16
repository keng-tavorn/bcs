import { encode } from 'uqr'

// The QR of a printed document's verification link (S6-19 · BR-QR-01) as one vector path: dark modules as unit
// squares, a quiet zone of 4 modules all round (ISO/IEC 18004), drawn by react-pdf's Svg — no image, no font.

const QUIET_ZONE = 4

export function qrPath(value: string): { size: number; path: string } {
  const { data } = encode(value, { border: 0 })
  let path = ''
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`
    }),
  )
  return { size: data.length + QUIET_ZONE * 2, path }
}
