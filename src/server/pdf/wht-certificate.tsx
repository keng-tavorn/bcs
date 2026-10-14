import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import { FONT_FAMILY } from './document'

// The printed 50 ทวิ (หนังสือรับรองการหักภาษี ณ ที่จ่าย, BR-WHT-07, OQ-123): one per payment item of S9 — the payer, the
// payee (name, tax id, branch, address), the return it goes on and its order, each income type with the date paid,
// the amount paid and the tax withheld, the totals in figures and words, and the condition "หัก ณ ที่จ่าย". Plain A4 in
// Sarabun like the PR and PO page (./document.tsx). Phase 1 is the demo layer: the page says the layout waits for the
// customer's accountant, not the Revenue Department's form. Everything is formatted by the caller.

export interface WhtCertificateDocument {
  readonly number: string
  readonly payer: { readonly name: string; readonly taxId: string; readonly branch: string; readonly address: string }
  readonly payee: { readonly name: string; readonly taxId: string; readonly branch: string; readonly address: string }
  /** "ภ.ง.ด.3" or "ภ.ง.ด.53" */
  readonly formText: string
  readonly orderInForm: number
  readonly rows: ReadonlyArray<{ readonly incomeType: string; readonly paidOnText: string; readonly paid: string; readonly tax: string }>
  readonly totals: { readonly paid: string; readonly tax: string; readonly taxText: string }
  readonly issuedText: string
}

const INK = '#111111'
const MUTED = '#555555'
const RULE = '#9A9A9A'
const HEAD_BG = '#EDEDED'

const s = StyleSheet.create({
  page: { fontFamily: FONT_FAMILY, fontSize: 10, color: INK, paddingTop: 40, paddingBottom: 54, paddingHorizontal: 40 },
  body: { fontSize: 10, lineHeight: 1.45 },
  title: { fontSize: 16, fontWeight: 'bold', textAlign: 'center', lineHeight: 1.3 },
  subtitle: { fontSize: 10, color: MUTED, textAlign: 'center', marginBottom: 6 },
  banner: { borderWidth: 0.75, borderColor: INK, padding: 4, marginBottom: 10, textAlign: 'center', fontSize: 9.5, fontWeight: 'bold' },
  meta: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8, fontSize: 9.5 },
  party: { borderWidth: 0.5, borderColor: RULE, padding: 8, marginBottom: 8 },
  label: { fontSize: 9, color: MUTED },
  name: { fontWeight: 'bold' },
  line: { fontSize: 9.5 },
  table: { borderTopWidth: 0.75, borderTopColor: INK, marginTop: 4 },
  th: { flexDirection: 'row', backgroundColor: HEAD_BG, borderBottomWidth: 0.75, borderBottomColor: INK },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: RULE },
  cell: { paddingVertical: 3, paddingHorizontal: 4, fontSize: 9.5 },
  head: { fontWeight: 'bold', fontSize: 9 },
  cType: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  cDate: { width: 90, textAlign: 'center' },
  cMoney: { width: 95, textAlign: 'right' },
  total: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: INK, fontWeight: 'bold' },
  words: { marginTop: 6, fontSize: 9.5 },
  condition: { marginTop: 10, fontSize: 9.5 },
  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 4, fontSize: 8.5, color: MUTED },
})

function Party({ label, party }: { label: string; party: WhtCertificateDocument['payer'] }) {
  return (
    <View style={s.party}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.name}>{party.name}</Text>
      <Text style={s.line}>
        เลขประจำตัวผู้เสียภาษีอากร {party.taxId} · {party.branch}
      </Text>
      {party.address ? <Text style={s.line}>{party.address}</Text> : null}
    </View>
  )
}

export function WhtCertificatePdf({ doc }: { doc: WhtCertificateDocument }) {
  return (
    <Document title={`หนังสือรับรองการหักภาษี ณ ที่จ่าย ${doc.number}`} author={doc.payer.name} creator="BCS" producer="BCS" language="th-TH">
      <Page size="A4" style={s.page}>
        <View style={s.body}>
          <Text style={s.title}>หนังสือรับรองการหักภาษี ณ ที่จ่าย</Text>
          <Text style={s.subtitle}>ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร · Withholding tax certificate</Text>
          <Text style={s.banner}>รูปแบบรอผู้ทำบัญชีตรวจ · ไม่ใช่แบบฟอร์มของกรมสรรพากร</Text>
          <View style={s.meta}>
            <Text>เลขที่ {doc.number}</Text>
            <Text>
              {doc.formText} ลำดับที่ {doc.orderInForm}
            </Text>
          </View>
          <Party label="ผู้มีหน้าที่หักภาษี ณ ที่จ่าย (ผู้จ่ายเงิน)" party={doc.payer} />
          <Party label="ผู้ถูกหักภาษี ณ ที่จ่าย (ผู้รับเงิน)" party={doc.payee} />
          <View style={s.table}>
            <View style={s.th}>
              <Text style={[s.cell, s.head, s.cType]}>ประเภทเงินได้</Text>
              <Text style={[s.cell, s.head, s.cDate]}>วันที่จ่าย</Text>
              <Text style={[s.cell, s.head, s.cMoney]}>จำนวนเงินที่จ่าย</Text>
              <Text style={[s.cell, s.head, s.cMoney]}>ภาษีที่หักและนำส่งไว้</Text>
            </View>
            {doc.rows.map((r, i) => (
              <View key={i} style={s.tr} wrap={false}>
                <Text style={[s.cell, s.cType]}>{r.incomeType}</Text>
                <Text style={[s.cell, s.cDate]}>{r.paidOnText}</Text>
                <Text style={[s.cell, s.cMoney]}>{r.paid}</Text>
                <Text style={[s.cell, s.cMoney]}>{r.tax}</Text>
              </View>
            ))}
            <View style={s.total}>
              <Text style={[s.cell, s.cType]}>รวม</Text>
              <Text style={[s.cell, s.cDate]} />
              <Text style={[s.cell, s.cMoney]}>{doc.totals.paid}</Text>
              <Text style={[s.cell, s.cMoney]}>{doc.totals.tax}</Text>
            </View>
          </View>
          <Text style={s.words}>รวมเงินภาษีที่หักนำส่ง (ตัวอักษร) ({doc.totals.taxText})</Text>
          <Text style={s.condition}>ผู้จ่ายเงิน: หัก ณ ที่จ่าย</Text>
        </View>
        <Text style={s.footer} fixed>
          ออกโดย BCS {doc.issuedText}
        </Text>
      </Page>
    </Document>
  )
}
