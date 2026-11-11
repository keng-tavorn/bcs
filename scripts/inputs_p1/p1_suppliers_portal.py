# -*- coding: utf-8 -*-
"""The supplier portal of phase 2 in the synthetic workbook (S7-13 · docs/sub-specs/S7.md "การอ่านชีตของไฟล์ระยะ 1").

Sheets Supplier_Contacts (the portal's contacts of every supplier), Supplier_Document_Types (the six types of BR-SDOC-01),
Supplier_Documents (the documents on file, dated relative to the day of the seed so the counts hold whatever day it runs,
except the fixed rows other steps name) and Supplier_Applications (nine applications the seed plays with the real
commands back in time · G-7 of the approved ones fixed in business days), and the rows of S7 in the shared sheet
Demo_Script_P2 (demo_p2_rows). Every company, person and address is invented: e-mails at @supplier.simec.local, tax IDs
with the synthetic prefixes 0999998 and 3999998 (mod-11).
"""
from p1_common import rng, taxid
from p1_suppliers import SUPPLIERS, PAYMENT_BY_SUPPLIER, _FIRST, _LAST

# ---------- Supplier_Contacts ----------

CONTACT_COLUMNS = [
    ('supplierCode', 'รหัสผู้ขาย (ชีต Suppliers)'), ('nameTh', 'ชื่อผู้ติดต่อ (สมมติ)'), ('email', 'อีเมลเข้าพอร์ทัล (ตัวเล็ก ไม่ซ้ำ)'),
    ('phone', 'โทร'), ('roleLabel', 'หน้าที่'), ('isPrimary', 'ผู้ติดต่อหลัก (Y/N · 1 คนต่อผู้ขาย)'), ('locale', 'ภาษา th en'),
    ('portalEnabled', 'เข้าพอร์ทัลได้ (Y/N)'),
]

_ROLES = ['ฝ่ายขาย', 'ผู้จัดการฝ่ายขาย', 'เจ้าของกิจการ', 'ผู้ประสานงานโครงการ']
_SECOND_ROLES = ['บัญชีและการเงิน', 'ฝ่ายบัญชี']
# 24 suppliers have a second contact (their accountant): the ones the scenes of S7 S10 S11 touch first, then every eighth
_SCENE_SUPPLIERS = ['SP0023', 'SP0024', 'SP0029', 'SP0083', 'SP0084', 'SP0085', 'SP0086', 'SP0087', 'SP0105', 'SP0132', 'SP0141', 'SP0142', 'SP0143', 'SP0160']


def _contacts():
    r = rng('supplier-contacts')
    second = list(_SCENE_SUPPLIERS)
    for s in SUPPLIERS[::8]:
        if len(second) >= 24:
            break
        if s['code'] not in second:
            second.append(s['code'])
    rows = []
    for i, s in enumerate(SUPPLIERS, 1):
        code = s['code']
        count = 2 if code in second else 1
        for n in range(1, count + 1):
            rows.append({
                'supplierCode': code,
                'nameTh': f'คุณ{r.choice(_FIRST)} {r.choice(_LAST)}',
                'email': f'{code.lower()}.{n}@supplier.simec.local',
                'phone': f'08{(i * 7 + n) % 10}-{100 + i:03d}-{1000 + i * 3 + n:04d}',
                'roleLabel': r.choice(_ROLES) if n == 1 else r.choice(_SECOND_ROLES),
                'isPrimary': 'Y' if n == 1 else 'N',
                # a few contacts read the portal in English
                'locale': 'en' if i % 23 == 0 else 'th',
                'portalEnabled': 'Y',
            })
    return rows


SUPPLIER_CONTACTS = _contacts()
PRIMARY_CONTACT = {c['supplierCode']: c['email'] for c in SUPPLIER_CONTACTS if c['isPrimary'] == 'Y'}

# ---------- Supplier_Document_Types (BR-SDOC-01 · OQ-183 OQ-186) ----------

