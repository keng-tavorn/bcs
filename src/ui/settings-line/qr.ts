import { encode } from 'uqr'

// The QR code of a link as one SVG path, made on the server (the server action of /settings/line) so the page gets a
// drawing and no QR library: dark modules as unit squares, with a quiet zone of 4 modules all round (ISO/IEC 18004).
// The path holds only M, h, v and z commands with numbers, so it can go into <path d> as it is (nothing to escape).

const QUIET_ZONE = 4

export interface QrDrawing {
  /** Modules on each side, quiet zone included: the SVG's viewBox is 0 0 size size */
  readonly size: number
  readonly path: string
}

export function qrDrawing(value: string): QrDrawing {
  const { data } = encode(value, { border: 0 })
  let path = ''
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`
    }),
  )
  return { size: data.length + QUIET_ZONE * 2, path }
}
