# -*- coding: utf-8 -*-
"""Synthetic purchase history (sheet History) and the ground truth of the AI evaluation documents (sheet DocSamples).

History rows follow the shape of the demo sheet Demo_History (spec §16.10 · D-01) with phase-1 columns added:
line detail (item, quantity, unit price), the form answers, a FY-free budget key, and invoice and payment hints for
S8/S9. Dates are relative (daysAgo) so the data always looks current; every decided row leaves enough business time
before "now" (p1_common.guaranteed_business_hours) for the seed to replay it on any run date.
The expected DOA route of every row is computed here from the DOA sheet and checked again, independently, by
scripts/validate_inputs.py --profile p1.
"""
import json
from decimal import Decimal, ROUND_HALF_UP
from p1_common import rng, sat, vat_of, baht, rhu, guaranteed_business_hours, VAT_BP
from p1_org import USERS, USER_BY_CODE, DEPT_PARENT, HOLDERS, PROJECTS, ROOT, ORG_TAXID, DEPARTMENTS
from p1_master import BUDGET_KEYS, DOA_RULES, DOA_POLICY, SITE_OF_PROJECT
from p1_suppliers import ITEMS_BY_CODE, ITEMS, SUPPLIERS, SUPPLIERS_BY_CAT, INACTIVE, PAYMENT_BY_SUPPLIER

STEP_UP = sat(dict((k, v) for k, v, _, _ in DOA_POLICY)['stepUpThreshold'])
PR_RULES = sorted([r for r in DOA_RULES if r[2] == 'PURCHASE_REQUEST'], key=lambda r: r[3] or 0)
EXTRA_HOURS = {'APPROVED': 1, 'REJECTED': 1, 'RETURNED': 1, 'CANCELLED': 1, 'ORDERED': 6, 'COMPLETED': 34}
SUPPLIER_BY_CODE = {s['code']: s for s in SUPPLIERS}
SHORT = {c: s for c, _, s, _ in PROJECTS}
DEPT_NAME = {d[0]: d[1] for d in DEPARTMENTS}


def _approver(rule, dept):
    kind, pos = rule[5], rule[6]
    d = dept if kind == 'POSITION_OF_DEPARTMENT' else ROOT
    while d:
        if (pos, d) in HOLDERS:
            return HOLDERS[(pos, d)]
        if kind == 'POSITION_OF_ORG':
            return None
        d = DEPT_PARENT.get(d)
    return None


def route(gross, requester, dept):
    """PR route under DOA version 1 (BR-DOA-02 to BR-DOA-06): (rule, approver, escalated, sla hours)."""
    top = next(r for r in PR_RULES if (r[3] is None or gross > sat(r[3])) and (r[4] is None or gross <= sat(r[4])))
    ap, esc = _approver(top, dept), 'N'
    if ap is None:
        raise ValueError(f'no approver for {top[1]} at {dept}')
    if ap == requester:
        for r in PR_RULES[PR_RULES.index(top) + 1:]:
            a2 = _approver(r, dept)
            if a2 is None:
                raise ValueError(f'no approver for {r[1]} at {dept}')
            if a2 != requester:
                ap, esc = a2, 'Y'
                break
        else:
            raise ValueError(f'{requester} has no higher authority')
    return top[1], ap, esc, top[8]


def _price(item):
    return Decimal(str(item['refUnitPrice']))


def _qty_for(item, target, r):
    unit = item['unit']
    price = _price(item)
    if unit in ('งาน', 'กรมธรรม์', 'งวด'):
        return 1, Decimal(int(Decimal(target) / 100) * 100)
    qty = max(1, int(Decimal(target) / price))
    if price != price.to_integral_value():  # keep the line net in whole baht (BR-MONEY-02, quotation 104 %/107 %)
        while (qty * price) % 1 != 0:
            qty += 1
    return qty, price


PHASES = ['ชั้น 1–5', 'ชั้น 6–12', 'ชั้น 13–18', 'งานฐานราก', 'โซน A', 'โซน B', 'ช่วงที่ 1', 'ช่วงที่ 2', 'อาคารจอดรถ', 'งานภายนอก']