DOC_TYPE_COLUMNS = [
    ('code', 'รหัสประเภท'), ('nameTh', 'ชื่อ'), ('nameEn', 'ชื่ออังกฤษ'), ('appliesTo', 'ใช้กับ JURISTIC INDIVIDUAL FOREIGN คั่นด้วย ,'),
    ('required', 'บังคับ (Y/N)'), ('validityDays', 'อายุนับจากวันออก (วัน · ว่าง = ตามวันหมดอายุบนเอกสาร)'),
    ('reminderDaysBefore', 'เตือนก่อนหมดอายุกี่วัน'), ('sensitive', 'ข้อมูลอ่อนไหว (Y/N)'), ('aiReadable', 'AI อ่านได้ (Y/N)'),
    ('aiReadablePayeeTypes', 'AI อ่านเฉพาะผู้รับเงินประเภท (ว่าง = ทุกประเภทที่ใช้)'), ('singleInstance', 'มีได้ฉบับเดียว (Y/N)'),
    ('linkedRiskQuestionCodes', 'คำถามประเมินความเสี่ยงที่ใช้เอกสารนี้ (S11 · คั่นด้วย ,)'), ('sortOrder', 'ลำดับ'),
]

DOC_TYPES = [
    {'code': 'COMPANY_CERT', 'nameTh': 'หนังสือรับรองบริษัท', 'nameEn': 'Company certificate', 'appliesTo': 'JURISTIC', 'required': 'Y', 'validityDays': 180,
     'reminderDaysBefore': 30, 'sensitive': 'N', 'aiReadable': 'Y', 'aiReadablePayeeTypes': None, 'singleInstance': 'Y', 'linkedRiskQuestionCodes': None, 'sortOrder': 1},
    {'code': 'VAT_CERT', 'nameTh': 'ภ.พ.20', 'nameEn': 'VAT registration (Por.Por.20)', 'appliesTo': 'JURISTIC,INDIVIDUAL', 'required': 'Y', 'validityDays': 3650,
     'reminderDaysBefore': 60, 'sensitive': 'N', 'aiReadable': 'Y', 'aiReadablePayeeTypes': 'JURISTIC', 'singleInstance': 'Y', 'linkedRiskQuestionCodes': None, 'sortOrder': 2},
    {'code': 'BANK_BOOK', 'nameTh': 'หน้าสมุดบัญชีธนาคาร', 'nameEn': 'Bank book page', 'appliesTo': 'JURISTIC,INDIVIDUAL,FOREIGN', 'required': 'N', 'validityDays': 3650,
     'reminderDaysBefore': 30, 'sensitive': 'N', 'aiReadable': 'N', 'aiReadablePayeeTypes': None, 'singleInstance': 'Y', 'linkedRiskQuestionCodes': None, 'sortOrder': 3},
    {'code': 'ID_CARD', 'nameTh': 'สำเนาบัตรประชาชน', 'nameEn': 'ID card copy', 'appliesTo': 'INDIVIDUAL', 'required': 'Y', 'validityDays': None,
     'reminderDaysBefore': 30, 'sensitive': 'Y', 'aiReadable': 'N', 'aiReadablePayeeTypes': None, 'singleInstance': 'Y', 'linkedRiskQuestionCodes': None, 'sortOrder': 4},
    {'code': 'INCORPORATION_FOREIGN', 'nameTh': 'หนังสือจดทะเบียนต่างประเทศ', 'nameEn': 'Foreign incorporation certificate', 'appliesTo': 'FOREIGN', 'required': 'Y',
     'validityDays': 365, 'reminderDaysBefore': 30, 'sensitive': 'N', 'aiReadable': 'N', 'aiReadablePayeeTypes': None, 'singleInstance': 'Y', 'linkedRiskQuestionCodes': None, 'sortOrder': 5},
    {'code': 'ISO_CERT', 'nameTh': 'ใบรับรองระบบคุณภาพ (ISO)', 'nameEn': 'ISO certificate', 'appliesTo': 'JURISTIC,INDIVIDUAL,FOREIGN', 'required': 'N', 'validityDays': None,
     'reminderDaysBefore': 30, 'sensitive': 'N', 'aiReadable': 'N', 'aiReadablePayeeTypes': None, 'singleInstance': 'N', 'linkedRiskQuestionCodes': 'RQ-IS-01,RQ-PRM-02', 'sortOrder': 6},
]

# ---------- Supplier_Documents ----------

