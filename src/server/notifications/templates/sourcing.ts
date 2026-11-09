// The in-app notices of S10 (lane 2's own file · docs/sub-specs/S10.md "การแจ้งเตือน" · BR-NOTI-11): a supplier asked a
// question about an RFx (IMMEDIATE to its creator) · S10-08: the RFx closed (its creator and evaluators) and its scores
// revealed (its creator) · S10-10: an award returned or rejected (its submitter). Never the question's words, a price or a
// score.

type Data = Readonly<Record<string, unknown>>
type Text = { readonly th: string; readonly en: string }
type Template = (data: Data, subject: { readonly type: string | null; readonly id: string | null }) => { title: Text; body?: Text; href: string | null }

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const ref = (d: Data) => str(d.number) || str(d.title)

export const SOURCING_TEMPLATES: Readonly<Record<string, Template>> = {
  'rfx.question_asked': (d) => ({
    title: { th: `ผู้ขายถามคำถามใน ${ref(d)} รอตอบ`, en: `A supplier asked a question about ${ref(d)}` },
    href: `/sourcing/${str(d.rfxEventId)}?tab=questions`,
  }),
  // S10-08: the RFx closed — its creator and its evaluators (who score now; an evaluator added after the close gets it too)
  'rfx.closed_internal': (d) => ({
    title: { th: `${ref(d)} ปิดรับข้อเสนอแล้ว`, en: `${ref(d)} closed for bids` },
    body: d.score ? { th: 'ให้คะแนนข้อเสนอได้แล้ว', en: 'You can score the bids now' } : undefined,
    href: d.score ? `/sourcing/${str(d.rfxEventId)}/score` : `/sourcing/${str(d.rfxEventId)}`,
  }),
  // S10-08: every evaluator sent their scores and the ranking is revealed (PROCUREMENT, the RFx's creator)
  'rfx.scored': (d) => ({
    title: { th: `เปิดเผยคะแนนของ ${ref(d)} แล้ว`, en: `The scores of ${ref(d)} are revealed` },
    href: `/sourcing/${str(d.rfxEventId)}/score`,
  }),
  // S10-10: the award came back from its approver — returned for changes or rejected (its submitter · IMMEDIATE)
  'award.decided': (d) => ({
    title:
      d.outcome === 'REJECTED'
        ? { th: `ผลมอบงาน ${ref(d)} ไม่ได้รับอนุมัติ`, en: `The award ${ref(d)} was rejected` }
        : { th: `ผลมอบงาน ${ref(d)} ถูกตีกลับให้แก้`, en: `The award ${ref(d)} was returned for changes` },
    href: `/sourcing/${str(d.rfxEventId)}/award`,
  }),
}
