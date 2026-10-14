# -*- coding: utf-8 -*-
"""Build docs/inputs/BCS_inputs_p1.xlsx, the synthetic phase-1 workbook (spec §16.13 · ADR-065).

Run from the repo root:   node scripts/py.mjs scripts/inputs_p1/make.py [--out <file>] [--blank]
--blank writes the same sheets with headers only: the form to collect LK-RICH's real data later (finish line B).
The output is byte-identical for identical data (fixed zip timestamps and document properties), so git shows a
change only when the data changes. Never edit the xlsx by hand: change these scripts and run this file again.
"""
import io, os, re, sys, zipfile
from datetime import date, datetime
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import openpyxl  # noqa: E402
from openpyxl.styles import Alignment, Font, PatternFill  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402

from p1_org import ORG, DEPARTMENTS, POSITIONS, USERS  # noqa: E402
from p1_master import (GL_ACCOUNTS, cost_center_rows, budget_rows, SITES, REQUEST_TYPES, HOLIDAYS, SETTINGS, DOA_POLICY,  # noqa: E402
                       DOA_RULES, WORKFLOW_REVIEWERS, BANKS, WHT_TYPES, COMPANY_BANK_ACCOUNTS)
from p1_suppliers import SUPPLIERS, SUPPLIER_PAYMENT, ITEMS  # noqa: E402
from p1_history import build, doc_samples  # noqa: E402
from p1_texts import README, INPUTS, QUESTIONS_Q, QUESTIONS_B, SCENARIOS  # noqa: E402

REAL, DEFAULT, SYNTH = 'real', 'default', 'synthetic'
FILL = {REAL: '1F3864', DEFAULT: '7F7F7F', SYNTH: 'BF8F00'}
MONEY = {'planned', 'net', 'vat', 'gross', 'unitPrice', 'refUnitPrice', 'agreedUnitPrice', 'countsAgainstBudget', 'expectedWht', 'gt', 'lte'}


def table(ws, kind, columns, rows):
    """columns: [(key, labelTh)] · rows: dicts or tuples in column order."""
    for j, (key, label) in enumerate(columns, 1):
        c = ws.cell(1, j, key)
        c.font, c.fill = Font(bold=True, color='FFFFFF'), PatternFill('solid', fgColor=FILL[kind])
        c2 = ws.cell(2, j, label)
        c2.font, c2.fill = Font(italic=True, color='404040'), PatternFill('solid', fgColor='F2F2F2')
        c2.alignment = Alignment(wrap_text=True, vertical='top')
    for i, row in enumerate(rows, 3):
        vals = [row.get(k) for k, _ in columns] if isinstance(row, dict) else list(row)
        for j, v in enumerate(vals, 1):
            if isinstance(v, Decimal):
                v = float(v) if v != v.to_integral_value() else int(v)
            if isinstance(v, str) and columns[j - 1][0] in MONEY and re.fullmatch(r'-?\d+(\.\d+)?', v):
                v = float(v) if '.' in v else int(v)
            c = ws.cell(i, j, v)
            if columns[j - 1][0] in MONEY and isinstance(v, (int, float)):
                c.number_format = '#,##0.00'
            elif isinstance(v, (date, datetime)):
                c.number_format = 'yyyy-mm-dd'
    for j, (key, label) in enumerate(columns, 1):
        width = max([len(str(key)), min(len(label), 30)] + [len(str(ws.cell(i, j).value or '')) for i in range(3, min(ws.max_row, 60) + 1)])
        ws.column_dimensions[get_column_letter(j)].width = min(max(10, width + 2), 60)
    ws.freeze_panes = 'A3'


def kv_sheet(ws, kind, rows):
    table(ws, kind, [('key', 'ชื่อค่า (ห้ามแก้)'), ('value', 'ค่า'), ('labelTh', 'ความหมาย'), ('ref', 'อ้างอิง')], rows)