DOCUMENT_COLUMNS = [
    ('supplierCode', 'รหัสผู้ขาย'), ('docType', 'ประเภท (ชีต Supplier_Document_Types)'), ('docNumber', 'เลขที่เอกสาร (สมมติ)'),
    ('issuer', 'ผู้ออก'), ('scope', 'ขอบเขต (ISO เท่านั้น)'), ('issuedDaysAgo', 'ออกกี่วันก่อนวัน seed'),
    ('expiresDaysAhead', 'หมดอายุอีกกี่วันหลังวัน seed (ประเภทที่ไม่มีอายุ)'), ('issuedOn', 'วันออก (ตายตัว · ใช้แทนคอลัมน์สัมพัทธ์)'),
    ('expiresOn', 'วันหมดอายุ (ตายตัว)'), ('status', 'PENDING VERIFIED EXPIRED SUPERSEDED'), ('verifiedBy', 'ผู้ยืนยัน (ผู้ใช้ PROCUREMENT)'),
]

VERIFIERS = ['proc_officer', 'proc_mat1', 'proc_mat2', 'proc_sub1', 'proc_sub2']
# a COMPANY_CERT reminded within 30 days (12 suppliers, SP0105 of scene 4 among them) and one expired (5, the two ceased)
EXPIRING = ['SP0105', 'SP0003', 'SP0012', 'SP0026', 'SP0041', 'SP0058', 'SP0071', 'SP0090', 'SP0122', 'SP0137', 'SP0150', 'SP0163']
EXPIRED = ['SP0031', 'SP0096', 'SP0017', 'SP0064', 'SP0179']
# documents waiting for procurement (uploaded in the portal, not verified yet) and older copies a new one replaced
PENDING_NEW = ['SP0044', 'SP0081', 'SP0170']
SUPERSEDED_OLD = ['SP0029', 'SP0052']
BANK_BOOKS = ['SP0023', 'SP0024', 'SP0029', 'SP0044', 'SP0070', 'SP0083', 'SP0105', 'SP0132', 'SP0141', 'SP0160']
COMPANY_CERT_DAYS = 180


def _documents():
    r = rng('supplier-documents')
    rows = []
    for i, s in enumerate(SUPPLIERS):
        code = s['code']
        payee = PAYMENT_BY_SUPPLIER[code]['payeeType']
        who = VERIFIERS[i % len(VERIFIERS)]

        def add(doc_type, **v):
            row = {'supplierCode': code, 'docType': doc_type, 'docNumber': None, 'issuer': None, 'scope': None, 'issuedDaysAgo': None,
                   'expiresDaysAhead': None, 'issuedOn': None, 'expiresOn': None, 'status': 'VERIFIED', 'verifiedBy': who}
            row.update(v)
            if row['status'] in ('PENDING',):
                row['verifiedBy'] = None
            rows.append(row)

        if payee == 'JURISTIC':
            # the company certificate is valid 180 days from its issue (BR-SDOC-02: expiresOn = issuedOn + 179)
            if code in EXPIRING:
                ago = COMPANY_CERT_DAYS - 1 - (7 if code == 'SP0105' else 8 + (EXPIRING.index(code) * 2))  # expires within 30 days
            elif code in EXPIRED:
                ago = 200 + EXPIRED.index(code) * 15
            else:
                ago = r.randrange(10, 120)  # expires in 60 days or more
            if code in SUPERSEDED_OLD:
                add('COMPANY_CERT', docNumber=f'DBD-{code}-OLD', issuer='กรมพัฒนาธุรกิจการค้า', issuedDaysAgo=ago + 170, status='SUPERSEDED')
            add('COMPANY_CERT', docNumber=f'DBD-{code}-{ago:03d}', issuer='กรมพัฒนาธุรกิจการค้า', issuedDaysAgo=ago,
                status='EXPIRED' if code in EXPIRED else ('PENDING' if code in PENDING_NEW else 'VERIFIED'))
            if s['vatRegistered'] == 'Y':
                add('VAT_CERT', docNumber=f'PP20-{code}', issuer='กรมสรรพากร', issuedDaysAgo=r.randrange(400, 3000))
        else:
            # an individual's ID card carries its own expiry date
            add('ID_CARD', docNumber=None, issuer='กรมการปกครอง', issuedDaysAgo=r.randrange(400, 2000), expiresDaysAhead=r.randrange(400, 1800))
        if code in BANK_BOOKS:
            add('BANK_BOOK', issuer='ธนาคาร', issuedDaysAgo=r.randrange(60, 600))
    # two suppliers with ISO certificates of two scopes each (BR-SDOC-03): SP0141's ISO 27001 is the one scene 12 of S11 names
    rows.append({'supplierCode': 'SP0141', 'docType': 'ISO_CERT', 'docNumber': 'ISMS-2024-0141', 'issuer': 'หน่วยรับรองสมมติ', 'scope': 'ISO 27001',
                 'issuedDaysAgo': None, 'expiresDaysAhead': None, 'issuedOn': '2024-04-01', 'expiresOn': '2027-03-31', 'status': 'VERIFIED', 'verifiedBy': 'proc_officer'})
    rows.append({'supplierCode': 'SP0141', 'docType': 'ISO_CERT', 'docNumber': 'QMS-0141', 'issuer': 'หน่วยรับรองสมมติ', 'scope': 'ISO 9001',
                 'issuedDaysAgo': 300, 'expiresDaysAhead': 795, 'issuedOn': None, 'expiresOn': None, 'status': 'VERIFIED', 'verifiedBy': 'proc_officer'})
    rows.append({'supplierCode': 'SP0142', 'docType': 'ISO_CERT', 'docNumber': 'QMS-0142', 'issuer': 'หน่วยรับรองสมมติ', 'scope': 'ISO 9001',
                 'issuedDaysAgo': 420, 'expiresDaysAhead': 675, 'issuedOn': None, 'expiresOn': None, 'status': 'VERIFIED', 'verifiedBy': 'proc_mat1'})
    rows.append({'supplierCode': 'SP0142', 'docType': 'ISO_CERT', 'docNumber': 'EMS-0142', 'issuer': 'หน่วยรับรองสมมติ', 'scope': 'ISO 14001',
                 'issuedDaysAgo': 150, 'expiresDaysAhead': 945, 'issuedOn': None, 'expiresOn': None, 'status': 'VERIFIED', 'verifiedBy': 'proc_mat1'})
    return rows


