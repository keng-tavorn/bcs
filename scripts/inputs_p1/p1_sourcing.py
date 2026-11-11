# -*- coding: utf-8 -*-
"""Sourcing of phase 2 in the synthetic workbook (S10-14 · docs/sub-specs/S10.md "การอ่านชีตของไฟล์ระยะ 1").

Sheets RFx_Suppliers (the one foreign supplier S7 does not have, played through S7's application commands), RFx_Scenarios
(four RFx the seed plays with the real commands back in time, in the order they open, so their numbers come out
RFX-<BE>-00001 to 00004), RFx_Bids and RFx_Scores (the bids and the evaluators' scores of each), and the rows of S10 in
the shared sheet Demo_Script_P2 (demo_p2_rows · scenes 9 to 15).

Times are business days back from the day of the seed, not the fixed dates of the sub-spec (2026-10-05 … 2026-11-02),
for the reason S7's documents are relative: the RFQ of scene 9 has to be OPEN when the demo plays it, whatever day the
seed runs. An RFx opens openBusinessDaysAgo business days before the seed's business day at openTime; its close, its
decision and each bid are counted in business days after that opening, so the business days of each step (the earliest
close BR-RFX-07, the cycle of G-8 BR-RFX-15) are the same on any day, holidays or not. Every company and person is
invented; e-mails at @supplier.simec.local.
"""
import json

# ---------- RFx_Suppliers: the foreign supplier of scene 13 (S7 has none · FR-INT-201) ----------

RFX_SUPPLIER_COLUMNS = [
    ('ref', 'รหัสแถว (ใช้ในคอลัมน์ invitedSuppliers และ supplier)'), ('nameEn', 'ชื่ออังกฤษ (สมมติ)'), ('nameTh', 'ชื่อไทย (ถ้ามี)'),
    ('country', 'ประเทศ (ISO 3166 สองตัว)'), ('payeeType', 'FOREIGN'), ('taxId', 'เลขผู้เสียภาษีไทย (ว่าง · ผู้ขายต่างชาติ)'),
    ('category', 'หมวด'), ('contactName', 'ผู้ติดต่อ'), ('contactEmail', 'อีเมลผู้ติดต่อ (ไม่ซ้ำ)'), ('contactLocale', 'ภาษาของผู้ติดต่อ (en)'),
    ('invitedBy', 'ผู้เชิญ (PROCUREMENT)'), ('routedBy', 'ผู้ส่งเข้าเส้นทาง'), ('verifiedBy', 'ผู้ยืนยันเอกสาร'),
    ('invitedDaysAgo', 'เชิญกี่วันก่อนวัน seed (10:00 ของวันทำการนั้นหรือถัดไป)'),
    ('expectedApprover', 'ผู้อนุมัติที่คาด (ข้อ SA-01)'), ('expectedG7Days', 'วันทำการจากเชิญถึงอนุมัติ (ทศนิยม 1 ตำแหน่ง)'),
]

RFX_SUPPLIERS = [
    # approved more than 90 days before the seed, so the G-7 report of S7 (the last 90 days by default, scene 7) keeps its
    # median; long before the RFP opens
    {'ref': 'SA-FOREIGN-01', 'nameEn': 'Nordic Firewall AS', 'nameTh': 'นอร์ดิก ไฟร์วอลล์ เอเอส', 'country': 'NO', 'payeeType': 'FOREIGN', 'taxId': None,
     'category': 'ไอทีและซอฟต์แวร์', 'contactName': 'Ingrid Solberg', 'contactEmail': 'nordic@supplier.simec.local', 'contactLocale': 'en',
     'invitedBy': 'proc_officer', 'routedBy': 'proc_mat2', 'verifiedBy': 'proc_mat2', 'invitedDaysAgo': 100, 'expectedApprover': 'dm_proc', 'expectedG7Days': 2.0},
]

# ---------- RFx_Scenarios ----------

