// The in-app notices of S10 (lane 2's own file · docs/sub-specs/S10.md "การแจ้งเตือน" · BR-NOTI-11): a supplier asked a
// question about an RFx (IMMEDIATE to its creator). Never the question's words: they are the supplier's text.

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
}