SUPPLIER_DOCUMENTS = _documents()

# ---------- Supplier_Applications ----------

APPLICATION_COLUMNS = [
    ('ref', 'รหัส'), ('kind', 'NEW'), ('nameTh', 'ชื่อผู้ขาย (สมมติ)'), ('taxId', 'เลขผู้เสียภาษี (ข้อความ 13 หลัก)'), ('branchCode', 'สาขา'),
    ('payeeType', 'JURISTIC INDIVIDUAL'), ('category', 'หมวด'), ('contactName', 'ผู้ติดต่อ'), ('contactEmail', 'อีเมลผู้ติดต่อ'),
    ('inviterPhone', 'เบอร์ที่จัดซื้อกรอกตอนเชิญ (ใช้โทรยืนยันบัญชี)'), ('invitedBy', 'ผู้เชิญ'), ('routedBy', 'ผู้ส่งเข้าเส้นทาง'),
    ('verifiedBy', 'ผู้ยืนยันเอกสาร'), ('invitedDaysAgo', 'เชิญกี่วันก่อนวัน seed (10:00 ของวันทำการนั้นหรือถัดไป)'),
    ('lastActivityDaysAgo', 'ความเคลื่อนไหวล่าสุดกี่วันก่อนวัน seed'), ('status', 'สถานะหลังเล่น'), ('filledOnBehalf', 'จัดซื้อที่กรอกแทน'),
    ('missingDocs', 'เอกสารที่ยังไม่ส่ง คั่นด้วย ,'), ('decidedDaysAgo', 'ตัดสินกี่วันก่อน (ใบที่อนุมัติคำนวณจาก expectedG7Days)'),
    ('expectedApprover', 'ผู้อนุมัติที่คาด (ข้อ SA-01)'), ('expectedG7Days', 'G-7 ที่คาด (วันทำการ ทศนิยม 1 ตำแหน่ง)'),
]


def _app(ref, name, serial, payee='JURISTIC', **v):
    tax = taxid(f'0999998{serial:05d}') if payee == 'JURISTIC' else taxid(f'3999998{serial:05d}')
    row = {'ref': ref, 'kind': 'NEW', 'nameTh': name, 'taxId': tax, 'branchCode': '00000', 'payeeType': payee, 'category': None,
           'contactName': None, 'contactEmail': None, 'inviterPhone': None, 'invitedBy': 'proc_mat1', 'routedBy': None, 'verifiedBy': None,
           'invitedDaysAgo': None, 'lastActivityDaysAgo': None, 'status': None, 'filledOnBehalf': None, 'missingDocs': None,
           'decidedDaysAgo': None, 'expectedApprover': None, 'expectedG7Days': None}
    row.update(v)
    return row