RFX_SCENARIO_COLUMNS = [
    ('ref', 'รหัสอ้างอิงในชีต (เลขเอกสารจริงออกตอนเปิด)'), ('expectedNumber', 'เลขที่คาดเมื่อ seed เล่นเรียงตามวันเปิด (ปี พ.ศ. ตามวันเปิดจริง)'),
    ('kind', 'RFQ RFP RFI'), ('title', 'ชื่อเรื่อง'), ('titleEn', 'ชื่ออังกฤษ (ว่าง = ไทยอย่างเดียว)'), ('description', 'รายละเอียด'),
    ('categoryCode', 'หมวดสินค้า (ชีต Items)'), ('sourceKind', 'REQUEST_LINES = บรรทัดคำขอในกอง · NEED = ความต้องการที่ยังไม่มีคำขอ'),
    ('historyRefs', 'คำขอใน Request_History คั่นด้วย ; (REQUEST_LINES)'),
    ('needLines', 'บรรทัดของ NEED (JSON: description descriptionEn catalogItemCode quantity uom uomEn refUnitPrice)'),
    ('creator', 'ผู้สร้าง (PROCUREMENT)'), ('evaluators', 'ผู้ประเมิน คั่นด้วย ; (ว่าง = ราคาอย่างเดียว)'),
    ('weightsJson', 'เกณฑ์และน้ำหนัก (JSON: code nameTh weightBp · PRICE คิดจากราคา)'),
    ('invitedSuppliers', 'ผู้ขายที่เชิญ คั่นด้วย ; (ชีต Suppliers หรือ RFx_Suppliers)'),
    ('openBusinessDaysAgo', 'เปิดกี่วันทำการก่อนวัน seed'), ('openTime', 'เวลาเปิด'),
    ('closeAfterBusinessDays', 'ปิดรับหลังเปิดกี่วันทำการ'), ('closeTime', 'เวลาปิดรับ'),
    ('questionsJson', 'คำถามและคำตอบระหว่างเปิด (JSON: supplier afterBusinessDays question answer)'),
    ('awardAfterBusinessDays', 'ส่งผลมอบงานหลังเปิดกี่วันทำการ'), ('awardTime', 'เวลาส่งผล'),
    ('decideAfterBusinessDays', 'อนุมัติผล (หรือสรุป RFI) หลังเปิดกี่วันทำการ'), ('decideTime', 'เวลาอนุมัติ'),
    ('awardReason', 'เหตุผลของผลมอบงาน (เมื่อไม่ใช่ราคาต่ำสุด)'), ('conclusionNote', 'สรุปของ RFI'),
    ('allowVatInclusiveBids', 'รับราคารวม VAT (Y/N)'), ('demoLive', 'Y = seed หยุดที่ OPEN ให้ผู้ขายยื่นสดใน demo'),
    ('expectedStatus', 'สถานะหลัง seed'), ('expectedWinner', 'ผู้ชนะที่คาด'), ('expectedAwardNet', 'ยอดที่มอบก่อน VAT'),
    ('expectedAwardGross', 'ยอดที่มอบรวม VAT'), ('expectedRule', 'ข้อ DOA ที่คาด'), ('expectedApprover', 'ผู้อนุมัติที่คาด'),
    ('expectedBaseline', 'ฐานของยอดประหยัด (ก่อน VAT)'), ('expectedSavings', 'ยอดประหยัด (ก่อน VAT · ติดลบได้)'),
    ('expectedCycleDays', 'วันทำการจากเปิดถึงอนุมัติผล'), ('note', 'หมายเหตุ'),
]

_WEIGHTS_RFQ = [{'code': 'PRICE', 'nameTh': 'ราคา', 'weightBp': 6000}, {'code': 'DELIVERY', 'nameTh': 'การส่งมอบ', 'weightBp': 2500},
                {'code': 'QUALITY', 'nameTh': 'คุณภาพ', 'weightBp': 1500}]
