# -*- coding: utf-8 -*-
"""The supplier-risk sheets of the synthetic workbook (S11-12 · docs/sub-specs/S11.md "การอ่านชีตของไฟล์ระยะ 1").

Risk_Tiers Risk_Policy Risk_Questionnaire are the draft values of SIMEC (OQ-221 OQ-222 OQ-226 OQ-227 · the same numbers
as the fixtures of golden suite risk-tier) · Risk_Reviewers are rules RR-01 to RR-04 of WF-SIMEC version 1 (OQ-223 ·
fixture risk-reviewers) · Risk_Assessments Risk_Overrides are synthetic: the seed plays them through the real commands
back in time (completed ones and the overrides before Request_History, open ones after it).

Dates are relative to the day of the seed (daysAgo) except completedOn, a fixed day for the rows a scene names (SP0132:
the reassessment scene needs its validity to end on 2026-12-15). G-9 of the history (BR-RSK-15) comes out of these rows
with the policy below: 4 suppliers whose first PO is HIGH (SP0132 SP0141 SP0158 SP0165), 3 of them by an assessment.
"""
import json
from datetime import date

TIER_COLUMNS = [
    ('code', 'ระดับ LOW MEDIUM HIGH'), ('nameTh', 'ชื่อไทย'), ('nameEn', 'ชื่ออังกฤษ'), ('minPoints', 'คะแนนขั้นต่ำของระดับ (LOW = 0)'),
    ('reviewMonths', 'ประเมินซ้ำทุกกี่เดือน'), ('reminderDaysBefore', 'เตือนก่อนครบรอบกี่วัน'),
    ('blocksPo', 'Y = ต้องประเมินเสร็จก่อนออก PO'), ('requiresExplicitAnswers', 'Y = ทุกข้อต้องยืนยันเอง (หลักฐานอย่างเดียวไม่พอ)'),
]
RISK_TIERS = [  # OQ-221 OQ-226
    ('LOW', 'ต่ำ', 'Low', 0, 36, 30, 'N', 'N'),
    ('MEDIUM', 'กลาง', 'Medium', 20, 24, 30, 'N', 'N'),
    ('HIGH', 'สูง', 'High', 40, 12, 30, 'Y', 'Y'),
]

POLICY_COLUMNS = [
    ('screeningTierMap', 'คำตอบคัดกรองที่เป็น Y → ระดับตั้งต้น (field:TIER คั่นด้วย ,)'),
    ('highRiskCategories', 'หมวดรายการที่ถือเป็นความเสี่ยงสูงตั้งต้น (คั่นด้วย ,)'),
    ('registryFlagBlocks', 'Y = ผู้ขายติดธงทะเบียนออก PO ใหม่ไม่ได้'),
    ('mediumOverdueBlocks', 'Y = ผู้ขายระดับกลางที่เกินรอบออก PO ไม่ได้'),
    ('overrideChatButton', 'Y = อนุมัติข้ามจากปุ่มในแชทได้'),
]
RISK_POLICY = [  # OQ-222 OQ-225 OQ-226 OQ-227
    ('processesPersonalData:HIGH,accessesSystems:MEDIUM,accessesPremises:MEDIUM', 'PROF', 'Y', 'N', 'N'),
]

QUESTION_COLUMNS = [
    ('code', 'รหัสคำถาม (RQ-ด้าน-เลข)'), ('domain', 'ด้าน GENERAL PRIVACY INFOSEC PREMISES FINANCE'), ('textTh', 'คำถาม (ไทย · สังเคราะห์)'),
    ('textEn', 'คำถาม (อังกฤษ)'), ('kind', 'ชนิดคำตอบ'), ('optionsJson', 'ตัวเลือก [{code labelTh labelEn points minTier? evidence?}]'),
    ('appliesWhenJson', 'เข้าชุดเมื่อ (ว่าง = ทุกใบ)'), ('required', 'Y = ต้องตอบ'), ('evidenceScopeRequired', 'Y = หลักฐานต้องมีขอบเขตตรง'),
    ('evidenceScope', 'ขอบเขตของหลักฐาน'), ('aiReadable', 'Y = ให้ AI อ่านเอกสารประกอบข้อนี้ได้ (OQ-228)'), ('sortOrder', 'ลำดับ'),
]