SUPPLIER_APPLICATIONS = [
    # approved: G-7 2.1 · 8.8 · 3.6 business days (lower median 3.6 · scene 7 · GC-SUP-31); the second filled in by proc_mat2
    _app('SA-01', 'บริษัท นครปฐมวัสดุก่อสร้าง จำกัด', 20031, category='วัสดุก่อสร้างทั่วไป', contactName='คุณสมพร ใจดี', contactEmail='npt@supplier.simec.local',
         inviterPhone='034-000-2031', invitedBy='proc_mat1', routedBy='proc_mat2', verifiedBy='proc_mat2', invitedDaysAgo=40, status='APPROVED',
         expectedApprover='dm_proc', expectedG7Days=2.1),
    _app('SA-02', 'ห้างหุ้นส่วนจำกัด ศรีสะเกษการโยธา', 20049, category='ผู้รับเหมาช่วง', contactName='คุณประเสริฐ พลอยงาม', contactEmail='ssk@supplier.simec.local',
         inviterPhone='045-000-2049', invitedBy='proc_sub1', routedBy='proc_sub2', verifiedBy='proc_sub2', invitedDaysAgo=35, status='APPROVED',
         filledOnBehalf='proc_mat2', expectedApprover='dm_proc', expectedG7Days=8.8),
    _app('SA-03', 'บริษัท ลพบุรีเซฟตี้ซัพพลาย จำกัด', 20057, category='อุปกรณ์ความปลอดภัย', contactName='คุณวิไล ศรีเมือง', contactEmail='lbs@supplier.simec.local',
         inviterPhone='036-000-2057', invitedBy='proc_mat2', routedBy='proc_officer', verifiedBy='proc_officer', invitedDaysAgo=25, status='APPROVED',
         expectedApprover='dm_proc', expectedG7Days=3.6),
    _app('SA-04', 'บริษัท สุพรรณบุรีขนส่ง จำกัด', 20065, category='ขนส่ง', contactName='คุณชาตรี มีทรัพย์', contactEmail='spb@supplier.simec.local',
         inviterPhone='035-000-2065', invitedBy='proc_mat1', routedBy='proc_mat2', verifiedBy='proc_mat2', invitedDaysAgo=6, lastActivityDaysAgo=1,
         status='PENDING_APPROVAL', expectedApprover='dm_proc'),
    _app('SA-05', 'บริษัท กาญจนบุรีอีเล็คทริค จำกัด', 20073, category='วัสดุไฟฟ้าและงานระบบ', contactName='คุณอรุณี แก้วกล้า', contactEmail='kcb@supplier.simec.local',
         inviterPhone='034-000-2073', invitedBy='proc_mat2', invitedDaysAgo=4, lastActivityDaysAgo=1, status='SUBMITTED'),
    # scene 2: half filled in, the VAT certificate and the bank book missing, waiting past the escalation (10 business days)
    _app('SA-06', 'ห้างหุ้นส่วนจำกัด บ้านโป่งเหล็กกล้าค้าเหล็ก', 20028, category='เหล็กและเหล็กรูปพรรณ', contactName='คุณบุญมี นาคประเสริฐ',
         contactEmail='bpk@supplier.simec.local', inviterPhone='032-000-2028', invitedBy='proc_mat1', invitedDaysAgo=20, lastActivityDaysAgo=18, status='DRAFT',
         missingDocs='VAT_CERT,BANK_BOOK'),
    _app('SA-07', 'บริษัท ปราจีนบุรีแล็บ จำกัด', 20081, category='ทดสอบวัสดุและสำรวจ', contactName='คุณสุนิสา บุญล้อม', contactEmail='pcb@supplier.simec.local',
         inviterPhone='037-000-2081', invitedBy='proc_sub1', invitedDaysAgo=1, lastActivityDaysAgo=1, status='INVITED'),
    _app('SA-08', 'นายจำลอง กองแก้ว (ช่างหลังคา รับเหมารายย่อย)', 2081, payee='INDIVIDUAL', category='ช่างและผู้รับเหมารายย่อย', contactName='นายจำลอง กองแก้ว',
         contactEmail='jamlong@supplier.simec.local', inviterPhone='081-000-2081', invitedBy='proc_sub2', verifiedBy='proc_sub1', invitedDaysAgo=9,
         lastActivityDaysAgo=3, status='RETURNED'),
    _app('SA-09', 'บริษัท ชัยนาทแมชชีนเนอรี่ จำกัด', 20099, category='เช่าเครื่องจักรและนั่งร้าน', contactName='คุณวิเชียร ชำนาญกิจ', contactEmail='cnt@supplier.simec.local',
         inviterPhone='056-000-2099', invitedBy='proc_mat2', invitedDaysAgo=45, lastActivityDaysAgo=42, status='EXPIRED'),
]