def _form(rtype, item, qty, site_name, r, personal='N'):
    if rtype == 'HIRE_SERVICE':
        period = {'เดือน': f'{qty} เดือน', 'คน-เดือน': '6 เดือน', 'วัน': f'{qty} วัน', 'ปี': '12 เดือน'}.get(item['unit'], '1 ครั้ง')
        return {'scopeOfWork': f'{item["nameTh"]} ที่{site_name}', 'servicePeriod': period, 'processesPersonalData': personal,
                'accessesSystems': 'Y' if item['category'] == 'IT' else 'N', 'accessesPremises': 'Y'}
    if rtype == 'CONTRACT_WORK':
        return {'scopeOfWork': f'{item["nameTh"]} ตามแบบและรายการประกอบแบบ', 'site': site_name,
                'milestones': 'งวดที่ 1 30% เมื่อเริ่มงานและส่งแผนงาน · งวดที่ 2 40% เมื่องานเสร็จ 70% · งวดที่ 3 30% เมื่อส่งมอบงาน (หักประกันผลงาน 5%)'}
    if rtype == 'IT_PURCHASE':
        soft = item['isService'] == 'Y'
        return {'category': 'SOFTWARE' if soft else 'HARDWARE', 'processesPersonalData': personal,
                'accessesSystems': 'Y' if soft else 'N', 'accessesPremises': 'N'}
    return None


def _templates():
    """(weight, requesters, budget key, request type, item codes, net range in baht, site)."""
    t = []
    for code, dept, short, _ in PROJECTS:
        p = code.lower()
        staff = [u['code'] for u in USERS if u['code'].endswith(('_' + p, '_' + p + 'a', '_' + p + 'b')) and not u['code'].startswith('pm_')]
        pm = [f'pm_{p}']
        site = SITE_OF_PROJECT[code]
        mat = [i['code'] for i in ITEMS if i['category'] in ('MAT', 'STEEL', 'RMC', 'ELEC', 'PLUMB', 'FINISH')]
        t += [(5, staff, f'{code}-MAT', 'BUY_GOODS', mat, (4_000, 380_000), site),
              (1.2, staff, f'{code}-MAT', 'BUY_GOODS', [i['code'] for i in ITEMS if i['category'] == 'SAFETY'], (3_000, 30_000), site),
              (2, staff + pm, f'{code}-RENT', 'HIRE_SERVICE', [i['code'] for i in ITEMS if i['category'] in ('RENT', 'TRANS')], (12_000, 260_000), site),
              (1.3, pm, f'{code}-SUB', 'CONTRACT_WORK', [i['code'] for i in ITEMS if i['category'] == 'SUBCON'], (250_000, 4_800_000), site),
              (0.8, pm + staff, f'{code}-SUB', 'HIRE_SERVICE', [i['code'] for i in ITEMS if i['category'] in ('SUBIND', 'LAB')], (8_000, 180_000), site)]
    t += [
        (1.5, ['eng_01', 'eng_02', 'eng_03', 'eng_04', 'eng_05'], 'ENG-OPEX', 'IT_PURCHASE', ['SWL-001', 'SWL-002'], (68_500, 340_000), 'HQ-STORE'),
        (1, ['eng_01', 'eng_02', 'eng_04'], 'ENG-OPEX', 'HIRE_SERVICE', ['LAB-003', 'LAB-004', 'PRF-003'], (22_000, 380_000), 'HQ-STORE'),
        (1, ['mep_01', 'mep_02', 'mep_03', 'mep_04'], 'MEP-OPEX', 'BUY_GOODS', ['ELE-005', 'ELE-006', 'PLB-004'], (3_000, 60_000), 'HQ-STORE'),
        (2, ['mnt_01', 'mnt_02', 'mnt_03'], 'EQP-MNT-OPEX', 'BUY_GOODS', [i['code'] for i in ITEMS if i['category'] == 'PARTS'], (2_000, 160_000), 'EQP-YARD'),
        (1, ['yard_01', 'yard_02'], 'EQP-YRD-OPEX', 'HIRE_SERVICE', ['SRV-001', 'SRV-003'], (6_000, 120_000), 'EQP-YARD'),
        (1.5, ['qse_01', 'qse_02', 'qse_03', 'qse_04'], 'QSE-OPEX', 'BUY_GOODS', [i['code'] for i in ITEMS if i['category'] == 'SAFETY'], (4_000, 90_000), 'CENTRAL-WH'),
        (1, ['qse_01', 'qse_02'], 'QSE-OPEX', 'HIRE_SERVICE', ['TRA-001', 'TRA-002'], (14_000, 130_000), 'HQ-STORE'),
        (0.8, ['proc_officer'], 'PROC-OPEX', 'BUY_GOODS', ['OFF-001', 'OFF-003'], (2_000, 18_000), 'HQ-STORE'),
        (0.6, ['fin_officer'], 'FIN-OPEX', 'HIRE_SERVICE', ['PRF-005'], (60_000, 120_000), 'HQ-STORE'),
        (1, ['hr_01', 'hr_02', 'hr_03'], 'HRA-OPEX', 'HIRE_SERVICE', ['TRA-001', 'TRA-003'], (10_000, 110_000), 'HQ-STORE'),
        (2, ['ga_01', 'ga_02', 'ga_03'], 'HRA-GA-OPEX', 'BUY_GOODS', ['OFF-001', 'OFF-002', 'OFF-003', 'OFF-004'], (1_500, 45_000), 'HQ-STORE'),
        (1, ['ga_02', 'ga_03'], 'HRA-GA-OPEX', 'HIRE_SERVICE', ['SRV-002', 'SRV-004', 'SRV-005'], (30_000, 290_000), 'HQ-STORE'),
        (1.5, ['it_01', 'it_02', 'it_03'], 'IT-CAPEX', 'IT_PURCHASE', [i['code'] for i in ITEMS if i['code'].startswith('ITM')], (5_000, 260_000), 'HQ-STORE'),
        (1, ['it_01', 'it_02', 'it_03'], 'IT-OPEX', 'IT_PURCHASE', ['SWL-003', 'SWL-005'], (2_990, 95_000), 'HQ-STORE'),
        (0.6, ['leg_01', 'leg_02'], 'LEG-OPEX', 'HIRE_SERVICE', ['PRF-002'], (45_000, 135_000), 'HQ-STORE'),
        (0.4, ['auditor', 'ia_01'], 'IA-OPEX', 'HIRE_SERVICE', ['TRA-003'], (18_000, 36_000), 'HQ-STORE'),
        (0.8, ['est_01', 'est_02', 'est_03', 'est_04'], 'EST-OPEX', 'BUY_GOODS', ['OFF-004', 'OFF-002'], (2_000, 25_000), 'HQ-STORE'),
        (0.6, ['eqp_01'], 'EQP-OPEX', 'BUY_GOODS', ['FUL-002', 'FUL-003', 'PRT-002'], (9_000, 150_000), 'EQP-YARD'),
    ]
    return t


