import { describe, expect, it } from 'vitest'
import type { StepCardView, StepSlotView } from '@/ui/document/step-cards'
import { BOX_WIDTH, boxesOf, CANVAS_PAD, canvasHeight, linesOf, placeBoxes, startView } from '@/ui/document/step-flow-layout'

const badge = { look: { tone: 'neutral', icon: 'Hourglass' }, label: 'รอ' } as StepCardView['badge']
const step = (key: string, over: Partial<StepCardView> = {}): StepCardView => ({ key, title: `ขั้นที่ ${key}`, badge, current: false, people: [], history: [], ...over })
const slot = (key: string, kind: StepSlotView['state']['kind'] = 'waiting'): StepSlotView => ({ key, who: `คน ${key}`, state: { kind, text: kind } })
const same = () => 100

describe('[FR-INT-012/AC3] the route as a map of boxes', () => {
  it('draws a straight line of boxes for a route without slots, one column per step', () => {
    const boxes = boxesOf([step('1'), step('2'), step('3')])
    expect(boxes.map((b) => [b.id, b.column])).toEqual([
      ['step-1', 0],
      ['step-2', 1],
      ['step-3', 2],
    ])
    const place = placeBoxes(boxes, same)
    const ys = boxes.map((b) => place.positions.get(b.id)!.y)
    expect(new Set(ys).size).toBe(1)
    expect(place.positions.get('step-2')!.x - place.positions.get('step-1')!.x).toBeGreaterThan(BOX_WIDTH)
    expect(linesOf(boxes).map((l) => l.id)).toEqual(['step-1>step-2', 'step-2>step-3'])
  })

  it('fans a step of slots out to one box per slot and joins them again, like parallel work', () => {
    const boxes = boxesOf([step('1'), step('2', { slots: [slot('1'), slot('2'), slot('3')], progress: 'ผ่านแล้ว 0 ใน 3 ฝ่าย' }), step('3')], 'ออก PO')
    expect(boxes.map((b) => b.kind)).toEqual(['STEP', 'GROUP', 'SLOT', 'SLOT', 'SLOT', 'STEP', 'NEXT'])
    // The label takes no line; each slot has one in and one out, and what comes after the route closes it
    expect(linesOf(boxes).map((l) => l.id)).toEqual([
      'step-1>slot-2-1',
      'step-1>slot-2-2',
      'step-1>slot-2-3',
      'slot-2-1>step-3',
      'slot-2-2>step-3',
      'slot-2-3>step-3',
      'step-3>next',
    ])
  })

  it('keeps every column centred on one line, whatever the heights, with the label above its boxes', () => {
    const boxes = boxesOf([step('1'), step('2', { slots: [slot('1'), slot('2'), slot('3')] }), step('3')])
    const heights: Record<string, number> = { 'step-1': 200, 'group-2': 60, 'slot-2-1': 100, 'slot-2-2': 140, 'slot-2-3': 100, 'step-3': 120 }
    const place = placeBoxes(boxes, (id) => heights[id]!)
    const at = (id: string) => place.positions.get(id)!
    const centre = (id: string) => at(id).y + heights[id]! / 2
    expect(centre('step-1')).toBe(centre('step-3'))
    expect(centre('slot-2-2')).toBe(centre('step-1'))
    // Stacked in order, never overlapping, and the label ends above the first slot
    expect(at('slot-2-2').y).toBeGreaterThanOrEqual(at('slot-2-1').y + heights['slot-2-1']!)
    expect(at('slot-2-3').y).toBeGreaterThanOrEqual(at('slot-2-2').y + heights['slot-2-2']!)
    expect(at('group-2').y + heights['group-2']!).toBeLessThanOrEqual(at('slot-2-1').y)
    for (const box of boxes) expect(at(box.id).y).toBeGreaterThanOrEqual(0)
    expect(place.height).toBeGreaterThanOrEqual(at('slot-2-3').y + heights['slot-2-3']!)
  })

  it('draws a line as done only when the box it leaves was passed', () => {
    const boxes = boxesOf([
      step('1', { stampTone: 'ok' }),
      step('2', { slots: [slot('1', 'done'), slot('2', 'waiting')] }),
      step('3', { stampTone: 'danger' }),
      step('4'),
    ])
    const done = Object.fromEntries(linesOf(boxes).map((l) => [l.id, l.done]))
    expect(done['step-1>slot-2-1']).toBe(true)
    expect(done['slot-2-1>step-3']).toBe(true)
    expect(done['slot-2-2>step-3']).toBe(false)
    expect(done['step-3>step-4']).toBe(false)
  })

  it('has nothing to draw for an empty route', () => {
    const boxes = boxesOf([])
    expect(boxes).toEqual([])
    expect(linesOf(boxes)).toEqual([])
    expect(placeBoxes(boxes, same)).toMatchObject({ width: 0, height: 0 })
  })

  it('opens at full size on the first step, moved only as far as it takes to show the current one', () => {
    const place = placeBoxes(boxesOf([step('1'), step('2'), step('3'), step('4')]), same)
    const canvas = { width: 800, height: canvasHeight(place.height) }
    expect(startView(place, null, canvas)).toMatchObject({ x: CANVAS_PAD, zoom: 1 })
    expect(startView(place, 500, canvas).x).toBe(CANVAS_PAD)
    const far = startView(place, 1400, canvas)
    expect(far.x).toBe(800 - 1400 - CANVAS_PAD)
    expect(far.zoom).toBe(1)
  })

  it('makes the canvas as tall as the route within its limits', () => {
    expect(canvasHeight(100)).toBe(240)
    expect(canvasHeight(400)).toBe(400 + 2 * CANVAS_PAD)
    expect(canvasHeight(4000)).toBe(800)
  })
})