# ---------- Demo_Script_P2 (rows of S7: scenes 1–8) ----------


def _ack_po():
    """Scene 5 on the seed alone (ADR-191): the newest PO of Request_History at a project site still waiting for its goods
    (ORDERED), asked for by the project's manager, that no scene of phase 1 uses, of a supplier with a portal contact. Who
    hears of the acknowledgement (BR-SUP-14 · sentRecipients): the requester and the RECEIVER members of the requester's
    department; of a new date, the buyer too — proc_officer, who makes the POs of the history"""
    from p1_demo import SCENES as P1_SCENES
    from p1_history import build
    from p1_org import USERS
    used = {s.get('historyRef') for s in P1_SCENES if s.get('historyRef')}
    rows, _ = build()
    rows = [h for h in rows if h['status'] == 'ORDERED' and h['requester'].startswith('pm_') and h['ref'] not in used and h['supplier'] in PRIMARY_CONTACT]
    if not rows:
        raise ValueError('scene 5 needs a PO of Request_History at a project site, ORDERED, asked for by its manager')
    h = min(rows, key=lambda x: (x['daysAgo'], x['ref']))
    dept = next(u['department'] for u in USERS if u['code'] == h['requester'])
    receivers = sorted(u['code'] for u in USERS if u['department'] == dept and 'RECEIVER' in (u['roles'] or '').split(','))
    digest = sorted({h['requester'], *receivers})
    return h, digest, sorted({*digest, 'proc_officer'})


def _paid_of(supplier):
    """Scene 6's page of payments (ADR-191): the row of Request_History the history paid this supplier for"""
    from p1_history import build
    rows, _ = build()
    paid = [h for h in rows if h['supplier'] == supplier and h['paymentStatus'] == 'PAID']
    if not paid:
        raise ValueError(f'scene 6 needs a row of Request_History paid to {supplier}')
    return min(paid, key=lambda x: (x['daysAgo'], x['ref']))['ref']