_WEIGHTS_RFP = [{'code': 'PRICE', 'nameTh': 'ราคา', 'weightBp': 4000}, {'code': 'TECHNICAL', 'nameTh': 'เทคนิค', 'weightBp': 4000},
                {'code': 'SERVICE', 'nameTh': 'บริการหลังการขาย', 'weightBp': 2000}]
_PRICE_ONLY = [{'code': 'PRICE', 'nameTh': 'ราคา', 'weightBp': 10000}]


def _scenario(**v):
    row = {k: None for k, _ in RFX_SCENARIO_COLUMNS}
    row.update(v)
    return row


RFX_SCENARIOS = [
    # scene 10 (core): an RFP of a need of IT, no request yet; the winner is not the cheapest (TECHNICAL SERVICE), so the
    # award needs a reason (BR-RFX-12); approved 13 business days after opening at 15:00 → 13.7 business days (G-8)
    _scenario(ref='RFX-IT-FIREWALL', expectedNumber='RFX-2569-00001', kind='RFP', title='ไฟร์วอลล์สำนักงาน 2 ไซต์ พร้อมติดตั้ง',
              titleEn='Office firewall for two sites with installation',
              description='จัดหาไฟร์วอลล์สำนักงานใหญ่และไซต์โรงงานพร้อมติดตั้งและรับประกัน 3 ปี ฝ่ายไอทีจะขอซื้อเมื่อรู้ผู้ชนะ',
              categoryCode='IT', sourceKind='NEED',
              needLines=[{'description': 'ไฟร์วอลล์สำนักงาน', 'descriptionEn': 'Office firewall appliance', 'catalogItemCode': 'ITM-006', 'quantity': '2', 'uom': 'ชุด', 'uomEn': 'set', 'refUnitPrice': None},
                         {'description': 'บริการติดตั้งและตั้งค่า 2 ไซต์', 'descriptionEn': 'Installation and set-up at two sites', 'catalogItemCode': None, 'quantity': '1', 'uom': 'งาน', 'uomEn': 'job', 'refUnitPrice': '25000.00'}],
              creator='proc_officer', evaluators='dm_it;it_02', weightsJson=_WEIGHTS_RFP, invitedSuppliers='SP0141;SP0142;SP0143',
              openBusinessDaysAgo=27, openTime='09:00', closeAfterBusinessDays=11, closeTime='17:00',
              questionsJson=[{'supplier': 'SP0142', 'afterBusinessDays': 2, 'question': 'ราคาต้องรวมอุปกรณ์สำรอง (spare unit) ด้วยหรือไม่',
                              'answer': 'ไม่ต้องรวมอุปกรณ์สำรอง เสนอเฉพาะ 2 ชุดตามรายการ แต่ให้ระบุเงื่อนไขการเปลี่ยนเครื่องในประกัน'}],
              awardAfterBusinessDays=12, awardTime='14:00', decideAfterBusinessDays=13, decideTime='15:00',
              awardReason='คะแนนรวมสูงสุดจากเทคนิคและบริการหลังการขาย ราคาสูงกว่ารายต่ำสุด 1,000 บาท',
              allowVatInclusiveBids='N', demoLive='N', expectedStatus='AWARDED', expectedWinner='SP0142', expectedAwardNet='177000.00',
              expectedAwardGross='189390.00', expectedRule='RA-01', expectedApprover='dm_proc', expectedBaseline='197000.00',
              expectedSavings='20000.00', expectedCycleDays='13.7',
              note='ไม่มีคำขอต้นทางจึงไม่สร้าง PO · ระบบสร้างราคาตกลง ITM-006 กับ SP0142 ที่ 82,500.00 และผู้ขายที่แนะนำหมวด IT'),
    # G-8 below the baseline: a ready-mixed concrete RFQ priced only, the winner above the reference (savings −1,500.00);
    # approved 6 business days after opening at 15:00 → 6.7
    _scenario(ref='RFX-CONCRETE', expectedNumber='RFX-2569-00002', kind='RFQ', title='คอนกรีตผสมเสร็จ 320 กก./ตร.ซม. 40 ลบ.ม.',
              description='คอนกรีตผสมเสร็จสำหรับเทพื้นโรงจอดเครื่องจักร ส่งรถโม่พร้อมปั๊ม ราคาอ้างอิงจากราคาตลาดล่าสุดที่จัดซื้อกรอก',
              categoryCode='RMC', sourceKind='NEED',
              needLines=[{'description': 'คอนกรีตผสมเสร็จ 320 กก./ตร.ซม.', 'descriptionEn': None, 'catalogItemCode': 'RMC-003', 'quantity': '40', 'uom': 'ลบ.ม.', 'uomEn': None, 'refUnitPrice': '2500.00'}],
              creator='proc_mat2', evaluators=None, weightsJson=_PRICE_ONLY, invitedSuppliers='SP0033;SP0034;SP0035',
              openBusinessDaysAgo=17, openTime='09:00', closeAfterBusinessDays=5, closeTime='17:00',
              awardAfterBusinessDays=6, awardTime='10:00', decideAfterBusinessDays=6, decideTime='15:00',
              allowVatInclusiveBids='N', demoLive='N', expectedStatus='AWARDED', expectedWinner='SP0033', expectedAwardNet='101500.00',
              expectedAwardGross='108605.00', expectedRule='RA-01', expectedApprover='dm_proc', expectedBaseline='100000.00',
              expectedSavings='-1500.00', expectedCycleDays='6.7', note='ราคาตลาดขยับขึ้น ยอดที่มอบสูงกว่าฐาน (G-8 ติดลบ)'),
    # scene 11: an RFI of five subcontractors, no prices; concluded by procurement after the close (BR-RFX-02)
    _scenario(ref='RFX-SUB-RFI', expectedNumber='RFX-2569-00003', kind='RFI', title='สำรวจผู้รับเหมาช่วงงานโครงสร้างเหล็ก',
              description='ขอข้อมูลผู้รับเหมาช่วง: ผลงานโครงสร้างเหล็กใน 3 ปี จำนวนช่างที่ส่งได้ใน 30 วัน ใบรับรองความปลอดภัย ประกันภัยงาน และเงื่อนไขการเบิกงวด',
              categoryCode='SUB', sourceKind='NEED',
              needLines=[{'description': 'ข้อมูลผู้รับเหมาช่วงงานโครงสร้างเหล็ก', 'descriptionEn': None, 'catalogItemCode': None, 'quantity': '1', 'uom': 'งาน', 'uomEn': None, 'refUnitPrice': None}],
              creator='proc_sub1', evaluators=None, weightsJson=None, invitedSuppliers='SP0083;SP0084;SP0085;SP0086;SP0087',
              openBusinessDaysAgo=12, openTime='09:00', closeAfterBusinessDays=5, closeTime='09:00',
              decideAfterBusinessDays=6, decideTime='10:00',
              conclusionNote='ได้รายชื่อผู้รับเหมาช่วงที่จะเชิญเข้า RFQ งานโครงสร้างเหล็กรอบหน้า',
              allowVatInclusiveBids='N', demoLive='N', expectedStatus='CONCLUDED', note='ไม่มีราคา ไม่มีผลมอบงาน ไม่มี PO'),
    # scene 9 (core): the two DB12 lines of H187 and H217 waiting in the pool without a supplier (P1-02), opened on the
    # seed's business day and left OPEN for the suppliers to bid live; its bids and scores below are what the demo types
    _scenario(ref='RFX-STEEL-DB12', expectedNumber='RFX-2569-00004', kind='RFQ', title='เหล็กข้ออ้อย DB12 SD40 13 ตัน 2 ไซต์',
              description='เหล็กข้ออ้อย DB12 SD40 ส่ง SITE-P01 8 ตัน และ SITE-P09 5 ตัน ส่งภายใน 7 วันหลังได้ใบสั่งซื้อ',
              categoryCode='STEEL', sourceKind='REQUEST_LINES', historyRefs='H187;H217',
              creator='proc_mat1', evaluators='proc_mat2;proc_officer', weightsJson=_WEIGHTS_RFQ, invitedSuppliers='SP0023;SP0024;SP0029',
              openBusinessDaysAgo=0, openTime='09:00', closeAfterBusinessDays=3, closeTime='17:00',
              allowVatInclusiveBids='Y', demoLive='Y', expectedStatus='OPEN', expectedWinner='SP0023', expectedAwardNet='300950.00',
              expectedAwardGross='322016.50', expectedRule='RA-01', expectedApprover='dm_proc', expectedBaseline='309400.00',
              expectedSavings='8450.00', expectedCycleDays='5.2',
              note='ผู้ขายยื่นสด · ค่าที่คาดคือหลังเล่นฉาก 9 จนอนุมัติ (PO 2 ใบ 185,200.00 และ 115,750.00)'),
]


