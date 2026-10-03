import { encode } from 'uqr'

// QR code drawn as one SVG path (no HTML injection). Dark modules use --ink on --bg with a 4-module quiet zone.
const QUIET_ZONE = 4

export function QrCode({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
  const { data } = encode(value, { border: 0 })
  const modules = data.length
  const box = modules + QUIET_ZONE * 2
  let path = ''
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`
    }),
  )
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" className="bg-bg">
      <rect width={box} height={box} fill="var(--bg)" />
      <path d={path} fill="var(--ink)" />
    </svg>
  )
}