def _site_name(site):
    from p1_master import SITES
    return next(n for c, n, _ in SITES if c == site)


class _Builder:
    def __init__(self):
        self.r = rng('history')
        self.rows, self.titles, self.used = [], set(), {k: 0 for k in BUDGET_KEYS}
        self.inv_seq = {}

    def cap(self, key):
        return min(BUDGET_KEYS[key]['planned'].values()) * 100

    def title(self, base):
        t, k = base, 2
        while t in self.titles:
            t, k = f'{base} (ครั้งที่ {k})', k + 1
        self.titles.add(t)
        return t

    def supplier(self, item, allow_inactive=False):
        if item['agreementSupplier'] and item['agreementSupplier'] not in INACTIVE and self.r.random() < 0.7:
            return item['agreementSupplier']
        pool = [s for s in SUPPLIERS_BY_CAT[item['category']] if allow_inactive or s not in INACTIVE]
        return self.r.choice(pool)

    def invoice_no(self, supplier):
        n = self.inv_seq.get(supplier, 100 + int(supplier[2:]) * 37 % 900) + 1
        self.inv_seq[supplier] = n
        fmt = ['IV{:06d}', 'INV-{:05d}', 'TX{:07d}', 'บก.{:06d}', 'S{:05d}/A'][int(supplier[2:]) % 5]
        return fmt.format(n)

    def add(self, requester, key, rtype, item_code, qty, unit_price, days, status, hours, channel=None, site=None,
            pattern='NORMAL', note=None, personal='N', service_end=None, supplier=None, invoice=None, title=None):
        r = self.r
        item = ITEMS_BY_CODE[item_code]
        dept = USER_BY_CODE[requester]['department']
        assert BUDGET_KEYS[key]['dept'] == dept, (requester, key)
        net = sat(qty * unit_price)
        assert net % 100 == 0, (item_code, qty, unit_price)
        vat = vat_of(net)
        gross = net + vat
        counted = 0 if status in ('REJECTED', 'CANCELLED') else net
        if self.used[key] + counted > self.cap(key):
            return None
        rule, approver, esc, sla = route(gross, requester, dept)
        site = site or 'HQ-STORE'
        supplier = supplier or self.supplier(item)
        project = key[:3] if key[:3] in SHORT else None
        where = SHORT[project] if project else DEPT_NAME[dept]
        qty_txt = f'{qty:,}' if not isinstance(qty, Decimal) else f'{qty:,}'
        base = title or (f'{item["nameTh"]} · {where}' if item['unit'] in ('งาน', 'กรมธรรม์', 'งวด')
                         else f'{item["nameTh"]} {qty_txt} {item["unit"]} · {where}')
        if channel is None and status not in ('PENDING_APPROVAL', 'CANCELLED'):
            if status in ('REJECTED', 'RETURNED'):
                channel = 'LIFF' if r.random() < 0.55 else 'WEB'
            elif gross >= STEP_UP:
                channel = 'LIFF' if r.random() < 0.65 else 'WEB'
            else:
                x = r.random()
                channel = 'LINE_CHAT' if x < 0.55 else ('LIFF' if x < 0.75 else 'WEB')
        row = {'ref': None, 'daysAgo': days, 'requester': requester, 'chargedDept': dept, 'requestType': rtype,
               'title': self.title(base), 'site': site, 'supplier': supplier, 'budgetKey': key, 'itemCode': item_code,
               'qty': qty, 'unit': item['unit'], 'unitPrice': baht(sat(unit_price)), 'net': net // 100, 'vat': baht(vat),
               'gross': baht(gross), 'status': status, 'countsAgainstBudget': counted // 100, 'expectedRule': rule,
               'expectedApprover': approver, 'escalated': esc, 'hours': hours, 'channel': channel,
               'serviceEndInDays': service_end, 'form': None, 'invoiceScenario': None, 'invoiceNo': None,
               'invoiceDaysAfterGr': None, 'whtIncomeType': None, 'paymentStatus': None, 'pattern': pattern, 'note': note,
               '_sla': sla, '_gross': gross, '_net': net}
        f = _form(rtype, item, qty, _site_name(site), r, personal)
        row['form'] = json.dumps(f, ensure_ascii=False) if f else None
        if status == 'COMPLETED':
            self._invoice(row, item, invoice)
        self.used[key] += counted
        self.rows.append(row)
        return row

    def _invoice(self, row, item, forced=None):
        r = self.r
        service = item['isService'] == 'Y'  # services, rentals and licences match 2-way with acceptance (BR-MATCH-01)
        if forced:
            sc = forced
        elif service:
            x = r.random()
            sc = 'SERVICE_2WAY' if x < 0.85 else ('PRICE_OVER' if x < 0.9 else 'MISSING')
        else:
            x = r.random()
            sc = ('MATCH' if x < 0.70 else 'PRICE_WITHIN_TOL' if x < 0.78 else 'PRICE_OVER' if x < 0.84
                  else 'QTY_OVER' if x < 0.89 else 'DUPLICATE' if x < 0.92 else 'MISSING')
        row['invoiceScenario'] = sc
        row['whtIncomeType'] = item['whtIncomeType']
        if sc == 'MISSING':
            return
        row['invoiceNo'] = self.invoice_no(row['supplier'])
        row['invoiceDaysAfterGr'] = r.choice((0, 1, 2, 3, 5, 7, 10))
        terms = PAYMENT_BY_SUPPLIER[row['supplier']]['paymentTermDays']
        inv_days_ago = max(1, row['daysAgo'] - 5 - row['invoiceDaysAfterGr'])
        due_in = terms - inv_days_ago
        row['paymentStatus'] = ('PAID' if due_in < -5 and r.random() < 0.9 else 'OVERDUE' if due_in < 0
                                else 'DUE' if due_in <= 14 else 'NOT_DUE')