def _opt(code, th, en, points, **extra):
    return {'code': code, 'labelTh': th, 'labelEn': en, 'points': points, **extra}


_YN = lambda y, n, **ye: [_opt('Y', 'มี', 'Yes', y, **ye), _opt('N', 'ไม่มี', 'No', n)]
_NY = lambda n, y: [_opt('N', 'ไม่ใช่', 'No', n), _opt('Y', 'ใช่', 'Yes', y)]
_WHEN = {
    'PD': {'field': 'processesPersonalData', 'op': 'eq', 'value': 'Y'},
    'SYS': {'field': 'accessesSystems', 'op': 'eq', 'value': 'Y'},
    'PRM': {'field': 'accessesPremises', 'op': 'eq', 'value': 'Y'},
    'HIGH': {'field': '$inherentTier', 'op': 'eq', 'value': 'HIGH'},
}
_QUESTIONS = [  # code, domain, textTh, textEn, options, when, evidenceScope, aiReadable (draft of SIMEC · OQ-221 · ข้อความสังเคราะห์)
    ('RQ-GEN-01', 'GENERAL', 'บริษัทดำเนินกิจการมานานเท่าใด', 'How long has the company been in business?',
     [_opt('A', '5 ปีขึ้นไป', '5 years or more', 0), _opt('B', '2 ถึง 5 ปี', '2 to 5 years', 5), _opt('C', 'น้อยกว่า 2 ปี', 'Less than 2 years', 10)], None, None, 'N'),
    ('RQ-GEN-02', 'GENERAL', 'มูลค่างานกับบริษัทต่อปีที่คาด', 'Expected yearly value of work with us',
     [_opt('A', 'ไม่เกิน 1 ล้านบาท', 'Up to 1 million baht', 0), _opt('B', '1 ถึง 10 ล้านบาท', '1 to 10 million baht', 5), _opt('C', 'เกิน 10 ล้านบาท', 'Over 10 million baht', 10)], None, None, 'N'),
    ('RQ-GEN-03', 'GENERAL', 'มีประกันภัยความรับผิดต่อบุคคลภายนอก', 'Does the company hold third-party liability insurance?', _YN(0, 8), None, None, 'N'),
    ('RQ-PRV-01', 'PRIVACY', 'จำนวนเจ้าของข้อมูลส่วนบุคคลที่จะประมวลผลแทนบริษัท', 'How many data subjects will you process for us?',
     [_opt('A', 'น้อยกว่า 1,000 คน', 'Fewer than 1,000', 5), _opt('B', '1,000 ถึง 10,000 คน', '1,000 to 10,000', 10),
      _opt('C', 'มากกว่า 10,000 คน', 'More than 10,000', 15, minTier='HIGH')], 'PD', None, 'N'),
    ('RQ-PRV-02', 'PRIVACY', 'มีนโยบายคุ้มครองข้อมูลส่วนบุคคลและยอมลงนามข้อตกลงประมวลผลข้อมูล (DPA)', 'Do you have a PDPA policy and will you sign a DPA?', _YN(0, 12), 'PD', None, 'Y'),
    ('RQ-PRV-03', 'PRIVACY', 'มีการโอนข้อมูลส่วนบุคคลออกนอกประเทศ', 'Will personal data be transferred abroad?', _NY(0, 10), 'PD', None, 'N'),
    ('RQ-IS-01', 'INFOSEC', 'มีใบรับรอง ISO/IEC 27001 ที่ครอบขอบเขตงาน', 'Do you hold ISO/IEC 27001 covering the work?', _YN(0, 12, evidence=True), 'SYS', 'ISO 27001', 'N'),
    ('RQ-IS-02', 'INFOSEC', 'บังคับยืนยันตัวตนหลายขั้นตอน (MFA) สำหรับผู้ใช้ที่เข้าระบบของบริษัท', 'Is MFA enforced for users who access our systems?', _YN(0, 8), 'SYS', None, 'Y'),
    ('RQ-IS-03', 'INFOSEC', 'มีแผนรับมือเหตุการณ์ด้านความปลอดภัยและแจ้งบริษัทภายใน 72 ชั่วโมง', 'Do you have an incident response plan with notice to us within 72 hours?', _YN(0, 6), 'SYS', None, 'Y'),
    ('RQ-PRM-01', 'PREMISES', 'พนักงานที่เข้าพื้นที่ผ่านอบรมความปลอดภัยและมีบัตรประจำตัว', 'Are staff entering our sites safety-trained and badged?', _YN(0, 8), 'PRM', None, 'N'),
    ('RQ-PRM-02', 'PREMISES', 'มีใบรับรอง ISO 45001 ที่ครอบงานที่จ้าง', 'Do you hold ISO 45001 covering the work?', _YN(0, 6, evidence=True), 'PRM', 'ISO 45001', 'N'),
    ('RQ-FIN-01', 'FINANCE', 'มีงบการเงินที่ผู้สอบบัญชีรับรองของปีล่าสุด', 'Do you have audited financial statements for the latest year?', _YN(0, 10), 'HIGH', None, 'N'),
]
RISK_QUESTIONNAIRE = [
    (code, domain, th, en, 'SINGLE_CHOICE', json.dumps(opts, ensure_ascii=False), json.dumps(_WHEN[when]) if when else None, 'Y',
     'Y' if scope else 'N', scope, ai, (i + 1) * 10)
    for i, (code, domain, th, en, opts, when, scope, ai) in enumerate(_QUESTIONS)
]
# What each answer is worth, for the expected columns below and the validator's calculator
POINTS = {code: {o['code']: o['points'] for o in opts} for code, _, _, _, opts, _, _, _ in _QUESTIONS}

