import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { ComponentProps } from 'react'
import { PDF_KEEP_WITH_TOTALS_PT } from '@/lib/constants'
import type { PrintableDocument } from './printable'

// The printed PR and PO page (spec FR-PLT-009 AC1 AC2; OQ-25 default: approvals as data, no signatures; ADR-044).
// Plain A4 in Sarabun (§9.9): black text, grey labels, thin rules, one light-grey header row — no colour, no images.
// Lines never split across pages and the table header repeats; the totals, the amount in words, the approvals and the
// note stay together after the last line; pages after the first carry a running header; every page has the footer
// and "หน้า x/y". Thai labels with small English, as on Thai business documents.

type ViewStyle = ComponentProps<typeof View>['style']

export const FONT_FAMILY = 'Sarabun'

const INK = '#111111'
const MUTED = '#555555'
const RULE = '#9A9A9A'
const HAIR = '#C8C8C8'
const HEAD_BG = '#EDEDED'

const s = StyleSheet.create({
  // lineHeight sits on the body View, not the Page: react-pdf drops fixed nodes holding a render() Text when they
  // inherit one. A unitless lineHeight turns into points with the fontSize of the same style, so both are declared.
  page: { fontFamily: FONT_FAMILY, fontSize: 10, color: INK, paddingTop: 40, paddingBottom: 54, paddingHorizontal: 40 },
  body: { fontSize: 10, lineHeight: 1.45 },
  running: { position: 'absolute', top: 18, left: 40, right: 40, fontSize: 8.5, color: MUTED },
  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 4, fontSize: 8.5, color: MUTED },

  head: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 8, marginBottom: 10 },
  org: { flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingRight: 16 },
  orgName: { fontSize: 13, fontWeight: 'bold', lineHeight: 1.4 },
  orgLine: { fontSize: 9, color: '#333333', lineHeight: 1.45 },
  titleBox: { width: 170, alignItems: 'flex-end' },
  titleTh: { fontSize: 18, fontWeight: 'bold', lineHeight: 1.3 },
  titleEn: { fontSize: 10.5, color: MUTED },

  info: { flexDirection: 'row', marginBottom: 12 },
  // Text in a flex row is measured at its full width unless the box may shrink to 0 first (flexBasis 0)
  party: { flexGrow: 1, flexShrink: 1, flexBasis: 0, borderWidth: 0.5, borderColor: RULE, padding: 8, marginRight: 10 },
  partyName: { fontWeight: 'bold' },
  partyLine: { fontSize: 9.5 },
  docBox: { width: 245, borderWidth: 0.5, borderColor: RULE, paddingVertical: 6, paddingHorizontal: 8 },
  kv: { flexDirection: 'row' },
  kvLabel: { width: 92, fontSize: 9, color: MUTED, paddingTop: 0.8 },
  kvValue: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  kvStrong: { flexGrow: 1, flexShrink: 1, flexBasis: 0, fontWeight: 'bold' },
  label: { fontSize: 9, color: MUTED },
  en: { fontSize: 7.5, color: MUTED, fontWeight: 'normal' },

  table: { borderTopWidth: 0.75, borderTopColor: INK },
  th: { flexDirection: 'row', backgroundColor: HEAD_BG, borderBottomWidth: 0.75, borderBottomColor: INK },
  thCell: { paddingVertical: 3, paddingHorizontal: 4, fontSize: 9, fontWeight: 'bold', lineHeight: 1.25 },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: HAIR },
  td: { paddingVertical: 3.5, paddingHorizontal: 4, fontSize: 9.5 },
  cNo: { width: 30, textAlign: 'center' },
  cDesc: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  cQty: { width: 54, textAlign: 'right' },
  cUom: { width: 42, textAlign: 'center' },
  cPrice: { width: 70, textAlign: 'right' },
  cAmt: { width: 80, textAlign: 'right' },

  sumRow: { flexDirection: 'row', borderTopWidth: 0.75, borderTopColor: INK },
  words: { flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingTop: 6, paddingRight: 12 },
  wordsText: { fontWeight: 'bold', fontSize: 10.5 },
  totals: { width: 246 },
  totRow: { flexDirection: 'row', paddingVertical: 2.5, paddingHorizontal: 4 },
  totLabel: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  totValue: { width: 80, textAlign: 'right' },
  grand: { borderTopWidth: 0.75, borderTopColor: INK, borderBottomWidth: 2, borderBottomColor: INK, borderBottomStyle: 'solid', fontWeight: 'bold' },

  section: { marginTop: 16 },
  sectionTitle: { fontSize: 11, fontWeight: 'bold', marginBottom: 4 },
  aTh: { flexDirection: 'row', backgroundColor: HEAD_BG, borderTopWidth: 0.75, borderTopColor: INK, borderBottomWidth: 0.5, borderBottomColor: INK },
  aTr: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: HAIR },
  aNo: { width: 30, textAlign: 'center' },
  aName: { width: 122 },
  aPos: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  aAt: { width: 92 },
  aCh: { width: 58 },
  aRef: { width: 92 },
  none: { paddingVertical: 4, paddingHorizontal: 4, fontSize: 9.5, color: MUTED },
  note: { marginTop: 12, fontSize: 9.5 },
  noteLabel: { fontWeight: 'bold' },
})