def scenario_rows():
    """RFX_SCENARIOS as the sheet holds them: the JSON columns as text"""
    return [{k: json.dumps(v, ensure_ascii=False, separators=(',', ':')) if isinstance(v, (list, dict)) else v for k, v in r.items()} for r in RFX_SCENARIOS]

# ---------- RFx_Bids ----------

RFX_BID_COLUMNS = [
    ('rfxRef', 'RFx (ชีต RFx_Scenarios)'), ('supplier', 'ผู้ขาย'), ('lineNo', 'บรรทัดที่'), ('unitPrice', 'ราคาต่อหน่วย'),
    ('includesVat', 'ราคารวม VAT (Y/N)'), ('offered', 'เสนอบรรทัดนี้ (Y/N)'), ('submitAfterBusinessDays', 'ยื่นหลังเปิดกี่วันทำการ'),
    ('submitTime', 'เวลายื่น'), ('deliveryDays', 'ส่งของภายในกี่วัน'), ('note', 'หมายเหตุ'),
]


def _bids(rfx, supplier, prices, after, time, vat='N', days=7, note=None):
    return [{'rfxRef': rfx, 'supplier': supplier, 'lineNo': n, 'unitPrice': p, 'includesVat': vat, 'offered': 'Y',
             'submitAfterBusinessDays': after, 'submitTime': time, 'deliveryDays': days, 'note': note} for n, p in enumerate(prices, 1)]