def _status_for(days, r):
    x = r.random()
    if days >= 30:
        return 'COMPLETED' if x < 0.72 else 'ORDERED' if x < 0.80 else 'REJECTED' if x < 0.89 else 'CANCELLED' if x < 0.94 else 'APPROVED' if x < 0.98 else 'RETURNED'
    if days >= 16:
        return 'COMPLETED' if x < 0.45 else 'ORDERED' if x < 0.70 else 'APPROVED' if x < 0.82 else 'REJECTED' if x < 0.92 else 'CANCELLED' if x < 0.96 else 'RETURNED'
    return 'ORDERED' if x < 0.30 else 'APPROVED' if x < 0.70 else 'REJECTED' if x < 0.82 else 'RETURNED' if x < 0.92 else 'CANCELLED'


def _fit(status, days, hours):
    """Shrink hours, then step the status back, until the replay of the row ends before now on any run date."""
    order = ['COMPLETED', 'ORDERED', 'APPROVED']
    while True:
        room = guaranteed_business_hours(days) - EXTRA_HOURS[status]
        if room >= 1:
            return status, max(1, min(hours, room))
        if status in order and status != 'APPROVED':
            status = order[order.index(status) + 1]
            continue
        return None, None


def build(target_rows=240):
    b = _Builder()
    r = b.r
    # ---- scenario rows first (fixed), so the random rows cannot use up their budget ----
    sc = {}
    sc['split_a'] = b.add('fm_p02', 'P02-MAT', 'BUY_GOODS', 'MAT-011', 46, Decimal(395), 21, 'COMPLETED', 2, 'LINE_CHAT', 'SITE-P02', 'SPLIT',
                          'แตกยอดเลี่ยงวงเงิน: คู่กับแถวถัดไป ผู้ขอ ผู้ขาย และของเดียวกัน ห่าง 1 วัน รวมกันเกิน 20,000 (FR-INT-103)')
    split_sup = sc['split_a']['supplier']
    sc['split_b'] = b.add('fm_p02', 'P02-MAT', 'BUY_GOODS', 'MAT-011', 47, Decimal(395), 20, 'COMPLETED', 1, 'LINE_CHAT', 'SITE-P02', 'SPLIT',
                          'แตกยอดเลี่ยงวงเงิน: คู่กับแถวก่อนหน้า', supplier=split_sup)
    sc['dup_a'] = b.add('se_p06a', 'P06-MAT', 'BUY_GOODS', 'MAT-014', 500, Decimal(62), 35, 'COMPLETED', 3, 'LIFF', 'SITE-P06', 'DUPLICATE',
                        'คำขอต้นฉบับของคู่ที่ส่งซ้ำ')
    sc['dup_b'] = b.add('se_p06a', 'P06-MAT', 'BUY_GOODS', 'MAT-014', 500, Decimal(62), 34, 'REJECTED', 2, 'WEB', 'SITE-P06', 'DUPLICATE',
                        'ไม่อนุมัติ: ซ้ำกับคำขอเมื่อวาน (ตรวจคำขอซ้ำ FR-INT-103)', supplier=sc['dup_a']['supplier'],
                        title=sc['dup_a']['title'].replace(' · ', ' (ส่งซ้ำ) · '))
    sc['overdue_vp'] = b.add('se_p01a', 'P01-MAT', 'BUY_GOODS', 'MAT-012', 250, Decimal(165), 3, 'PENDING_APPROVAL', 18, None, 'SITE-P01', 'OVERDUE',
                             'ค้างที่ VP 18 ชม. เกิน SLA 8 ชม. → ขึ้นกระดานค้าง')
    sc['overdue_ceo'] = b.add('pm_p07', 'P07-SUB', 'CONTRACT_WORK', 'SUB-010', 9500, Decimal(260), 5, 'PENDING_APPROVAL', 30, None, 'SITE-P07', 'OVERDUE',
                              'งานเหมาถนน 2.47 ล้าน ค้างที่กรรมการผู้จัดการ 30 ชม. เกิน SLA 16 ชม. · ต้องผ่านผู้ตรวจคู่ขนาน 3 ฝ่ายเมื่อมี S6 (RV-03 ถึง RV-05)')
    sc['overdue_vp2'] = b.add('mnt_02', 'EQP-MNT-OPEX', 'BUY_GOODS', 'PRT-002', 6, Decimal(9800), 2, 'PENDING_APPROVAL', 12, None, 'EQP-YARD', 'OVERDUE',
                              'ค้างที่ VP 12 ชม. เกิน SLA')
    b.add('ga_03', 'HRA-GA-OPEX', 'BUY_GOODS', 'OFF-001', 60, Decimal(125), 1, 'PENDING_APPROVAL', 2, None, 'HQ-STORE', 'NORMAL', 'ยังไม่เกิน SLA')
    sc['esc_dm'] = b.add('dm_conb', 'CONB-OPEX', 'BUY_GOODS', 'SAF-006', 40, Decimal(350), 40, 'COMPLETED', 2, 'LINE_CHAT', 'SITE-P03', 'ESCALATED',
                         'ผู้จัดการฝ่ายขอเอง จึงยกไป VP (BR-DOA-06)')
    sc['esc_it'] = b.add('dm_it', 'IT-OPEX', 'IT_PURCHASE', 'SWL-003', 3, Decimal(5250), 28, 'COMPLETED', 3, 'LIFF', 'HQ-STORE', 'ESCALATED',
                         'ผู้จัดการฝ่ายไอทีขอเอง จึงยกไป VP สายสนับสนุน')
    sc['renew_sec'] = b.add('ga_02', 'HRA-GA-OPEX', 'HIRE_SERVICE', 'SRV-001', 24, Decimal(18500), 148, 'COMPLETED', 6, 'LIFF', 'HQ-STORE', 'RENEWAL',
                            'รปภ. 4 คน 6 เดือน · สัญญาหมดใน 30 วัน → เตือนต่ออายุและปุ่มขอซ้ำ (FR-INT-101)', service_end=30)
    sc['renew_cloud'] = b.add('it_02', 'IT-OPEX', 'IT_PURCHASE', 'SWL-004', 1, Decimal(96000), 118, 'COMPLETED', 9, 'WEB', 'HQ-STORE', 'RENEWAL',
                              'บริการคลาวด์ที่เก็บข้อมูลส่วนบุคคล ต้องแนบ DPA (ATT-DPA) · หมดอายุใน 60 วัน', personal='Y', service_end=60)
    b.add('hr_02', 'HRA-OPEX', 'HIRE_SERVICE', 'TRA-003', 4, Decimal(18000), 64, 'COMPLETED', 4, 'LINE_CHAT', 'HQ-STORE', 'NORMAL',
          'บริการที่ผู้ขายเห็นข้อมูลพนักงาน ต้องแนบ DPA (ATT-DPA)', personal='Y')
    for days, st, qty in ((150, 'COMPLETED', 20000), (122, 'COMPLETED', 18000), (92, 'COMPLETED', 22000), (61, 'COMPLETED', 20000),
                          (31, 'ORDERED', 21000), (12, 'APPROVED', 19000)):
        b.add('eqp_02', 'EQP-OPEX', 'BUY_GOODS', 'FUL-001', qty, Decimal('32.50'), days, st, 7, None, 'EQP-YARD', 'NORMAL',
              'น้ำมันดีเซลรายเดือน · เกิน 100,000 จึงไป CEO ทุกเดือนตาม DOA ฉบับ 1 (ตัวอย่างให้ลองปรับ DOA ด้วยการย้อนทดสอบ FR-DOA-103)')
    b.add('dm_eqp', 'EQP-CAPEX', 'BUY_GOODS', 'MCH-001', 1, Decimal(4850000), 96, 'COMPLETED', 12, 'WEB', 'EQP-YARD', 'NORMAL',
          'ซื้อรถขุด · ผู้จัดการฝ่ายขอเอง ยอดอยู่ช่วง CEO จึงไม่ต้องยกระดับ · ตรวจรับที่ลาน', invoice='MATCH')
    b.add('eqp_01', 'EQP-CAPEX', 'BUY_GOODS', 'MCH-003', 1, Decimal(7900000), 42, 'ORDERED', 14, 'LIFF', 'EQP-YARD', 'NORMAL',
          'PO เกิน 1,000,000 ไป CEO (PO-02)')
    old = next(c for c in sorted(INACTIVE) if PAYMENT_BY_SUPPLIER[c]['registryStatus'] == 'CEASED' and SUPPLIER_BY_CODE[c]['_cat'] in ('MAT', 'RENT', 'SUBCON', 'TRANS', 'STEEL'))
    old_item = next(i for i in ITEMS if i['category'] == SUPPLIER_BY_CODE[old]['_cat'] and i['unit'] not in ('งาน', 'กรมธรรม์', 'งวด'))
    b.add('se_p04a', 'P04-MAT' if SUPPLIER_BY_CODE[old]['_cat'] in ('MAT', 'STEEL') else 'P04-RENT',
          'BUY_GOODS' if SUPPLIER_BY_CODE[old]['_cat'] in ('MAT', 'STEEL') else 'HIRE_SERVICE', old_item['code'],
          *_qty_for(old_item, 60_000, r), 110, 'COMPLETED', 3, 'LIFF', 'SITE-P04', 'INACTIVE_SUPPLIER',
          'ผู้ขายรายนี้เลิกกิจการภายหลัง · ใช้ทดสอบคำเตือนตอนสั่งซื้อครั้งใหม่และรอบจ่าย (BR-SUP-04)', supplier=old)
    for item, qty, days, st, hours in (('MKT-001', 1, 140, 'COMPLETED', 10), ('MKT-002', 3, 101, 'COMPLETED', 6), ('MKT-005', 1, 77, 'COMPLETED', 11),
                                       ('MKT-004', 1, 48, 'ORDERED', 9), ('MKT-003', 5000, 33, 'COMPLETED', 4), ('MKT-006', 3, 19, 'APPROVED', 3),
                                       ('MKT-006', 4, 4, 'PENDING_APPROVAL', 5)):
        it = ITEMS_BY_CODE[item]
        price = Decimal(it['refUnitPrice'])
        who = r.choice(['mkt_01', 'mkt_02', 'mkt_03'])
        b.add(who, 'MKT-OPEX', 'HIRE_SERVICE', item, qty, price, days, st, hours, None, 'HQ-STORE', 'LOW_BUDGET',
              'งบการตลาดเหลือต่ำกว่า 10% → ขึ้นสรุปรายวันและ dashboard งบ')

    # ---- random rows ----
    templates = _templates()
    weights = [t[0] for t in templates]
    pending_left = 14
    guard = 0
    while len(b.rows) < target_rows and guard < 20000:
        guard += 1
        w, people, key, rtype, items, (lo, hi), site = r.choices(templates, weights)[0]
        requester = r.choice(people)
        item = ITEMS_BY_CODE[r.choice(items)]
        target = int(lo * (hi / lo) ** r.random())
        qty, price = _qty_for(item, target, r)
        if price != price.to_integral_value() or item['unit'] in ('งาน', 'กรมธรรม์', 'งวด'):
            pass
        elif price >= 100 and r.random() < 0.5:  # quoted price moves a little around the reference price
            price = Decimal(int(price * Decimal(r.choice((96, 97, 98, 99, 101, 102, 103, 104))) / 100))
        if pending_left and r.random() < 0.08:
            days, status = r.randint(0, 6), 'PENDING_APPROVAL'
            hours = r.choice((1, 2, 3, 4, 5, 6, 7, 10, 14))
            pending_left -= 1
        else:
            days = int(9 + 141 * r.random() ** 1.15)
            status = _status_for(days, r)
            gross_est = sat(qty * price) * (10000 + VAT_BP) // 10000
            sla = 16 if gross_est > 10_000_000 else 8
            hours = r.randint(1, sla) if r.random() < 0.75 else r.randint(sla + 1, sla * 2)
            status, hours = _fit(status, days, hours)
            if status is None:
                continue
        b.add(requester, key, rtype, item['code'], qty, price, days, status, hours, None, site)

    rows = sorted(b.rows, key=lambda x: (-x['daysAgo'], x['title']))
    for i, row in enumerate(rows, 1):
        row['ref'] = f'H{i:03d}'
    # duplicate invoice: one goods row gets the same invoice number twice (BR-MATCH-03)
    return rows, b