def demo_p2_rows():
    """The scenes of S7 in the shared sheet Demo_Script_P2: dicts of p1_demo.P2_COLUMNS (expectJson as dicts)"""
    ack, told_digest, told_now = _ack_po()
    money = lambda v: f'{v:.2f}'
    return [
        dict(scene=1, core='Y', stage='S7', titleTh='เชิญผู้ขายรายใหม่ ผู้ขายสมัครเองบนมือถือ และอนุมัติผ่าน DOA', actor='proc_sub1', others='proc_mat1 · dm_proc · fin_ap1 · cfo',
             portalActor=None, supplier=None, module='SUPPLIER',
             expectJson={'invite': {'nameTh': 'บริษัท ราชบุรีคอนสตรัคชั่น จำกัด', 'taxId': '0999998020010', 'branchCode': '00000', 'email': 'rcb@supplier.simec.local',
                                    'contactName': 'คุณสมศักดิ์', 'category': 'SUBCON'},
                         'linkDays': 7, 'otpMinutes': 10, 'steps': 6, 'documents': {'COMPANY_CERT': {'issuedOn': '2026-10-20', 'expiresOn': '2027-04-17', 'remindOn': '2027-03-18'}},
                         'bank': {'bankCode': '004', 'last4': '0016'}, 'rule': 'SA-01', 'approver': 'dm_proc', 'bankRule': 'BA-01', 'bankApprover': 'cfo',
                         'numbersFromScreen': ['SUP', 'supplierCode', 'BAC']},
             minutes=8, stepsTh='proc_sub1 เปิด /suppliers/invite กรอกชื่อ เลขผู้เสียภาษี สาขา หมวด และอีเมลผู้ติดต่อ → ผู้ขายเปิดลิงก์บนมือถือ กรอกรหัส 6 หลัก กรอกใบสมัคร 6 ขั้น อัปโหลดหนังสือรับรอง ภ.พ.20 และหน้าสมุดบัญชี → ส่ง → proc_sub1 ยืนยันเอกสาร → proc_mat1 ส่งอนุมัติ → dm_proc อนุมัติจากการ์ด LINE → fin_ap1 รับเรื่องบัญชี โทรยืนยัน แนบหน้าสมุดบัญชีเป็นหลักฐาน (S7-29) ส่งอนุมัติ → cfo อนุมัติพร้อม PIN',
             notes='เลขใบสมัคร รหัสผู้ขายใหม่ และเลขคำขอบัญชีอ่านจากหน้าจอ (ต่อจากข้อมูลใน seed)'),
        dict(scene=2, core='Y', stage='S7', titleTh='ใบสมัครค้าง: เตือนผู้ขาย ส่งต่อจัดซื้อ และหมดอายุ', actor='proc_mat1', others=None,
             portalActor='bpk@supplier.simec.local', supplier='SA-06', module='SUPPLIER',
             expectJson={'application': 'SA-06', 'missing': ['VAT_CERT'], 'notSent': ['VAT_CERT', 'BANK_BOOK'], 'remindAfterBusinessDays': 3, 'escalateAfterBusinessDays': 10, 'expireAfterDays': 30,
                         'escalatedTo': 'proc_mat1', 'badge': 'ค้างเกินกำหนด'},
             minutes=3, stepsTh='proc_mat1 เปิด /suppliers/applications เห็นใบของ หจก. บ้านโป่งเหล็กกล้าค้าเหล็ก ติดแถบค้างเกินกำหนด → เปิดดูรายการที่ยังขาดก่อนส่ง (ภ.พ.20 · หน้าสมุดบัญชีไม่บังคับ BR-SUP ข้อ 11) → ดูอีเมลเตือนใน Mailpit',
             notes='วันที่เตือนและส่งต่อนับจากวันเชิญในข้อมูล (สัมพัทธ์กับวัน seed)'),
        dict(scene=3, core='N', stage='S7', titleTh='ผู้ขายซ้ำ: เลขผู้เสียภาษีและสาขาเดียวกัน', actor='proc_mat1', others=None, portalActor=None, supplier='SP0196', module='SUPPLIER',
             expectJson={'taxId': SUPPLIERS[195]['taxId'], 'branch': '00003', 'error': 'DUPLICATE_SUPPLIER', 'reason': 'DUPLICATE_TAXID', 'otherBranch': '00004',
                         'warnings': ['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME'], 'sameTaxId': ['SP0001', 'SP0196'], 'inviteExisting': 'SP0196'},
             minutes=2, stepsTh='proc_mat1 เชิญผู้ขายด้วยเลขเดียวกับ SP0196 สาขา 00003 → ระบบห้าม → เปลี่ยนเป็นสาขา 00004 → เตือนและขอเหตุผล → เลือก เชิญผู้ขายเดิมเข้าพอร์ทัล',
             notes=None),
        dict(scene=4, core='N', stage='S7', titleTh='เอกสารผู้ขายใกล้หมดอายุ', actor='proc_sub1', others=None, portalActor=PRIMARY_CONTACT['SP0105'], supplier='SP0105', module='SUPPLIER',
             expectJson={'docType': 'COMPANY_CERT', 'expiresInDays': 7, 'reminded': True, 'expiringSuppliers': len(EXPIRING), 'newCopy': {'validityDays': COMPANY_CERT_DAYS}, 'oldCopy': 'SUPERSEDED'},
             minutes=3, stepsTh='ผู้ติดต่อของ SP0105 เปิดอีเมลเตือน → พอร์ทัล เอกสาร → อัปโหลดหนังสือรับรองฉบับใหม่ → proc_sub1 ยืนยัน → ฉบับเดิมเป็น SUPERSEDED',
             notes='หนังสือรับรองของ SP0105 หมดอายุอีก 7 วันนับจากวัน seed (sub-spec เขียนวันตายตัว 2026-05-20 · ไฟล์ใช้วันสัมพัทธ์เพื่อให้จำนวนใกล้หมดอายุคงที่)'),
        dict(scene=5, core='Y', stage='S7', titleTh='ผู้ขายรับทราบ PO และแจ้งวันส่ง', actor=ack['requester'], others=' · '.join(c for c in told_now if c != ack['requester']),
             portalActor=PRIMARY_CONTACT[ack['supplier']], supplier=ack['supplier'], module='SUPPLIER',
             expectJson={'po': {'fromHistory': ack['ref'], 'net': money(ack['net']), 'vat': money(ack['vat']), 'gross': money(ack['gross'])}, 'ack': {'deliverInDays': 6},
                         'move': {'byDays': 2, 'reason': 'โรงงานผลิตไม่ทันรอบแรก'}, 'toldDigest': told_digest, 'toldNow': told_now},
             minutes=3, stepsTh=f'ผู้ติดต่อของ {ack["supplier"]} เปิด /portal/pos บนมือถือ → PO ของ {ack["ref"]} ({ack["title"]}) → รับทราบและแจ้งวันส่ง → เลื่อนวันพร้อมเหตุผล → {ack["requester"]} เห็นในไทม์ไลน์ของ PO',
             notes='PO ของ Request_History ที่ยังรอของ (ADR-191) · วัน demo จริงที่เล่นระยะ 1 ก่อน ใช้ PO ของฉาก 1 ของ Demo_Script_P1 แทนได้'),
        dict(scene=6, core='Y', stage='S7', titleTh='ผู้ขายยื่นใบแจ้งหนี้ผ่านพอร์ทัลและดูสถานะการจ่าย', actor='fin_ap1', others=None, portalActor=PRIMARY_CONTACT['SP0029'],
             supplier='SP0029', module='PAY',
             expectJson={'invoiceNo': 'S00277/A', 'poFromHistory': 'H144', 'channel': 'PORTAL', 'listFilter': 'PORTAL', 'stages': ['DRAFT', 'READY'],
                         'payments': {'paidFromHistory': _paid_of('SP0029'), 'numbersFromScreen': ['PAY']}},
             minutes=4, stepsTh='ผู้ติดต่อของ SP0029 เปิด /portal/invoices/new เลือก PO ของ H144 แนบ PDF กรอกเลขที่ วันที่ VAT → fin_ap1 กรองช่องทาง จากพอร์ทัล ยืนยันรหัสบัญชีและส่งจับคู่ → ผู้ขายเห็น พร้อมจ่าย ครบกำหนด → หน้า การจ่ายเงิน เห็นรอบที่ประวัติจ่ายผู้ขายรายนี้ (เลขรอบอ่านจากหน้าจอ)',
             notes='หน้าการจ่ายเงินเห็นรอบที่ประวัติจ่ายผู้ขายรายนี้ (ADR-191) · เล่นหลังฉาก 11 ของ Demo_Script_P1 จะเห็นรอบของฉากนั้นเพิ่ม'),
        dict(scene=7, core='N', stage='S7', titleTh='KPI G-7 ระยะเวลาขึ้นทะเบียนผู้ขาย', actor='dm_proc', others=None, portalActor=None, supplier=None, module='SUPPLIER',
             expectJson={'g7Median': '3.6', 'approved': [a['expectedG7Days'] for a in SUPPLIER_APPLICATIONS if a['status'] == 'APPROVED'], 'afterScene1Median': '2.1'},
             minutes=2, stepsTh='dm_proc เปิด /reports/suppliers เห็นมัธยฐาน 3.6 วันทำการ แยกสมัครเองและกรอกแทน',
             notes='เล่นก่อนฉาก 1 หรือดูช่วงถึงเมื่อวาน ถ้าเล่นหลังฉาก 1 ในวันเดียวกัน มัธยฐานเป็น 2.1'),
        dict(scene=8, core='N', stage='S7', titleTh='AI อ่านเอกสารผู้ขายและเติมใบสมัคร', actor='proc_sub1', others=None, portalActor=None, supplier=None, module='AI',
             expectJson={'purpose': 'SUPPLIER_DOC_READ', 'agent': 'SUPPLIER_ONBOARDING', 'nameConfidenceBp': 9200, 'addressMismatch': 'REGISTRY_ADDRESS_MISMATCH', 'capBp': 5000,
                         'noAccountNo': True},
             minutes=3, stepsTh='ในฉาก 1 เมื่อผู้ขายอัปโหลดหนังสือรับรอง พอร์ทัลแสดงค่าที่ AI อ่านได้พร้อมป้าย เติมโดย AI โปรดตรวจ → ผู้ขายยืนยันทีละช่อง',
             notes='ปิด AI แล้วฉาก 1 ยังทำครบด้วยการกรอกเอง (EG-1)'),
    ]