function Kv({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={strong ? s.kvStrong : s.kvValue}>{value}</Text>
    </View>
  )
}

function HeadCell({ th, en, style }: { th: string; en: string; style: ViewStyle }) {
  return (
    <View style={[s.thCell, style] as ViewStyle}>
      <Text>{th}</Text>
      <Text style={s.en}>{en}</Text>
    </View>
  )
}

export function PrintablePdf({ doc }: { doc: PrintableDocument }) {
  const o = doc.organization
  const last = doc.lines.length - 1
  return (
    <Document title={`${doc.titleTh} ${doc.number}`} subject={doc.titleEn} author={o.name} creator="BCS" producer="BCS" language="th-TH">
      <Page size="A4" style={s.page}>
        <Text fixed style={s.running} render={({ pageNumber }) => (pageNumber > 1 ? `${doc.titleTh} ${doc.titleEn} · ${doc.number} (ต่อ)` : '')} />

        <View style={s.body}>
          <View style={s.head}>
            <View style={s.org}>
              <Text style={s.orgName}>{o.name}</Text>
              {o.address ? <Text style={s.orgLine}>{o.address}</Text> : null}
              <Text style={s.orgLine}>{o.taxLine}</Text>
            </View>
            <View style={s.titleBox}>
              <Text style={s.titleTh}>{doc.titleTh}</Text>
              <Text style={s.titleEn}>{doc.titleEn}</Text>
            </View>
          </View>

          <View style={s.info}>
            <View style={s.party}>
              <Text style={s.label}>{doc.counterparty.label}</Text>
              <Text style={s.partyName}>{doc.counterparty.name}</Text>
              {doc.counterparty.lines.map((line, i) => (
                <Text key={i} style={s.partyLine}>
                  {line}
                </Text>
              ))}
            </View>
            <View style={s.docBox}>
              <Kv label="เลขที่เอกสาร" value={doc.number} strong />
              <Kv label="วันที่" value={doc.dateText} />
              {doc.meta.map((m, i) => (
                <Kv key={i} label={m.label} value={m.value} />
              ))}
            </View>
          </View>

          <View style={s.table}>
            <View style={s.th} fixed>
              <HeadCell th="ลำดับ" en="No." style={s.cNo} />
              <HeadCell th="รายการ" en="Description" style={s.cDesc} />
              <HeadCell th="จำนวน" en="Qty" style={s.cQty} />
              <HeadCell th="หน่วย" en="Unit" style={s.cUom} />
              <HeadCell th="ราคาต่อหน่วย" en="Unit price" style={s.cPrice} />
              <HeadCell th={doc.amountHeader} en="Amount" style={s.cAmt} />
            </View>
            {doc.lines.map((l, i) => (
              // A row never splits; the last row stays with the totals block
              <View key={l.no} style={s.tr} wrap={false} {...(i === last ? { minPresenceAhead: PDF_KEEP_WITH_TOTALS_PT } : {})}>
                <Text style={[s.td, s.cNo]}>{l.no}</Text>
                <Text style={[s.td, s.cDesc]}>{l.description}</Text>
                <Text style={[s.td, s.cQty]}>{l.quantity}</Text>
                <Text style={[s.td, s.cUom]}>{l.uom}</Text>
                <Text style={[s.td, s.cPrice]}>{l.unitPrice}</Text>
                <Text style={[s.td, s.cAmt]}>{l.amount}</Text>
              </View>
            ))}

            <View wrap={false}>
              <View style={s.sumRow}>
                <View style={s.words}>
                  <Text style={s.label}>
                    จำนวนเงินรวมทั้งสิ้น (ตัวอักษร) <Text style={s.en}>Total amount in words</Text>
                  </Text>
                  <Text style={s.wordsText}>({doc.totals.grossText})</Text>
                </View>
                <View style={s.totals}>
                  <View style={s.totRow}>
                    <Text style={s.totLabel}>
                      รวมเงินก่อนภาษีมูลค่าเพิ่ม <Text style={s.en}>Before VAT</Text>
                    </Text>
                    <Text style={s.totValue}>{doc.totals.net}</Text>
                  </View>
                  <View style={s.totRow}>
                    <Text style={s.totLabel}>
                      {doc.totals.vatLabel} <Text style={s.en}>VAT</Text>
                    </Text>
                    <Text style={s.totValue}>{doc.totals.vat}</Text>
                  </View>
                  <View style={[s.totRow, s.grand]}>
                    <Text style={s.totLabel}>
                      รวมทั้งสิ้น <Text style={s.en}>Total</Text>
                    </Text>
                    <Text style={s.totValue}>{doc.totals.gross}</Text>
                  </View>
                </View>
              </View>

              <View style={s.section}>
                <Text style={s.sectionTitle}>
                  การอนุมัติ <Text style={s.en}>Approvals</Text>
                </Text>
                <View style={s.aTh}>
                  <HeadCell th="ลำดับ" en="No." style={s.aNo} />
                  <HeadCell th="ผู้อนุมัติ" en="Approver" style={s.aName} />
                  <HeadCell th="ตำแหน่ง" en="Position" style={s.aPos} />
                  <HeadCell th="วันที่และเวลา" en="Date and time" style={s.aAt} />
                  <HeadCell th="ช่องทาง" en="Channel" style={s.aCh} />
                  <HeadCell th="อ้างอิงอำนาจอนุมัติ" en="DOA reference" style={s.aRef} />
                </View>
                {doc.approvals.length === 0 ? <Text style={s.none}>ยังไม่มีการอนุมัติ · Not approved yet</Text> : null}
                {doc.approvals.map((a, i) => (
                  <View key={i} style={s.aTr} wrap={false}>
                    <Text style={[s.td, s.aNo]}>{i + 1}</Text>
                    <Text style={[s.td, s.aName]}>{a.name}</Text>
                    <Text style={[s.td, s.aPos]}>{a.position}</Text>
                    <Text style={[s.td, s.aAt]}>{a.atText}</Text>
                    <Text style={[s.td, s.aCh]}>{a.channel}</Text>
                    <Text style={[s.td, s.aRef]}>{a.doaRef}</Text>
                  </View>
                ))}
              </View>

              {doc.note ? (
                <Text style={s.note}>
                  <Text style={s.noteLabel}>หมายเหตุ </Text>
                  {doc.note}
                </Text>
              ) : null}
            </View>
          </View>
        </View>

        <View style={s.footer} fixed>
          <Text>{doc.footer}</Text>
          <Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