RFX_BIDS = [
    *_bids('RFX-IT-FIREWALL', 'SP0141', ['82000.00', '12000.00'], 6, '10:30', days=30),
    *_bids('RFX-IT-FIREWALL', 'SP0142', ['82500.00', '12000.00'], 8, '15:00', days=21),
    *_bids('RFX-IT-FIREWALL', 'SP0143', ['88000.00', '12000.00'], 10, '11:00', days=14),
    *_bids('RFX-CONCRETE', 'SP0033', ['2537.50'], 2, '10:00', days=3),
    *_bids('RFX-CONCRETE', 'SP0034', ['2600.00'], 3, '14:00', days=3),
    *_bids('RFX-CONCRETE', 'SP0035', ['2650.00'], 4, '09:30', days=5),
    # scene 9, typed live in the demo (the seed leaves the RFQ open): SP0024 bids with VAT (the RFQ takes it · OQ-212)
    *_bids('RFX-STEEL-DB12', 'SP0023', ['23150.00', '23150.00'], 1, '10:00', days=7),
    *_bids('RFX-STEEL-DB12', 'SP0029', ['23500.00', '23500.00'], 1, '14:00', days=5),
    *_bids('RFX-STEEL-DB12', 'SP0024', ['25000.00', '25000.00'], 2, '11:00', vat='Y', days=10, note='ราคารวม VAT'),
]

# ---------- RFx_Scores ----------

RFX_SCORE_COLUMNS = [('rfxRef', 'RFx'), ('evaluator', 'ผู้ประเมิน'), ('supplier', 'ผู้ขาย'), ('criterion', 'เกณฑ์ (ไม่ใช่ PRICE)'), ('score', 'คะแนน 0–100')]


