import type { StepCardView, StepSlotView } from './step-cards'

// Where the boxes of the route's map go (FR-INT-012 AC3 · ADR-076): one column per step, left to right. A step of slots
// (reviewers, a committee) fans out into one box per slot under a label; everything else is one box. No layout library:
// a route is a line of columns, and its order is the record's, so nothing here decides anything.

export const BOX_WIDTH = 288
const GAP_X = 64
const GAP_Y = 16
export const CANVAS_PAD = 24
const CANVAS_MIN_HEIGHT = 240
const CANVAS_MAX_HEIGHT = 800

export type FlowBox =
  | { readonly id: string; readonly column: number; readonly kind: 'STEP'; readonly step: StepCardView }
  | { readonly id: string; readonly column: number; readonly kind: 'GROUP'; readonly step: StepCardView }
  | { readonly id: string; readonly column: number; readonly kind: 'SLOT'; readonly step: StepCardView; readonly slot: StepSlotView }
  | { readonly id: string; readonly column: number; readonly kind: 'NEXT'; readonly text: string }

export interface FlowLine {
  readonly id: string
  readonly source: string
  readonly target: string
  /** The box it leaves was passed, so the line is drawn as done */
  readonly done: boolean
}

export function boxesOf(steps: readonly StepCardView[], next?: string): FlowBox[] {
  const boxes = steps.flatMap((step, column): FlowBox[] => {
    if (!step.slots?.length) return [{ id: `step-${step.key}`, column, kind: 'STEP', step }]
    return [{ id: `group-${step.key}`, column, kind: 'GROUP', step }, ...step.slots.map((slot): FlowBox => ({ id: `slot-${step.key}-${slot.key}`, column, kind: 'SLOT', step, slot }))]
  })
  return next ? [...boxes, { id: 'next', column: steps.length, kind: 'NEXT', text: next }] : boxes
}

const passed = (box: FlowBox) => (box.kind === 'STEP' ? box.step.stampTone === 'ok' : box.kind === 'SLOT' && box.slot.state.kind === 'done')

/** A line from every box of a column to every box of the next one; a label takes no line */
export function linesOf(boxes: readonly FlowBox[]): FlowLine[] {
  const linked = boxes.filter((b) => b.kind !== 'GROUP')
  return linked.flatMap((source) =>
    linked.filter((target) => target.column === source.column + 1).map((target) => ({ id: `${source.id}>${target.id}`, source: source.id, target: target.id, done: passed(source) })),
  )
}

export interface FlowPlace {
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>
  readonly width: number
  readonly height: number
}

/**
 * Every column's boxes are centred on one line, so a route without slots is straight; a label sits above its boxes and
 * does not move that centre. Boxes differ in height (a stamp is taller than a waiting step), hence `heightOf`.
 */
export function placeBoxes(boxes: readonly FlowBox[], heightOf: (id: string) => number): FlowPlace {
  const columns = [...new Set(boxes.map((b) => b.column))].sort((a, b) => a - b)
  const shape = columns.map((column) => {
    const inColumn = boxes.filter((b) => b.column === column)
    const label = inColumn.find((b) => b.kind === 'GROUP')
    const body = inColumn.filter((b) => b.kind !== 'GROUP')
    const bodyHeight = body.reduce((sum, b) => sum + heightOf(b.id), 0) + GAP_Y * Math.max(0, body.length - 1)
    return { column, label, body, bodyHeight, labelHeight: label ? heightOf(label.id) + GAP_Y : 0 }
  })
  const centre = Math.max(0, ...shape.map((c) => c.labelHeight + c.bodyHeight / 2))
  const below = Math.max(0, ...shape.map((c) => c.bodyHeight / 2))
  const positions = new Map<string, { x: number; y: number }>()
  for (const { column, label, body, bodyHeight } of shape) {
    const x = column * (BOX_WIDTH + GAP_X)
    const top = centre - bodyHeight / 2
    if (label) positions.set(label.id, { x, y: top - GAP_Y - heightOf(label.id) })
    let y = top
    for (const box of body) {
      positions.set(box.id, { x, y })
      y += heightOf(box.id) + GAP_Y
    }
  }
  return { positions, width: columns.length ? columns.length * BOX_WIDTH + (columns.length - 1) * GAP_X : 0, height: centre + below }
}

/** The canvas is as tall as the route within its limits, so a short route leaves no empty field and a long one is panned */
export const canvasHeight = (contentHeight: number) => Math.min(CANVAS_MAX_HEIGHT, Math.max(CANVAS_MIN_HEIGHT, Math.ceil(contentHeight) + 2 * CANVAS_PAD))

/**
 * The view it opens on, at full size so its words are never below the size §9.9 asks for: from the first step, or, when
 * the current step would be past the right edge, moved just far enough to show it. Centred up and down.
 */
export function startView(place: FlowPlace, currentRight: number | null, canvas: { readonly width: number; readonly height: number }) {
  const beyond = currentRight === null ? 0 : currentRight + CANVAS_PAD - canvas.width
  return { x: beyond > 0 ? -beyond : CANVAS_PAD, y: Math.max(CANVAS_PAD, (canvas.height - place.height) / 2), zoom: 1 }
}