def doc_samples(rows):
    """Ground truth of synthetic documents for the S13 evaluation set (§12.4). The files themselves are made in S13."""
    r = rng('docs')
    out = []
    goods = [x for x in rows if x['status'] == 'COMPLETED' and x['requestType'] in ('BUY_GOODS', 'IT_PURCHASE') and x['invoiceScenario'] not in (None, 'MISSING')]
    services = [x for x in rows if x['status'] == 'COMPLETED' and x['requestType'] in ('HIRE_SERVICE', 'CONTRACT_WORK') and x['invoiceScenario'] not in (None, 'MISSING')]
    picks = r.sample(goods, min(14, len(goods))) + r.sample(services, min(6, len(services)))
    layouts = ['A4_TYPED', 'A4_TYPED', 'A4_SCANNED', 'A4_SCANNED', 'PHOTO', 'EN_TEMPLATE']
    n = 0

    def totals(lines, incl):
        amts = [rhu(int(Decimal(str(l['qty'])) * 10000) * sat(l['unitPrice']), 10000) for l in lines]
        tot = sum(amts)
        if incl:
            vat = rhu(tot * VAT_BP, 10000 + VAT_BP)
            return tot - vat, vat, tot
        vat = vat_of(tot)
        return tot, vat, tot + vat

    def add(doc_type, row, lines, incl, doc_no, days, layout, quality, lang, notes, wht_bp=None):
        nonlocal n
        n += 1
        net, vat, gross = totals(lines, incl) if lines and 'unitPrice' in lines[0] else (None, None, None)
        sup = SUPPLIER_BY_CODE[row['supplier']]
        out.append({'sampleId': f'DOC-{n:03d}', 'docType': doc_type, 'historyRef': row['ref'], 'supplierCode': sup['code'],
                    'sellerNameTh': sup['nameTh'], 'sellerTaxId': sup['taxId'], 'sellerBranch': sup['branchCode'], 'buyerTaxId': ORG_TAXID,
                    'docNo': doc_no, 'docDaysAgo': days, 'priceIncludesVat': 'Y' if incl else 'N',
                    'linesJson': json.dumps(lines, ensure_ascii=False), 'net': baht(net) if net is not None else None,
                    'vat': baht(vat) if vat is not None else None, 'gross': baht(gross) if gross is not None else None,
                    'expectedWhtBp': wht_bp, 'expectedWht': baht(rhu(net * wht_bp, 10000)) if wht_bp and net is not None else None,
                    'layout': layout, 'quality': quality, 'language': lang, 'notes': notes})

    for k, row in enumerate(picks):
        item = ITEMS_BY_CODE[row['itemCode']]
        unit_price = Decimal(str(row['unitPrice']))
        line = {'description': item['nameTh'], 'qty': row['qty'], 'unit': item['unit'], 'unitPrice': f'{unit_price:.2f}'}
        incl = k % 7 == 3  # some sellers quote prices that already include VAT
        if incl:
            line = {**line, 'unitPrice': f'{(unit_price * Decimal("1.07")).quantize(Decimal("0.01"), ROUND_HALF_UP):.2f}'}
        layout, quality = layouts[k % len(layouts)], ['CLEAN', 'CLEAN', 'SKEWED', 'STAMPED', 'BLURRY'][k % 5]
        lang = 'MIXED' if layout == 'EN_TEMPLATE' else 'TH'
        add('QUOTATION', row, [line], incl, f'QT-{row["ref"][1:]}{k:02d}', row['daysAgo'] + 3, layout, quality, lang,
            'ใบเสนอราคาราคารวม VAT แล้ว' if incl else None)
        if row['requestType'] in ('BUY_GOODS', 'IT_PURCHASE'):
            add('DELIVERY_NOTE', row, [{'description': item['nameTh'], 'qty': row['qty'], 'unit': item['unit']}], False,
                f'DN{int(row["ref"][1:]) * 7 + 100000:06d}', max(1, row['daysAgo'] - 5), 'A4_SCANNED' if k % 2 else 'PHOTO',
                'STAMPED' if k % 3 == 0 else 'CLEAN', 'TH', 'มีลายเซ็นผู้รับของหน้างาน')
        inv_price = unit_price
        if row['invoiceScenario'] == 'PRICE_OVER':
            inv_price = (unit_price * Decimal('1.03')).quantize(Decimal('0.01'), ROUND_HALF_UP)
        elif row['invoiceScenario'] == 'PRICE_WITHIN_TOL':
            inv_price = (unit_price * Decimal('1.005')).quantize(Decimal('0.01'), ROUND_HALF_UP)
        inv_line = {'description': item['nameTh'], 'qty': row['qty'], 'unit': item['unit'], 'unitPrice': f'{inv_price:.2f}'}
        etax = PAYMENT_BY_SUPPLIER[row['supplier']]['eTaxIssuer'] != 'NONE'
        wht = {'SERVICE': 300, 'CONTRACT': 300, 'RENT': 500, 'TRANSPORT': 100, 'PROFESSIONAL': 300, 'ADVERTISING': 200,
               'INSURANCE': 100}.get(row['whtIncomeType'])
        add('ETAX_XML' if etax else 'TAX_INVOICE', row, [inv_line], False, row['invoiceNo'],
            max(1, row['daysAgo'] - 5 - (row['invoiceDaysAfterGr'] or 0)), 'XML' if etax else layouts[(k + 2) % len(layouts)],
            'CLEAN' if etax else quality, 'TH', {'PRICE_OVER': 'ราคาสูงกว่า PO 3% (นอกเกณฑ์)', 'PRICE_WITHIN_TOL': 'ราคาสูงกว่า PO 0.5%',
                                                 'QTY_OVER': 'ใบแจ้งหนี้เต็มจำนวนแต่ตรวจรับไม่ครบ'}.get(row['invoiceScenario']), wht)
    # four hard cases the evaluation must include (§12.4): handwriting, discount line, two VAT treatments, English seller
    hard = [x for x in rows if x['status'] == 'COMPLETED' and x['requestType'] == 'HIRE_SERVICE' and x['invoiceScenario'] == 'SERVICE_2WAY'][:2]
    for row in hard:
        item = ITEMS_BY_CODE[row['itemCode']]
        add('QUOTATION', row, [{'description': item['nameTh'] + ' (เขียนด้วยลายมือ)', 'qty': row['qty'], 'unit': item['unit'],
                                'unitPrice': f'{Decimal(str(row["unitPrice"])):.2f}'}], False, 'ไม่มีเลขที่', row['daysAgo'] + 2,
            'HANDWRITTEN', 'BLURRY', 'TH', 'ใบเสนอราคาเขียนมือของผู้รับเหมารายย่อย ไม่มีเลขที่เอกสาร')
    if goods:
        row = goods[0]
        item = ITEMS_BY_CODE[row['itemCode']]
        up = Decimal(str(row['unitPrice']))
        add('TAX_INVOICE', row, [{'description': item['nameTh'], 'qty': row['qty'], 'unit': item['unit'], 'unitPrice': f'{up:.2f}'},
                                 {'description': 'ส่วนลดการค้า', 'qty': 1, 'unit': 'รายการ', 'unitPrice': f'{-(up * row["qty"] * Decimal("0.02")).quantize(Decimal("0.01"), ROUND_HALF_UP):.2f}'}],
            False, f'DC-{row["ref"][1:]}', max(1, row['daysAgo'] - 6), 'A4_TYPED', 'CLEAN', 'TH', 'มีบรรทัดส่วนลด 2% ก่อนคิด VAT')
    return out