def _scores(rfx, evaluators, table):
    return [{'rfxRef': rfx, 'evaluator': ev, 'supplier': sup, 'criterion': crit, 'score': scores[i]}
            for i, ev in enumerate(evaluators) for sup, by in table.items() for crit, scores in by.items()]


RFX_SCORES = [
    *_scores('RFX-IT-FIREWALL', ['dm_it', 'it_02'], {'SP0141': {'TECHNICAL': [80, 80], 'SERVICE': [60, 60]},
                                                      'SP0142': {'TECHNICAL': [90, 90], 'SERVICE': [82, 83]},
                                                      'SP0143': {'TECHNICAL': [85, 85], 'SERVICE': [72, 73]}}),
    # scene 9, given live (the seed scores nothing of an open RFQ)
    *_scores('RFX-STEEL-DB12', ['proc_mat2', 'proc_officer'], {'SP0023': {'DELIVERY': [85, 90], 'QUALITY': [90, 90]},
                                                               'SP0029': {'DELIVERY': [90, 90], 'QUALITY': [90, 90]},
                                                               'SP0024': {'DELIVERY': [70, 75], 'QUALITY': [80, 80]}}),
]

# ---------- Demo_Script_P2 (rows of S10: scenes 9–15) ----------


def demo_p2_rows():
    """The scenes of S10 in the shared sheet Demo_Script_P2: dicts of p1_demo.P2_COLUMNS (expectJson as dicts)"""
    from p1_suppliers_portal import PRIMARY_CONTACT, SUPPLIER_APPLICATIONS
    foreign = RFX_SUPPLIERS[0]
    waiting = next(a for a in SUPPLIER_APPLICATIONS if a['status'] == 'SUBMITTED')
    return [
        dict(scene=9, core='Y', stage='S10', titleTh='RFQ เหล็กข้ออ้อยจากกอง ผู้ขายยื่นบนมือถือ เทียบราคา ให้คะแนน และอนุมัติผลเป็น PO', actor='proc_mat1',
             others='proc_mat2 · proc_officer · dm_proc', portalActor=PRIMARY_CONTACT['SP0023'], supplier='SP0023', module='SOURCING',
             expectJson={'rfx': 'RFX-STEEL-DB12', 'fromPool': ['H187', 'H217'], 'estimateNet': '309400.00', 'estimateGross': '331058.00', 'minInvites': 3,
                         'compareNet': {'SP0023': '300950.00', 'SP0024': '303738.32', 'SP0029': '305500.00'}, 'priceBp': {'SP0023': 10000, 'SP0024': 9908, 'SP0029': 9851},
                         'ranking': ['SP0023', 'SP0029', 'SP0024'], 'totals': {'SP0023': '95.38', 'SP0029': '95.11', 'SP0024': '89.57'},
                         'awardNet': '300950.00', 'awardVat': '21066.50', 'awardGross': '322016.50', 'rule': 'RA-01', 'approver': 'dm_proc',
                         'poCount': 2, 'poNets': ['185200.00', '115750.00'], 'poRule': 'PO-01', 'poApprover': 'coo', 'savings': '8450.00', 'savingsBp': 273,
                         'cycleDays': '5.2', 'numbersFromScreen': ['RFX', 'AWD', 'PO']},
             minutes=10,
             stepsTh='seed เปิด RFQ ไว้แล้ว (เชิญ SP0023 SP0024 SP0029 · ผู้ประเมิน proc_mat2 proc_officer) → ผู้ติดต่อทั้งสามยื่นใน /portal/rfx บนมือถือ (SP0024 ยื่นรวม VAT) → proc_mat1 เห็นเพียงจำนวนที่ยื่น (ซองปิด) → ปิดรับ → proc_mat2 proc_officer ให้คะแนนส่งมอบและคุณภาพ → proc_mat1 มอบงานทั้งสองบรรทัดให้ SP0023 ส่งอนุมัติ → dm_proc อนุมัติบน LIFF พร้อม PIN → ร่าง PO 2 ใบตามไซต์',
             notes='RFQ ใบนี้ seed เปิดในวันทำการของวัน seed และปิดรับอีก 3 วันทำการ 17:00 · ราคาและคะแนนอยู่ในชีต RFx_Bids และ RFx_Scores (แถวของ RFX-STEEL-DB12) · วันทำการ 5.2 นับตามที่ sub-spec ร่างไว้ ค่าจริงขึ้นกับเวลาที่เล่น'),
        dict(scene=10, core='Y', stage='S10', titleTh='RFP ไฟร์วอลล์: ผู้ชนะคะแนนรวมสูงสุดแม้ไม่ใช่ราคาต่ำสุด ได้ราคาตกลงแทน PO', actor='proc_officer',
             others='dm_it · it_02 · dm_proc · it_01', portalActor=PRIMARY_CONTACT['SP0142'], supplier='SP0142', module='SOURCING',
             expectJson={'rfx': 'RFX-IT-FIREWALL', 'compareNet': {'SP0141': '176000.00', 'SP0142': '177000.00', 'SP0143': '188000.00'},
                         'priceBp': {'SP0141': 10000, 'SP0142': 9944, 'SP0143': 9362}, 'totals': {'SP0142': '92.28', 'SP0143': '85.95', 'SP0141': '84.00'},
                         'ranking': ['SP0142', 'SP0143', 'SP0141'], 'awardNet': '177000.00', 'awardGross': '189390.00', 'rule': 'RA-01', 'approver': 'dm_proc',
                         'poCount': 0, 'priceAgreement': {'item': 'ITM-006', 'supplier': 'SP0142', 'unitPrice': '82500.00'}, 'preferredCategory': 'IT',
                         'savings': '20000.00', 'baselineKind': 'ESTIMATE', 'cycleDays': '13.7'},
             minutes=5,
             stepsTh='proc_officer เปิด RFP ที่อนุมัติผลแล้วใน seed → ดูคำถามของ SP0142 และคำตอบที่ส่งถึงทุกราย → ตารางเทียบและคะแนน (SP0142 ชนะด้วยคะแนนรวม) → ผลมอบงานพร้อมเหตุผล → ราคาตกลง ITM-006 → it_01 สร้างคำขอซื้อไฟร์วอลล์ ฟอร์มเติม SP0142 และราคา 82,500.00',
             notes='seed เล่น RFP นี้จนอนุมัติผล (ไม่มี PO เพราะเป็นความต้องการที่ยังไม่มีคำขอ) · ฉากนี้ดูผลและให้ it_01 ขอซื้อต่อ'),
        dict(scene=11, core='N', stage='S10', titleTh='RFI สำรวจผู้รับเหมาช่วง ไม่มีราคา จบด้วยสรุปของจัดซื้อ', actor='proc_sub1', others=None, portalActor=None,
             supplier=None, module='SOURCING', expectJson={'rfx': 'RFX-SUB-RFI', 'status': 'CONCLUDED', 'invited': ['SP0083', 'SP0084', 'SP0085', 'SP0086', 'SP0087'],
                                                           'award': None, 'poCount': 0},
             minutes=2, stepsTh='proc_sub1 เปิด /sourcing กรอง RFI → RFI ที่สรุปแล้ว ไม่มีผลมอบงานและ PO', notes=None),
        dict(scene=12, core='N', stage='S10', titleTh='ผู้ขายที่ยังสมัครไม่เสร็จเข้า RFx: เชิญได้ ยื่นได้เมื่ออนุมัติแล้ว', actor='proc_mat1', others=None,
             portalActor=waiting['contactEmail'], supplier=waiting['ref'], module='SOURCING',
             expectJson={'rfx': 'RFX-STEEL-DB12', 'application': waiting['ref'], 'inviteWhile': 'OPEN', 'bidError': 'SUPPLIER_NOT_APPROVED', 'linkExpiresAt': 'closesAt'},
             minutes=2, stepsTh=f'proc_mat1 เชิญใบสมัคร {waiting["ref"]} (สถานะ SUBMITTED ใน seed) เข้า RFQ ของฉาก 9 → ผู้ติดต่อเห็น RFx ถามได้ แต่กดยื่นข้อเสนอแล้วถูกปฏิเสธจนใบสมัครผ่าน DOA',
             notes='เล่นระหว่างที่ RFQ ของฉาก 9 ยังเปิดรับ'),
        dict(scene=13, core='Y', stage='S10', titleTh='ผู้ขายต่างชาติและเอกสาร RFx สองภาษา', actor='proc_officer', others=None, portalActor=foreign['contactEmail'],
             supplier=foreign['ref'], module='SOURCING',
             expectJson={'supplier': foreign['nameEn'], 'isForeign': True, 'payeeType': 'FOREIGN', 'contactLocale': 'en', 'locale': 'TH_EN', 'currency': 'THB',
                         'vatRateBp': 0, 'warning': 'OQ-205', 'awardReasonRequired': True, 'payBlocked': 'FOREIGN_PAYEE'},
             minutes=4,
             stepsTh='proc_officer เชิญ Nordic Firewall AS (ผู้ขายต่างชาติที่อนุมัติแล้วใน seed) เข้า RFP สองภาษา → ผู้ติดต่อเห็นพอร์ทัลเป็นอังกฤษ ยื่นราคาเป็นบาท → ตารางเทียบแสดงรายนี้ที่ VAT 0 พร้อมป้ายภาษีนอกระบบ',
             notes='RFP ของฉาก 10 อนุมัติผลแล้วใน seed จึงเชิญเพิ่มไม่ได้ · ฉากนี้เปิด RFP สองภาษาใบใหม่สดสำหรับความต้องการเดียวกัน (S10-17 S10-18 กำหนดขั้นตอนจริง)'),
        dict(scene=14, core='N', stage='S10', titleTh='AI ช่วยจัดหา: ร่าง RFx สรุปข้อเสนอ และประเด็นเจรจา', actor='proc_mat1', others=None, portalActor=None, supplier=None,
             module='AI', expectJson={'agent': 'SOURCING', 'purposes': ['RFX_DRAFT', 'BID_SUMMARY', 'NEGOTIATION_POINTS'], 'spread': {'low': '300950.00', 'high': '305500.00', 'bp': 151},
                                      'negotiation': {'supplier': 'SP0029', 'gap': '4550.00', 'gapBp': 151}},
             minutes=3, stepsTh='ในฉาก 9 หลังปิดรับ กดสรุปข้อเสนอ แล้วกดประเด็นเจรจา (ข้อความอย่างเดียว ระบบไม่ส่งถึงผู้ขาย)',
             notes='ปิด AI แล้วทุกขั้นของฉาก 9 ทำด้วยมือครบ (EG-1)'),
        dict(scene=15, core='N', stage='S10', titleTh='KPI G-8 ยอดประหยัดและเวลาจัดหา', actor='dm_proc', others=None, portalActor=None, supplier=None, module='SOURCING',
             expectJson={'afterSeed': {'awards': 2, 'baseline': '297000.00', 'savings': '18500.00', 'savingsBp': 623, 'medianDays': '6.7'},
                         'afterScene9': {'awards': 3, 'baseline': '606400.00', 'savings': '26950.00', 'savingsBp': 444, 'medianDays': '6.7'}},
             minutes=2, stepsTh='dm_proc เปิด /reports/sourcing ช่วงที่ครอบวันเปิดของ RFx ใน seed (ราว 6 สัปดาห์ก่อนวัน seed ถึงวันนี้) → ยอดประหยัดรวมและมัธยฐานวันทำการ',
             notes='ช่วงเวลาของรายงานต้องครอบ RFx ทั้งสี่ใบ (วันที่สัมพัทธ์กับวัน seed ไม่ใช่ไตรมาส ต.ค.–ธ.ค. ตายตัว)'),
    ]