REVIEWER_COLUMNS = [
    ('ruleCode', 'รหัสข้อ'), ('conditionTh', 'เงื่อนไข'), ('reviewerPosition', 'ตำแหน่งผู้ตรวจ'), ('reviewerDepartment', 'แผนกผู้ตรวจ'),
    ('fallbackPosition', 'ตำแหน่งสำรอง (ไม่มีผู้ตรวจ)'), ('fallbackDepartment', 'แผนกสำรอง'), ('riskDomains', 'ด้านที่ตรวจ (คั่นด้วย ,)'),
    ('slaBusinessHours', 'SLA ชั่วโมงทำการ'), ('whenJson', 'เงื่อนไขแบบที่ระบบอ่าน'), ('descriptionTh', 'คำอธิบาย'),
]
RISK_REVIEWERS = [  # OQ-223 · = tests/golden/fixtures/risk-reviewers.yaml
    ('RR-01', 'ผู้ขายประมวลผลข้อมูลส่วนบุคคล', 'DM', 'LEG', 'VP', 'SUP', 'PRIVACY', 16, json.dumps(_WHEN['PD']), 'ฝ่ายกฎหมายตรวจด้านข้อมูลส่วนบุคคล'),
    ('RR-02', 'ผู้ขายเข้าถึงระบบของบริษัท', 'DM', 'IT', 'VP', 'SUP', 'INFOSEC', 16, json.dumps(_WHEN['SYS']), 'ฝ่ายไอทีตรวจด้านความปลอดภัยสารสนเทศ'),
    ('RR-03', 'ผู้ขายเข้าพื้นที่ของบริษัท', 'DM', 'QSE', 'VP', 'OPS', 'PREMISES', 16, json.dumps(_WHEN['PRM']), 'ฝ่ายความปลอดภัยตรวจด้านพื้นที่'),
    ('RR-04', 'ระดับความเสี่ยงสูง', 'DM', 'FIN', 'CFO', 'HQ', 'FINANCE', 16, json.dumps({'field': '$tier', 'op': 'eq', 'value': 'HIGH'}), 'ฝ่ายบัญชีตรวจฐานะการเงินของผู้ขายระดับสูง'),
]