def deterministic(wb, path):
    buf = io.BytesIO()
    wb.save(buf)
    src = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == 'docProps/core.xml':
                data = re.sub(rb'(<dcterms:(created|modified)[^>]*>)[^<]*(</dcterms:)', rb'\g<1>2026-10-11T00:00:00Z\g<3>', data)
            zi = zipfile.ZipInfo(info.filename, date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type, zi.external_attr = zipfile.ZIP_DEFLATED, 0o644 << 16
            z.writestr(zi, data)
    with open(path, 'wb') as f:
        f.write(out.getvalue())


def main():
    args = sys.argv[1:]
    blank = '--blank' in args
    out = args[args.index('--out') + 1] if '--out' in args else ('docs/inputs/BCS_inputs_real_template.xlsx' if blank else 'docs/inputs/BCS_inputs_p1.xlsx')
    history, _ = build()
    samples = doc_samples(history)
    dept_names = {d[0]: d[1] for d in DEPARTMENTS}
    none = (lambda rows: []) if blank else (lambda rows: rows)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'README'
    for i, (k, v) in enumerate(README, 1):
        ws.cell(i, 1, k).font = Font(bold=True, size=14 if i == 1 else 11)
        ws.cell(i, 2, v).alignment = Alignment(wrap_text=True, vertical='top')
    ws.column_dimensions['A'].width, ws.column_dimensions['B'].width = 42, 120

    sheets = []

    def sheet(name):
        s = wb.create_sheet(name)
        sheets.append(name)
        return s

    table(sheet('Inputs'), DEFAULT, [('id', 'รหัส'), ('group', 'กลุ่ม'), ('item', 'ข้อมูลที่ต้องขอ'), ('usedFor', 'ใช้ทำอะไรในระบบ'),
          ('demoValue', 'ค่าที่ใช้ตอนนี้'), ('provider', 'ขอจากใคร'), ('neededBefore', 'ต้องมีก่อน'), ('ref', 'อ้างอิง spec'),
          ('sheet', 'กรอกที่ชีต'), ('status', 'สถานะ: สังเคราะห์ · ค่าเริ่มต้น OQ · รอข้อมูล · ได้แล้ว')],
          [(f'IN-{i:02d}',) + r for i, r in enumerate(INPUTS, 1)])
    qrows = [(f'Q-{i:02d}',) + r[:6] + (None, r[6]) for i, r in enumerate(QUESTIONS_Q, 1)]
    qrows += [(f'B-{i:02d}',) + r[:6] + (None, r[6]) for i, r in enumerate(QUESTIONS_B, 1)]
    table(sheet('Questions'), DEFAULT, [('id', 'รหัส'), ('meeting', 'ประชุม A ผู้บริหาร B จัดซื้อ C บัญชีการเงิน D หน้างาน E IT HR กฎหมาย BCS ภายใน'),
          ('askWhom', 'ถามใคร'), ('question', 'คำถาม'), ('whyItMatters', 'มีผลกับอะไร'), ('demoDefault', 'ค่าที่ใช้ตอนนี้'),
          ('ref', 'อ้างอิง spec'), ('answer', 'คำตอบ (กรอกระหว่างประชุม)'), ('docsToRequest', 'เอกสารที่ขอ')], qrows)
    kv_sheet(sheet('Org'), REAL, ORG if not blank else [(k, None, l, r) for k, _, l, r in ORG])
    table(sheet('Departments'), REAL, [('code', 'รหัสแผนก'), ('nameTh', 'ชื่อแผนก'), ('parent', 'แผนกแม่ (ว่าง = ราก)'),
          ('kind', 'COMPANY DIVISION DEPARTMENT SECTION'), ('note', 'หมายเหตุ')], none(DEPARTMENTS))
    table(sheet('Positions'), REAL, [('code', 'รหัสตำแหน่ง'), ('nameTh', 'ชื่อตำแหน่ง'), ('scope', 'DEPARTMENT = ผูกกับแผนก · ORG = ผูกกับแผนกราก')], none(POSITIONS))
    table(sheet('Users'), REAL, [('code', 'รหัสผู้ใช้ (ตัวเล็ก ตัวเลข _)'), ('displayNameTh', 'ชื่อที่แสดง (สมมติ)'), ('email', 'อีเมลบริษัท'),
          ('department', 'แผนกหลัก'), ('roles', 'บทบาทคั่นด้วย , (ผู้ขอได้โดยปริยาย)'), ('positions', 'ตำแหน่ง@แผนก คั่นด้วย ;'),
          ('note', 'หมายเหตุ'), ('employeeNo', 'รหัสพนักงาน'), ('jobTitleTh', 'ตำแหน่งงาน (ไม่ใช่ตำแหน่งใน DOA)'),
          ('supervisor', 'หัวหน้าโดยตรง (รหัสผู้ใช้)')], none(USERS))
    table(sheet('DOA'), REAL, [('version', 'ฉบับ'), ('ruleCode', 'รหัสข้อ'), ('documentType', 'ประเภทเอกสาร'), ('gt', 'มากกว่า (บาท) ว่าง = ไม่มีขอบล่าง'),
          ('lte', 'ไม่เกิน (บาท) ว่าง = ไม่มีขอบบน'), ('approverKind', 'วิธีหาผู้อนุมัติ'), ('approverPosition', 'ตำแหน่ง'),
          ('approverMember', 'ผู้ใช้ (ถ้าระบุตัว)'), ('slaBusinessHours', 'SLA ชั่วโมงทำการ'), ('descriptionTh', 'คำอธิบาย')], none(DOA_RULES))
    kv_sheet(sheet('DOA_Policy'), DEFAULT, DOA_POLICY if not blank else [(k, None, l, r) for k, _, l, r in DOA_POLICY])
    table(sheet('Workflow_Reviewers'), REAL, [('ruleCode', 'รหัสข้อ'), ('requestType', 'ประเภทคำขอ'), ('conditionTh', 'เงื่อนไข'),
          ('reviewerPosition', 'ตำแหน่งผู้ตรวจ'), ('reviewerDepartment', 'ฝ่ายของผู้ตรวจ'), ('mode', 'ALL = ต้องครบ · ANY = คนใดคนหนึ่ง'),
          ('slaBusinessHours', 'SLA ชั่วโมงทำการ'), ('descriptionTh', 'คำอธิบาย (ร่าง)'), ('ref', 'FR')], none(WORKFLOW_REVIEWERS))
    table(sheet('Budget'), REAL, [('fiscalYear', 'ปีงบ'), ('code', 'รหัสบรรทัดงบ (budgetKey-ปี พ.ศ.)'), ('budgetKey', 'กุญแจงบที่ไม่มีปี (คำขอใน Request_History อ้างคอลัมน์นี้)'),
          ('nameTh', 'ชื่อ'), ('department', 'แผนกเจ้าของงบ'), ('costCenter', 'cost center'), ('accountCode', 'รหัสบัญชี'),
          ('planned', 'งบตั้งต้น (บาท ก่อน VAT)'), ('note', 'หมายเหตุ')], none(budget_rows()))
    table(sheet('CostCenters'), REAL, [('code', 'รหัส cost center'), ('nameTh', 'ชื่อ'), ('department', 'แผนกเจ้าของ')], none(cost_center_rows(dept_names)))
    table(sheet('GL_Accounts'), REAL, [('code', 'รหัสบัญชี'), ('nameTh', 'ชื่อบัญชี'), ('type', 'COST EXPENSE ASSET LIABILITY'), ('note', 'หมายเหตุ')], none(GL_ACCOUNTS))
    table(sheet('Suppliers'), REAL, [('code', 'รหัส'), ('nameTh', 'ชื่อผู้ขาย (สมมติ)'), ('taxId', 'เลขผู้เสียภาษี (ข้อความ 13 หลัก)'),
          ('branchCode', 'สาขา'), ('vatRegistered', 'จด VAT (Y/N)'), ('email', 'อีเมลรับ PO'), ('phone', 'โทร'), ('category', 'หมวด'),
          ('expressVendorCode', 'รหัสเจ้าหนี้ใน Express (OQ-10)')], none(SUPPLIERS))
    table(sheet('SupplierPayment'), REAL, [('supplierCode', 'รหัสผู้ขาย'), ('payeeType', 'JURISTIC นิติบุคคล · INDIVIDUAL บุคคลธรรมดา'),
          ('whtIncomeType', 'ประเภทเงินได้ที่หัก ณ ที่จ่าย (ชีต WHT_Types)'), ('paymentTermDays', 'เครดิต (วัน)'), ('bankCode', 'รหัสธนาคาร (ชีต Banks)'),
          ('bankBranchTh', 'สาขาธนาคาร'), ('accountNo', 'เลขบัญชี (สังเคราะห์ ขึ้นต้น 9)'), ('accountName', 'ชื่อบัญชี'),
          ('eTaxIssuer', 'ออก e-Tax: NONE EMAIL FULL'), ('registryStatus', 'สถานะทะเบียน: ACTIVE CEASED VAT_CANCELLED'), ('note', 'หมายเหตุ')], none(SUPPLIER_PAYMENT))
    table(sheet('Banks'), DEFAULT, [('code', 'รหัสธนาคาร'), ('shortName', 'ชื่อย่อ'), ('nameTh', 'ชื่อธนาคาร')], BANKS)
    table(sheet('Items'), REAL, [('code', 'รหัส'), ('nameTh', 'รายการ'), ('unit', 'หน่วย'), ('refUnitPrice', 'ราคาอ้างอิงต่อหน่วย (บาท ก่อน VAT)'),
          ('category', 'หมวดผู้ขาย'), ('isService', 'บริการ (Y/N)'), ('accountCode', 'รหัสบัญชีตั้งต้น'), ('whtIncomeType', 'ประเภทหัก ณ ที่จ่าย'),
          ('agreementSupplier', 'ผู้ขายที่มีราคาตกลง'), ('agreedUnitPrice', 'ราคาที่ตกลง'), ('agreementNote', 'หมายเหตุ')], none(ITEMS))
    table(sheet('Sites'), REAL, [('code', 'รหัส'), ('nameTh', 'ชื่อสถานที่ส่ง'), ('address', 'ที่อยู่ (สมมติ)')], none(SITES))
    table(sheet('RequestTypes'), REAL, [('code', 'รหัส (ต้องมีฟอร์มใน prisma/seed/forms.yaml)'), ('nameTh', 'ชื่อบนการ์ด'), ('documentType', 'ชนิดเอกสาร'),
          ('descriptionTh', 'ใช้เมื่อไร'), ('keyFields', 'ฟิลด์สำคัญ'), ('attachmentRule', 'กฎเอกสารแนบ'), ('active', 'ใช้งาน (Y/N)'),
          ('defaultRetentionBp', 'เงินประกันผลงานต่อใบ (basis point · 500 = 5% · S8)'), ('defaultRetentionHoldDays', 'ถือเงินประกันกี่วันหลังตรวจรับงวดสุดท้าย')], none(REQUEST_TYPES))
    table(sheet('Holidays'), REAL, [('date', 'วันที่'), ('nameTh', 'ชื่อวันหยุด'), ('source', 'ที่มา')], none(HOLIDAYS))
    kv_sheet(sheet('Settings'), DEFAULT, SETTINGS)
    table(sheet('WHT_Types'), DEFAULT, [('code', 'รหัส'), ('nameTh', 'ประเภทเงินได้'), ('rateBp', 'อัตรา (basis point · 300 = 3%)'),
          ('form', 'แบบ: PND3_53 = ภ.ง.ด.3 หรือ 53 ตามผู้รับ · PND53'), ('legalRefTh', 'อ้างอิง'), ('note', 'หมายเหตุ (รอผู้ทำบัญชีของลูกค้ายืนยัน BR-WHT-01)')], WHT_TYPES)
    table(sheet('CompanyBankAccounts'), REAL, [('code', 'รหัส'), ('bankCode', 'รหัสธนาคาร'), ('branchTh', 'สาขา'), ('accountType', 'CURRENT SAVINGS'),
          ('accountNo', 'เลขบัญชี (สังเคราะห์)'), ('purposeTh', 'ใช้ทำอะไร'), ('fileFormat', 'รูปแบบไฟล์จ่ายเงิน')], none(COMPANY_BANK_ACCOUNTS))
    hist_cols = [('ref', 'รหัส'), ('daysAgo', 'กี่วันก่อนวัน seed'), ('requester', 'ผู้ขอ'), ('chargedDept', 'แผนกเจ้าของงบ'), ('requestType', 'ประเภท'),
                 ('title', 'เรื่อง (ไม่ซ้ำ)'), ('site', 'สถานที่ส่ง'), ('supplier', 'ผู้ขาย'), ('budgetKey', 'กุญแจงบ (seed เลือกปีงบตามวันที่)'),
                 ('itemCode', 'รายการ (ชีต Items)'), ('qty', 'จำนวน'), ('unit', 'หน่วย'), ('unitPrice', 'ราคาต่อหน่วย ก่อน VAT'),
                 ('net', 'ยอดก่อน VAT (บาทเต็ม)'), ('vat', 'VAT (half-up ระดับเอกสาร)'), ('gross', 'รวม VAT'), ('status', 'สถานะ'),
                 ('countsAgainstBudget', 'นับเข้างบ'), ('expectedRule', 'ข้อ DOA ที่คาด'), ('expectedApprover', 'ผู้อนุมัติที่คาด'),
                 ('escalated', 'ยกระดับ (Y/N)'), ('hours', 'ชั่วโมงทำการที่ใช้ตัดสิน หรือที่รอแล้ว'), ('channel', 'ช่องทางที่ตัดสิน'),
                 ('serviceEndInDays', 'บริการหมดอายุในกี่วัน (ขอซ้ำ)'), ('form', 'คำตอบในฟอร์ม (JSON ตาม forms.yaml)'),
                 ('invoiceScenario', 'ใบแจ้งหนี้ (S8): MATCH PRICE_WITHIN_TOL PRICE_OVER QTY_OVER DUPLICATE SERVICE_2WAY MISSING'),
                 ('invoiceNo', 'เลขที่ใบแจ้งหนี้ของผู้ขาย'), ('invoiceDaysAfterGr', 'ใบแจ้งหนี้มาหลังตรวจรับกี่วัน'),
                 ('whtIncomeType', 'ประเภทหัก ณ ที่จ่าย'), ('paymentStatus', 'การจ่าย (S9): PAID DUE OVERDUE NOT_DUE'),
                 ('pattern', 'สถานการณ์ทดสอบ (ชีต Scenarios)'), ('note', 'หมายเหตุ')]
    table(sheet('Request_History'), SYNTH, hist_cols, none(history))
    table(sheet('DocSamples'), SYNTH, [('sampleId', 'รหัส'), ('docType', 'QUOTATION DELIVERY_NOTE TAX_INVOICE ETAX_XML'), ('historyRef', 'คำขอใน Request_History'),
          ('supplierCode', 'ผู้ขาย'), ('sellerNameTh', 'ชื่อผู้ขายบนเอกสาร'), ('sellerTaxId', 'เลขผู้เสียภาษีผู้ขาย'), ('sellerBranch', 'สาขาผู้ขาย'),
          ('buyerTaxId', 'เลขผู้เสียภาษีผู้ซื้อ'), ('docNo', 'เลขที่เอกสาร'), ('docDaysAgo', 'วันที่เอกสาร (กี่วันก่อน)'),
          ('priceIncludesVat', 'ราคารวม VAT (Y/N)'), ('linesJson', 'รายการ (JSON)'), ('net', 'ยอดก่อน VAT'), ('vat', 'VAT'), ('gross', 'รวม'),
          ('expectedWhtBp', 'อัตราหัก ณ ที่จ่ายที่คาด'), ('expectedWht', 'ภาษีหัก ณ ที่จ่ายที่คาด'), ('layout', 'รูปแบบไฟล์ที่ต้องสร้าง'),
          ('quality', 'คุณภาพภาพ'), ('language', 'ภาษา'), ('notes', 'จุดที่ AI ต้องระวัง')], none(samples))
    table(sheet('Scenarios'), SYNTH, [('id', 'รหัส'), ('area', 'เรื่อง'), ('descriptionTh', 'สถานการณ์'), ('where', 'อยู่ตรงไหนในข้อมูล'), ('usedBy', 'ใช้ทดสอบ')],
          none([(f'SC-{i:02d}',) + s for i, s in enumerate(SCENARIOS, 1)]))
    deterministic(wb, out)

    if not blank:
        st = {}
        for h in history:
            st[h['status']] = st.get(h['status'], 0) + 1
        print(f'เขียน {out}')
        print(f'  ผู้ใช้ {len(USERS)} · หน่วยงาน {len(DEPARTMENTS)} · ผู้ขาย {len(SUPPLIERS)} · รายการสินค้า {len(ITEMS)} · บรรทัดงบ {len(budget_rows())}')
        print(f'  ประวัติ {len(history)} คำขอ ({", ".join(f"{k} {v}" for k, v in sorted(st.items()))}) · เอกสาร AI {len(samples)} ฉบับ')
    else:
        print(f'เขียนแบบฟอร์มว่าง {out}')


if __name__ == '__main__':
    main()
