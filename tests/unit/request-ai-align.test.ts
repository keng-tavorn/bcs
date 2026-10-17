import { describe, expect, it } from 'vitest'
import { alignRequestLines } from '@/server/services/requests/ai-assist'

// BR-AI-16, BR-AI-17 (ADR-073 pre-review): the paths of a request's lines name their place, so a line removed or added
// above moved the values the AI put in, and the contract read them as changed by the person — confirmed without being
// looked at. alignRequestLines puts the values read back under the paths the AI proposed them at.

const line = (i: number, description: string, quantity: string, unitPrice: string) => ({
  [`lines.${i}.description`]: description,
  [`lines.${i}.quantity`]: quantity,
  [`lines.${i}.uom`]: 'ชิ้น',
  [`lines.${i}.unitPrice`]: unitPrice,
})
const proposed = { title: 'ของใช้ไซต์', ...line(0, 'ปูน', '10', '120.00'), ...line(1, 'เหล็ก 12 มม.', '50', '2500.00') }

describe('[BR-AI-16] a request line the AI proposed is compared where it is now', () => {
  it('the line above removed: the second line\'s values are read back at their own paths and still equal what the AI put in', () => {
    const current = { title: 'ของใช้ไซต์', ...line(0, 'เหล็ก 12 มม.', '50', '2500.00') }
    const aligned = alignRequestLines(proposed, current)
    expect(aligned).toMatchObject({ title: 'ของใช้ไซต์', 'lines.1.quantity': '50', 'lines.1.unitPrice': '2500.00' })
    expect(Object.keys(aligned).filter((k) => k.startsWith('lines.0.'))).toEqual([])
  })

  it('a line added above: both proposed lines are found below it', () => {
    const current = { ...line(0, 'ทรายถม', '3', '800.00'), ...line(1, 'ปูน', '10', '120.00'), ...line(2, 'เหล็ก 12 มม.', '50', '2500.00') }
    const aligned = alignRequestLines(proposed, current)
    expect(aligned).toMatchObject({ 'lines.0.description': 'ปูน', 'lines.0.quantity': '10', 'lines.1.description': 'เหล็ก 12 มม.', 'lines.1.unitPrice': '2500.00' })
  })

  it('only the description changed: the line keeps its place, so its quantity and price still wait; a line edited in place reads as edited', () => {
    const current = { ...line(0, 'ปูนซีเมนต์ ตราช้าง', '10', '120.00'), ...line(1, 'เหล็ก 12 มม.', '60', '2500.00') }
    const aligned = alignRequestLines(proposed, current)
    expect(aligned).toMatchObject({ 'lines.0.description': 'ปูนซีเมนต์ ตราช้าง', 'lines.0.quantity': '10', 'lines.0.unitPrice': '120.00', 'lines.1.quantity': '60' })
  })

  it('two proposed lines with one description each find their own line', () => {
    const twice = { ...line(0, 'ปูน', '10', '120.00'), ...line(1, 'ปูน', '5', '125.00') }
    const current = { ...line(0, 'ปูน', '5', '125.00') }
    // the person removed the first: the second, still as proposed, is found at place 0; the first has no place left
    const aligned = alignRequestLines(twice, current)
    expect(aligned).toMatchObject({ 'lines.1.quantity': '5', 'lines.1.unitPrice': '125.00' })
    expect(Object.keys(aligned).filter((k) => k.startsWith('lines.0.'))).toEqual([])
  })
})