ASSESSMENT_COLUMNS = [
    ('ref', 'รหัสแถว'), ('supplierCode', 'ผู้ขาย'), ('screeningJson', 'คำตอบคัดกรอง 3 ข้อ'), ('categoryCodes', 'หมวดงาน (คั่นด้วย ,)'),
    ('workScopes', 'ขอบเขตงานที่ต้องการหลักฐาน (คั่นด้วย ,)'), ('openedBy', 'ผู้เปิดใบ (จัดซื้อ)'),
    ('openedDaysAgo', 'เปิดกี่วันก่อนวัน seed (แถวที่มี completedOn: กี่วันก่อน completedOn)'), ('answersJson', 'คำตอบ {รหัสคำถาม: ตัวเลือก}'),
    ('filledOnBehalf', 'จัดซื้อกรอกแทน (ว่าง = ผู้ติดต่อของผู้ขายตอบในพอร์ทัล)'), ('status', 'COMPLETED IN_REVIEW RETURNED DRAFT CANCELLED'),
    ('completedDaysAgo', 'เสร็จกี่วันก่อนวัน seed'), ('completedOn', 'วันเสร็จตายตัว (ใช้แทน completedDaysAgo)'),
    ('expectedPoints', 'คะแนนที่คาด'), ('expectedTier', 'ระดับที่คาด'), ('expectedValidUntil', 'ใช้ได้ถึง (วันที่ · หรือ +nM = n เดือนหลังวันเสร็จ)'),
    ('reviewers', 'ผู้ตรวจที่ตัดสิน (คั่นด้วย ·)'),
]

_S = lambda pd='N', sys='N', prm='N': {'processesPersonalData': pd, 'accessesSystems': sys, 'accessesPremises': prm}
_GOOD = {'RQ-GEN-01': 'A', 'RQ-GEN-02': 'A', 'RQ-GEN-03': 'Y'}
# ref, supplier, screening, categories, workScopes, openedBy, openedDaysAgo, answers, filledOnBehalf, status, completedDaysAgo,
# completedOn, reviewers (expectedPoints, expectedTier and expectedValidUntil are worked out below from the answers)
_ROWS = [
    # HIGH · completed before the first PO of their history (G-9: 3 of 4 by an assessment)
    ('RA-01', 'SP0132', _S(prm='Y'), 'SERV', '', 'proc_sub1', 14,
     {'RQ-GEN-01': 'C', 'RQ-GEN-02': 'C', 'RQ-GEN-03': 'N', 'RQ-PRM-01': 'N', 'RQ-PRM-02': 'N'}, None, 'COMPLETED', None, date(2025, 12, 15), ''),
    ('RA-02', 'SP0158', _S(prm='Y'), 'PROF', '', 'proc_sub1', 172,
     {**_GOOD, 'RQ-GEN-02': 'B', 'RQ-PRM-01': 'Y', 'RQ-PRM-02': 'N', 'RQ-FIN-01': 'Y'}, None, 'COMPLETED', 160, None, 'dm_qse · dm_fin'),
    ('RA-03', 'SP0165', _S(prm='Y'), 'PROF', '', 'proc_sub2', 203,
     {**_GOOD, 'RQ-PRM-01': 'Y', 'RQ-PRM-02': 'N', 'RQ-FIN-01': 'Y'}, None, 'COMPLETED', 190, None, 'dm_qse · dm_fin'),
    # HIGH · professional services with no row in Request_History (out of G-9, no PO of the history to gate)
    ('RA-04', 'SP0159', _S(pd='Y'), 'PROF', '', 'proc_sub1', 131,
     {**_GOOD, 'RQ-PRV-01': 'A', 'RQ-PRV-02': 'Y', 'RQ-PRV-03': 'N', 'RQ-FIN-01': 'Y'}, None, 'COMPLETED', 120, None, 'dm_leg · dm_fin'),
    ('RA-05', 'SP0161', _S(sys='Y'), 'PROF', '', 'proc_sub2', 104,
     {**_GOOD, 'RQ-IS-01': 'N', 'RQ-IS-02': 'Y', 'RQ-IS-03': 'Y', 'RQ-FIN-01': 'Y'}, 'proc_sub2', 'COMPLETED', 95, None, 'dm_it · dm_fin'),
    ('RA-06', 'SP0162', _S(prm='Y'), 'PROF', '', 'proc_sub1', 248,
     {**_GOOD, 'RQ-GEN-01': 'B', 'RQ-PRM-01': 'Y', 'RQ-PRM-02': 'N', 'RQ-FIN-01': 'N'}, None, 'COMPLETED', 240, None, 'dm_qse · dm_fin'),
    ('RA-07', 'SP0164', _S(), 'PROF', '', 'proc_sub2', 40, {**_GOOD, 'RQ-FIN-01': 'Y'}, None, 'COMPLETED', 30, None, 'dm_fin'),
    # MEDIUM · completed before the first PO of their history (a MEDIUM supplier changes no gate and is out of G-9)
    ('RA-08', 'SP0144', _S(sys='Y'), 'IT', '', 'proc_sub1', 210, {**_GOOD, 'RQ-GEN-02': 'B', 'RQ-IS-01': 'N', 'RQ-IS-02': 'Y', 'RQ-IS-03': 'Y'}, 'proc_sub1', 'COMPLETED', 200, None, 'dm_it'),
    ('RA-09', 'SP0146', _S(sys='Y'), 'IT', '', 'proc_sub1', 221, {**_GOOD, 'RQ-IS-01': 'N', 'RQ-IS-02': 'N', 'RQ-IS-03': 'Y'}, None, 'COMPLETED', 210, None, 'dm_it'),
    ('RA-10', 'SP0150', _S(sys='Y'), 'IT', '', 'proc_sub2', 238, {**_GOOD, 'RQ-GEN-01': 'B', 'RQ-IS-01': 'N', 'RQ-IS-02': 'Y', 'RQ-IS-03': 'N'}, 'proc_sub2', 'COMPLETED', 230, None, 'dm_it'),
    ('RA-11', 'SP0076', _S(prm='Y'), 'RENT', '', 'proc_sub1', 190, {'RQ-GEN-01': 'B', 'RQ-GEN-02': 'B', 'RQ-GEN-03': 'Y', 'RQ-PRM-01': 'Y', 'RQ-PRM-02': 'N', }, None, 'COMPLETED', 180, None, 'dm_qse'),
    ('RA-12', 'SP0068', _S(prm='Y'), 'RENT', '', 'proc_sub2', 158, {'RQ-GEN-01': 'A', 'RQ-GEN-02': 'B', 'RQ-GEN-03': 'N', 'RQ-PRM-01': 'Y', 'RQ-PRM-02': 'N'}, 'proc_sub2', 'COMPLETED', 150, None, 'dm_qse'),
    ('RA-13', 'SP0133', _S(prm='Y'), 'SERV', '', 'proc_sub1', 68, {'RQ-GEN-01': 'B', 'RQ-GEN-02': 'A', 'RQ-GEN-03': 'Y', 'RQ-PRM-01': 'N', 'RQ-PRM-02': 'N'}, None, 'COMPLETED', 60, None, 'dm_qse'),
    ('RA-14', 'SP0136', _S(prm='Y'), 'LAB', '', 'proc_sub2', 148, {'RQ-GEN-01': 'C', 'RQ-GEN-02': 'A', 'RQ-GEN-03': 'Y', 'RQ-PRM-01': 'Y', 'RQ-PRM-02': 'N'}, None, 'COMPLETED', 140, None, 'dm_qse'),
    ('RA-15', 'SP0181', _S(prm='Y'), 'MKTG', '', 'proc_sub1', 178, {'RQ-GEN-01': 'A', 'RQ-GEN-02': 'C', 'RQ-GEN-03': 'Y', 'RQ-PRM-01': 'Y', 'RQ-PRM-02': 'N'}, 'proc_sub1', 'COMPLETED', 170, None, 'dm_qse'),
    ('RA-16', 'SP0122', _S(prm='Y'), 'TRANS', '', 'proc_sub2', 143, {'RQ-GEN-01': 'B', 'RQ-GEN-02': 'A', 'RQ-GEN-03': 'N', 'RQ-PRM-01': 'Y', 'RQ-PRM-02': 'N'}, None, 'COMPLETED', 135, None, 'dm_qse'),
    # open ones, played after the history (suppliers with no PO of the history, except SP0141 of the scenes)
    ('RA-17', 'SP0157', _S(sys='Y'), 'IT', '', 'proc_sub1', 6, {**_GOOD, 'RQ-IS-01': 'N', 'RQ-IS-02': 'Y', 'RQ-IS-03': 'Y'}, None, 'IN_REVIEW', None, None, 'dm_it'),
    ('RA-18', 'SP0163', _S(prm='Y'), 'SERV', '', 'proc_sub2', 9, {**_GOOD, 'RQ-PRM-01': 'N', 'RQ-PRM-02': 'N'}, None, 'RETURNED', None, None, 'dm_qse'),
    ('RA-19', 'SP0141', _S(pd='Y', sys='Y'), 'IT', 'ISO 27001', 'proc_officer', 3, {}, None, 'DRAFT', None, None, ''),
    ('RA-20', 'SP0154', _S(), 'MAT', '', 'proc_sub1', 20, {}, None, 'CANCELLED', None, None, ''),
]

_TIER_ORDER = {'LOW': 0, 'MEDIUM': 1, 'HIGH': 2}
_TIER_OF_POINTS = sorted(((t[3], t[0]) for t in RISK_TIERS), reverse=True)
_REVIEW_MONTHS = {t[0]: t[4] for t in RISK_TIERS}
_HIGH_CATEGORIES = set(RISK_POLICY[0][1].split(','))
_SCREEN_TIER = dict(p.split(':') for p in RISK_POLICY[0][0].split(','))


def _max(a, b):
    return a if _TIER_ORDER[a] >= _TIER_ORDER[b] else b


def score(screening, categories, answers):
    """scoreAssessment of src/core/risk/score.ts on the draft questionnaire: (points, tier)"""
    inherent = 'LOW'
    for field, tier in _SCREEN_TIER.items():
        if screening.get(field) == 'Y':
            inherent = _max(inherent, tier)
    if any(c in _HIGH_CATEGORIES for c in categories):
        inherent = 'HIGH'
    points, floor = 0, 'LOW'
    for code, _, _, _, opts, when, _, _ in _QUESTIONS:
        w = _WHEN[when] if when else None
        if w and not ((w['field'] == '$inherentTier' and inherent == w['value']) or screening.get(w['field']) == w['value']):
            continue
        opt = next((o for o in opts if o['code'] == answers.get(code)), None)
        if opt:
            points += opt['points']
            if opt.get('minTier'):
                floor = _max(floor, opt['minTier'])
    by_points = next(t for m, t in _TIER_OF_POINTS if points >= m)
    return points, _max(_max(by_points, inherent), floor)


def _assessment(row):
    ref, sup, scr, cats, scopes, opener, opened, answers, behalf, status, cdays, con, reviewers = row
    done = status == 'COMPLETED'
    points, tier = score(scr, cats.split(','), answers) if done else (None, None)
    until = None
    if done:
        until = con.replace(year=con.year + _REVIEW_MONTHS[tier] // 12) if con else f'+{_REVIEW_MONTHS[tier]}M'
    return {'ref': ref, 'supplierCode': sup, 'screeningJson': json.dumps(scr), 'categoryCodes': cats, 'workScopes': scopes or None,
            'openedBy': opener, 'openedDaysAgo': opened, 'answersJson': json.dumps(answers) if answers else None, 'filledOnBehalf': behalf,
            'status': status, 'completedDaysAgo': cdays, 'completedOn': con, 'expectedPoints': points, 'expectedTier': tier,
            'expectedValidUntil': until, 'reviewers': reviewers or None}


RISK_ASSESSMENTS = [_assessment(r) for r in _ROWS]

OVERRIDE_COLUMNS = [
    ('ref', 'เลขที่คาด (รันตามวันขอ)'), ('supplierCode', 'ผู้ขาย'), ('poRef', 'PO ของประวัติที่ใช้ (Request_History)'),
    ('capGross', 'เพดานยอดรวม VAT สะสม (บาท)'), ('expiresDaysAhead', 'หมดอายุกี่วันหลังวันขอ (≤ 90)'), ('requestedBy', 'ผู้ขอ'),
    ('requestedDaysAgo', 'ขอกี่วันก่อนวัน seed'), ('status', 'สถานะ ณ วัน seed'), ('approver', 'ผู้อนุมัติตาม DOA'), ('reason', 'เหตุผล'),
]
RISK_OVERRIDES = [  # ADR-226 · BR-RSK-10 · RO-01 (COO up to 1,000,000)
    ('RO-2569-00001', 'SP0141', 'H047', 150000, 90, 'proc_officer', 125, 'EXPIRED', 'coo', 'ระบบงานบัญชีต้องขึ้นก่อนปิดไตรมาส ผู้ขายรายเดียวที่รองรับ ประเมินไม่ทัน'),
    ('RO-2569-00002', 'SP0179', 'H130', 100000, 60, 'proc_officer', 100, 'EXPIRED', 'coo', 'อบรมพนักงานเร่งด่วน รอผลประเมินไม่ทัน'),
]
