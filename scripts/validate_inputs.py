#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_inputs.py — ตรวจไฟล์ input ของ BCS (ไฟล์ demo · ไฟล์ข้อมูลสังเคราะห์ระยะ 1 · ข้อมูลจริง v2) แบบรันจริง ทั้งโครงสร้างและการคำนวณ
ใช้:  python3 validate_inputs.py BCS_inputs_v1_demo.xlsx [--spec spec.md] [--profile demo|p1]
- --profile demo (ค่าเริ่มต้นเมื่อไม่มีชีต Request_History): ไฟล์ของฉาก demo เดิม (§16.10) ต้องตรง fixture §7.4 และมี Demo_History Demo_Script
- --profile p1 (ค่าเริ่มต้นเมื่อมีชีต Request_History): ไฟล์ระยะ 1 (§16.13 · ADR-065) งานสองปีงบ ประวัติอ้าง budgetKey และชีตของ S6 S8 S9 S13
- อ่านค่าที่คำนวณแล้วของสูตร จึงต้องบันทึกไฟล์จาก Excel หรือ LibreOffice ก่อนตรวจ (ไฟล์ระยะ 1 เขียนเป็นค่าจากสคริปต์ ไม่มีสูตร)
- --spec: เทียบกับรายการ OQ ใน spec.md (ต้องมี PyYAML) และกับ fixture เฉพาะไฟล์ demo
- นับจำนวนแถวเองทุกชีต ไม่ hardcode · exit 0 = ไม่มี FAIL
"""
import re, sys, json
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, date
import openpyxl
from openpyxl.utils import get_column_letter

argv = sys.argv[1:]; SPEC = None; PROFILE = None
if '--spec' in argv:
    k = argv.index('--spec'); SPEC = argv[k + 1]; del argv[k:k + 2]
if '--profile' in argv:
    k = argv.index('--profile'); PROFILE = argv[k + 1]; del argv[k:k + 2]
PATH = argv[0] if argv else 'BCS_inputs_v1_demo.xlsx'
wb = openpyxl.load_workbook(PATH, data_only=True)
PROFILE = PROFILE or ('p1' if 'Request_History' in wb.sheetnames else 'demo')
if PROFILE not in ('demo', 'p1'): print(f'FAIL  --profile ต้องเป็น demo หรือ p1 (ได้ {PROFILE})'); sys.exit(2)
DEMO_LAST_OQ = 39  # the demo workbook stopped taking questions at OQ-39 (ADR-065); newer OQs live in the phase-1 workbook
RES = []
def rep(st, name, detail='', impact='', fix=''): RES.append((st, name, detail, impact, fix))
def wf_fields(w): return [x for c in w.get('all', []) + w.get('any', []) for x in wf_fields(c)] + ([w['field']] if 'field' in w else [])
def check(cond, name, good, bad, impact, fix): rep('PASS' if cond else 'FAIL', name, good if cond else bad, impact, fix)
def finish():
    n = {'PASS': 0, 'FAIL': 0}
    print(f'validate_inputs — {PATH}' + (' (profile p1)' if PROFILE == 'p1' else ''))
    for st, name, d, imp, fix in RES:
        n[st] += 1; print(f'{st:5} {name} — {d}')
        if st == 'FAIL':
            if imp: print(f'      ผลกระทบ: {imp}')
            if fix: print(f'      วิธีแก้: {fix}')
    print(f"สรุป: {n['PASS']} PASS · {n['FAIL']} FAIL"); sys.exit(1 if n['FAIL'] else 0)

COMMON = {'Inputs': ['id','group','item','usedFor','demoValue','provider','neededBefore','ref','sheet','status'],
 'Questions': ['id','meeting','askWhom','question','whyItMatters','demoDefault','ref','answer','docsToRequest'],
 'Org': ['key','value'], 'Departments': ['code','nameTh','parent','kind'], 'Positions': ['code','nameTh','scope'],
 'Users': ['code','displayNameTh','email','department','roles','positions'],
 'DOA': ['version','ruleCode','documentType','gt','lte','approverKind','approverPosition','approverMember','slaBusinessHours'],
 'DOA_Policy': ['key','value'],
 'Suppliers': ['code','nameTh','taxId','branchCode','vatRegistered','email'], 'Sites': ['code','nameTh'],
 'RequestTypes': ['code','nameTh','documentType','active'], 'Holidays': ['date','nameTh'], 'Settings': ['key','value']}
DEMO_ONLY = {'Budget': ['fiscalYear','code','department','planned','usedDemo','remaining'],
 'Demo_History': ['ref','daysAgo','requester','chargedDept','requestType','site','supplier','budgetLine','net','vat','gross','status','countsAgainstBudget','expectedRule','expectedApprover','escalated','hours','channel'],
 'Demo_Script': ['scene','core','actor','channel','chargedDept','budgetLine','net','vat','gross','expectedOutcome','expectedRule','expectedApprover','escalated','delegation','minutes']}
P1_ONLY = {'Budget': ['fiscalYear','code','budgetKey','department','costCenter','accountCode','planned'],
 'CostCenters': ['code','nameTh','department'], 'GL_Accounts': ['code','nameTh','type'],
 'SupplierPayment': ['supplierCode','payeeType','whtIncomeType','paymentTermDays','bankCode','accountNo','accountName','eTaxIssuer','registryStatus'],
 'Banks': ['code','shortName','nameTh'], 'WHT_Types': ['code','nameTh','rateBp','form'],
 'CompanyBankAccounts': ['code','bankCode','accountNo'],
 'Items': ['code','nameTh','unit','refUnitPrice','category','isService','accountCode','whtIncomeType','agreementSupplier','agreedUnitPrice'],
 'Workflow_Reviewers': ['ruleCode','requestType','reviewerPosition','reviewerDepartment','mode','slaBusinessHours','whenJson','fallbackPosition','fallbackDepartment'],
 'Request_History': ['ref','daysAgo','requester','chargedDept','requestType','title','site','supplier','budgetKey','itemCode','qty','unitPrice','net','vat','gross','status','countsAgainstBudget','expectedRule','expectedApprover','escalated','hours','channel','form','invoiceScenario','invoiceNo','whtIncomeType','paymentStatus'],
 'DocSamples': ['sampleId','docType','historyRef','supplierCode','docNo','priceIncludesVat','linesJson','net','vat','gross','expectedWhtBp','expectedWht'],
 'Scenarios': ['id','area','descriptionTh','where']}
REQ = {**COMMON, **(DEMO_ONLY if PROFILE == 'demo' else P1_ONLY)}
miss = [s for s in REQ if s not in wb.sheetnames]
check(not miss, 'ชีตครบ', f'{len(REQ)} ชีตข้อมูล', f'ขาด {miss}', 'ข้อมูลส่วนนั้นจะไม่ถูกนำเข้า', 'เพิ่มชีตที่ขาดโดยคัดลอกหัวตารางจากไฟล์ v1' if PROFILE == 'demo' else 'สร้างไฟล์ใหม่ด้วย scripts/inputs_p1/make.py')
if miss: finish()
bad = []
for sname, keys in REQ.items():
    have = [wb[sname].cell(1, j).value for j in range(1, wb[sname].max_column + 1)]
    lack = [k for k in keys if k not in have]
    if lack: bad.append(f'{sname} ขาด {lack}')
check(not bad, 'หัวตาราง (แถว 1)', 'ทุกชีตมีคอลัมน์ที่ตัวนำเข้าต้องใช้', '; '.join(bad), 'ตัวนำเข้าอ่านคอลัมน์ไม่เจอ', 'คืนชื่อคอลัมน์ในแถว 1 ตามรายการที่ขาด')
if bad: finish()

def table(sname):
    ws = wb[sname]; keys = {j: ws.cell(1, j).value for j in range(1, ws.max_column + 1)}; out = []
    for r in range(3, ws.max_row + 1):
        v = ws.cell(r, 1).value
        if v is None or str(v).strip() == '': break
        out.append((r, {k: ws.cell(r, j).value for j, k in keys.items() if k}))
    return out
def at(sname, key, r):
    ws = wb[sname]
    for j in range(1, ws.max_column + 1):
        if ws.cell(1, j).value == key: return f'{sname}!{get_column_letter(j)}{r}'
    return f'{sname}!?{r}'
def kv(sname): return {str(d['key']).strip(): (d.get('value'), r) for r, d in table(sname)}
def s_(v):
    if v is None: return ''
    if isinstance(v, float) and v.is_integer(): v = int(v)
    return str(v).strip()
def sat(x): return int(Decimal(str(x)).quantize(Decimal('0.01'), ROUND_HALF_UP) * 100)
def baht(n): return ('-' if n < 0 else '') + f'{abs(n) // 100:,}.{abs(n) % 100:02d}'
def rhu(n, d): return (2 * n + d) // (2 * d)
def taxid_ok(x):
    x = re.sub(r'[\s-]', '', s_(x))
    if not re.fullmatch(r'\d{13}', x): return False
    return (11 - sum(int(x[i]) * (13 - i) for i in range(12)) % 11) % 10 == int(x[12])
def money_ok(x):
    try: return Decimal(str(x)) == Decimal(str(x)).quantize(Decimal('0.01'))
    except Exception: return False

# ---------- องค์กร ----------
ORG, SET, POL = kv('Org'), kv('Settings'), kv('DOA_Policy')
need = ['code','legalNameTh','taxId','branchCode','timezone','fiscalYearStartMonth','contractSignatory','orgAdmins']
lack = [k for k in need if not s_(ORG.get(k, (None, 0))[0])]
check(not lack, 'Org มีค่าที่จำเป็น', f'{len(need)} ค่าครบ', f'ว่างหรือไม่มี: {lack}', 'หัวเอกสารหรือการอนุมัติชุดตั้งต้นทำไม่ได้', 'กรอกคอลัมน์ value ของ key ที่ระบุในชีต Org')
tid = ORG.get('taxId', ('', 0))
check(taxid_ok(tid[0]), 'เลขผู้เสียภาษีของบริษัท', s_(tid[0]), f'{s_(tid[0])} ไม่ผ่าน mod-11 หรือไม่ใช่ 13 หลัก', 'เอกสารภาษีผิด และ seed ถูกปฏิเสธ', f'แก้ {at("Org","value",tid[1])} (พิมพ์เป็นข้อความเพื่อไม่ให้เลข 0 นำหน้าหาย)')

# ---------- แผนก ตำแหน่ง ผู้ใช้ ----------
DEP, dup = {}, []
for r, d in table('Departments'):
    c = s_(d['code'])
    if c in DEP: dup.append(c)
    DEP[c] = s_(d['parent']) or None
roots = [c for c, p in DEP.items() if p is None]
badp = [f'{c}→{p}' for c, p in DEP.items() if p and p not in DEP]
cyc = []
for c in DEP:
    seen, x = set(), c
    while x in DEP:
        if x in seen: cyc.append(c); break
        seen.add(x); x = DEP[x]
check(not dup and len(roots) == 1 and not badp and not cyc, 'ผังแผนกเป็นต้นไม้เดียว', f'{len(DEP)} แผนก · ราก {roots[0] if roots else "-"}',
      f'ซ้ำ {dup} · ราก {roots} · parent ไม่มีจริง {badp} · วนรอบ {cyc}', 'engine ไล่หาผู้อนุมัติไม่ได้หรือวนไม่จบ', 'แก้คอลัมน์ parent ในชีต Departments ให้มีรากเดียวและไม่วน')
ROOT = roots[0] if len(roots) == 1 else None
POS = {s_(d['code']): s_(d['scope']) for r, d in table('Positions')}
badsc = [c for c, sc in POS.items() if sc not in ('DEPARTMENT', 'ORG')]
check(not badsc, 'ตำแหน่ง', f'{len(POS)} ตำแหน่ง', f'scope ไม่ถูกต้อง: {badsc}', 'หาผู้อนุมัติผิดระดับ', 'ใส่ scope เป็น DEPARTMENT หรือ ORG')
ROLES = {'REQUESTER','PROCUREMENT','FINANCE','BUDGET_ADMIN','RECEIVER','EXECUTIVE','AUDITOR','ORG_ADMIN'}
USR, HOLD, probs = {}, {}, []
for r, d in table('Users'):
    c, em, dep = s_(d['code']), s_(d['email']).lower(), s_(d['department'])
    roles = {x.strip() for x in s_(d['roles']).split(',') if x.strip()}
    if c in USR: probs.append(f'{c} ซ้ำ (แถว {r})')
    if PROFILE == 'p1' and not re.fullmatch(r'[a-z0-9_]+', c): probs.append(f'{at("Users","code",r)} รหัสต้องเป็นตัวเล็ก ตัวเลข และ _ เท่านั้น')
    if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', em): probs.append(f'{at("Users","email",r)} อีเมลไม่ถูกรูปแบบ')
    if dep not in DEP: probs.append(f'{at("Users","department",r)} ไม่มีแผนก {dep}')
    if roles - ROLES: probs.append(f'{at("Users","roles",r)} role ไม่รู้จัก {sorted(roles - ROLES)}')
    for p in [x.strip() for x in s_(d['positions']).split(';') if x.strip()]:
        m = re.fullmatch(r'([A-Z_]+)@([A-Za-z0-9_-]+)', p)
        if not m or m.group(1) not in POS or m.group(2) not in DEP: probs.append(f'{at("Users","positions",r)} "{p}" ไม่ถูกต้อง'); continue
        pos, pd = m.groups()
        if POS[pos] == 'ORG' and pd != ROOT: probs.append(f'{at("Users","positions",r)} {p} เป็นตำแหน่งระดับองค์กร ต้องผูกกับ {ROOT}')
        if (pos, pd) in HOLD: probs.append(f'{p} มีผู้ดำรง 2 คน ({HOLD[(pos, pd)]}, {c})')
        HOLD[(pos, pd)] = c
    USR[c] = {'dept': dep, 'roles': roles, 'email': em}
emails = [u['email'] for u in USR.values()]
if len(set(emails)) != len(emails): probs.append('มีอีเมลซ้ำ')
check(not probs, 'ผู้ใช้และผู้ดำรงตำแหน่ง', f'{len(USR)} ผู้ใช้ · {len(HOLD)} ตำแหน่งมีผู้ดำรง', '; '.join(probs[:10]), 'บัญชีสร้างไม่ได้หรือเอกสารไปหาผู้อนุมัติผิดคน', 'แก้ช่องที่ระบุในชีต Users')
admins = [x.strip() for x in s_(ORG.get('orgAdmins', ('', 0))[0]).split(',') if x.strip()]
okadm = len(admins) >= 2 and all(a in USR and 'ORG_ADMIN' in USR[a]['roles'] for a in admins)
check(okadm, 'ORG_ADMIN อย่างน้อย 2 คน', ', '.join(admins), f'{admins} ต้องมีอย่างน้อย 2 คนและทุกคนมี role ORG_ADMIN', 'แต่งตั้งผู้ดำรงตำแหน่งไม่ได้เมื่อผู้ดูแลเป็นผู้ได้ประโยชน์ (BR-SOD-08)', f'แก้ {at("Org","value",ORG.get("orgAdmins",("",0))[1])} และคอลัมน์ roles ในชีต Users')
sig = s_(ORG.get('contractSignatory', ('', 0))[0])
check(sig in USR, 'ผู้มีอำนาจลงนามมีบัญชีผู้ใช้', sig, f'"{sig}" ไม่อยู่ในชีต Users', 'อนุมัติชุดตั้งต้นไม่ได้ (BR-DOA-19)', f'แก้ {at("Org","value",ORG.get("contractSignatory",("",0))[1])} ให้เป็นรหัสผู้ใช้')

# ---------- DOA ----------
RULES, rprob = {}, []
# The DOA document types of src/core/doa (DOA_DOCUMENT_TYPES · P1-07): a type without an amount takes no band (BR-DOA-22)
DOCS = {'PURCHASE_REQUEST','PURCHASE_ORDER','GR_VARIANCE','DOA_CHANGE','ORG_AUTHORITY_CHANGE',
        'BUDGET_TRANSFER','OVER_BUDGET','INVOICE_EXCEPTION','PO_CHANGE','PAYMENT_RUN','BANK_ACCOUNT_CHANGE'}
NO_AMOUNT_DOCS = {'BANK_ACCOUNT_CHANGE'}
# The seed of the phase-1 file switches PAY on (ADR-070), so its DOA needs PAY's types (BR-DOA-23 BR-DOA-24)
PAY_DOCS = ('INVOICE_EXCEPTION', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE')
for r, d in table('DOA'):
    rule = {'code': s_(d['ruleCode']), 'doc': s_(d['documentType']), 'gt': None if d['gt'] in (None, '') else sat(d['gt']),
            'lte': None if d['lte'] in (None, '') else sat(d['lte']), 'kind': s_(d['approverKind']), 'pos': s_(d['approverPosition']), 'mem': s_(d['approverMember']), 'sla': d['slaBusinessHours']}
    if rule['doc'] not in DOCS: rprob.append(f'{at("DOA","documentType",r)} {rule["doc"]}')
    if rule['doc'] in NO_AMOUNT_DOCS and (rule['gt'] is not None or rule['lte'] is not None): rprob.append(f'{at("DOA","gt",r)} {rule["doc"]} ไม่มียอดเงิน จึงตั้งช่วงวงเงินไม่ได้')
    if rule['kind'] not in ('POSITION_OF_DEPARTMENT', 'POSITION_OF_ORG', 'MEMBER'): rprob.append(f'{at("DOA","approverKind",r)} {rule["kind"]}')
    if rule['kind'] != 'MEMBER' and rule['pos'] not in POS: rprob.append(f'{at("DOA","approverPosition",r)} ไม่มีตำแหน่ง {rule["pos"]}')
    if rule['kind'] == 'MEMBER' and rule['mem'] not in USR: rprob.append(f'{at("DOA","approverMember",r)} ไม่มีผู้ใช้ {rule["mem"]}')
    if not isinstance(rule['sla'], (int, float)) or rule['sla'] <= 0: rprob.append(f'{at("DOA","slaBusinessHours",r)} ต้องเป็นตัวเลขบวก')
    RULES.setdefault(int(d['version']), []).append(rule)
VER = int(POL.get('version', (1, 0))[0]); RS = RULES.get(VER, [])
BASIS, SELF = s_(POL.get('amountBasis', ('', 0))[0]), s_(POL.get('selfApprovalPolicy', ('', 0))[0])
STEPUP = sat(POL.get('stepUpThreshold', (0, 0))[0])
if BASIS not in ('GROSS', 'NET'): rprob.append('DOA_Policy amountBasis ต้องเป็น GROSS หรือ NET')
if SELF not in ('ESCALATE_NEXT_BAND', 'BLOCK'): rprob.append('DOA_Policy selfApprovalPolicy ต้องเป็น ESCALATE_NEXT_BAND หรือ BLOCK')
if not RS: rprob.append(f'ไม่มีข้อ DOA ของฉบับ {VER}')
if PROFILE == 'p1': rprob += [f'ฉบับ {VER} ไม่มีข้อของ {d} ที่โมดูล PAY ต้องมี' for d in PAY_DOCS if not any(r['doc'] == d for r in RS)]
check(not rprob, 'ข้อมูล DOA และนโยบาย', f'ฉบับ {VER}: {len(RS)} ข้อ · ฐาน {BASIS} · step-up {baht(STEPUP)}', '; '.join(rprob), 'engine คำนวณเส้นทางไม่ได้', 'แก้ช่องที่ระบุในชีต DOA หรือ DOA_Policy')
def is_amt(r): return r['gt'] is not None or r['lte'] is not None
def lower(r): return r['gt'] or 0
def matches(r, amt): return True if not is_amt(r) else (amt is not None and (r['gt'] is None or amt > r['gt']) and (r['lte'] is None or amt <= r['lte']))
def approver(r, dept, vac=frozenset()):
    if r['kind'] == 'MEMBER': return None if r['mem'] in vac else (r['mem'] or None)
    d = dept if r['kind'] == 'POSITION_OF_DEPARTMENT' else ROOT
    while d:
        h = HOLD.get((r['pos'], d))
        if h and f"{r['pos']}@{d}" not in vac: return h
        if r['kind'] == 'POSITION_OF_ORG': return None
        d = DEP.get(d)
    return None
def route(doc, amt, requester, dept, delegation=None):
    cand = [r for r in RS if r['doc'] == doc and matches(r, amt)]
    if not cand: return {'error': 'DOA_NOT_CONFIGURED'}
    if len(cand) > 1: return {'error': 'DOA_AMBIGUOUS'}
    top = cand[0]; band = sorted([r for r in RS if r['doc'] == doc], key=lower); conf = {requester}
    ap = approver(top, dept)
    if ap is None: return {'error': 'APPROVER_NOT_FOUND', 'rule': top['code']}
    res = {'rule': top['code'], 'escalated': 'N'}
    if ap in conf:
        if SELF == 'BLOCK': return {'error': 'SOD_VIOLATION'}
        for r in band[band.index(top) + 1:]:
            a2 = approver(r, dept)
            if a2 is None: return {'error': 'APPROVER_NOT_FOUND', 'rule': r['code']}
            if a2 not in conf: ap = a2; res['escalated'] = 'Y'; break
        else: return {'error': 'NO_HIGHER_AUTHORITY'}
    res['approver'] = ap
    if delegation and delegation[0] == ap and delegation[1] not in conf: res['approver'] = delegation[1]; res['principal'] = ap
    return res
def band_lint(rules):
    """Gaps and overlaps of the amount bands per document type (BR-DOA-08 ก)."""
    errs, docs = [], []
    for r in rules:
        if r['doc'] not in docs: docs.append(r['doc'])
    for doc in docs:
        rs = sorted([r for r in rules if r['doc'] == doc and is_amt(r)], key=lower)
        if not rs: continue
        prev, inf = 0, False
        for r in rs:
            lo = lower(r)
            if inf: errs.append(f'{doc} ทับกันหลังช่วงสุดท้าย ({r["code"]})'); continue
            if lo > prev: errs.append(f'{doc} มีช่องว่าง {baht(prev)}–{baht(lo)} (ก่อน {r["code"]})')
            elif lo < prev: errs.append(f'{doc} ทับกัน {baht(lo)}–{baht(prev)} ({r["code"]})')
            if r['lte'] is None: inf = True
            else: prev = max(prev, r['lte'])
        if not inf: errs.append(f'{doc} ไม่ครอบคลุมยอดที่เกิน {baht(prev)}')
    return errs
errs, warns = band_lint(RS), []
for g in ('DOA_CHANGE', 'ORG_AUTHORITY_CHANGE'):
    gr = [r for r in RS if r['doc'] == g]
    if not gr: errs.append(f'ไม่มีข้อ {g}')
    for r in gr:
        if approver(r, ROOT) is None: errs.append(f'{r["code"]} หาผู้อนุมัติไม่ได้ (ลูกค้าจะแก้ DOA ไม่ได้)')
for r in RS:
    if r['doc'] in ('DOA_CHANGE', 'ORG_AUTHORITY_CHANGE'): continue
    if r['kind'] == 'MEMBER': warns.append(f'{r["code"]} ระบุตัวบุคคล')
    elif not any(p == r['pos'] and (r['kind'] != 'POSITION_OF_ORG' or d == ROOT) for (p, d) in HOLD): warns.append(f'{r["code"]} ตำแหน่ง {r["pos"]} ว่าง')
check(not errs, 'DOA ผ่าน lint (BR-DOA-08)', 'ครอบคลุม (0, ∞) ไม่มีช่องว่าง ไม่ทับกัน มีข้อกำกับที่หาผู้อนุมัติได้' + (f' · warning: {warns}' if warns else ''),
      '; '.join(errs), 'ยอดบางช่วงไม่มีผู้อนุมัติ หรือลูกค้าล็อกตัวเองออกจากการแก้ DOA', 'แก้ gt/lte ให้ต่อกันพอดี และให้มีข้อ DOA_CHANGE กับ ORG_AUTHORITY_CHANGE ที่มีผู้ดำรงตำแหน่ง')

# ---------- ค่าตั้งต้น ----------
sp = []
rate = SET.get('vatRate', (None, 0))[0]
if not isinstance(rate, (int, float)) or not 0 < rate < 1: sp.append(f'{at("Settings","value",SET.get("vatRate",(0,0))[1])} vatRate ต้องเป็นเศษส่วน เช่น 0.07')
for k, (v, r) in SET.items():
    if k.startswith('numbering.') and k != 'numbering.reset' and not re.search(r'\{SEQ\d+\}', s_(v)): sp.append(f'{at("Settings","value",r)} {k} ต้องมี {{SEQn}}')
    if k.endswith('Pct') and (not isinstance(v, (int, float)) or not 0 <= v <= 1): sp.append(f'{at("Settings","value",r)} {k} ต้องเป็นเศษส่วน 0–1')
    # S8-12 (BR-MATCH-13): thresholds in basis points, money as baht text, the one timing of phase 1, the inbox address
    if k.endswith('Bp') and k.startswith('matching.') and (not isinstance(v, (int, float)) or int(v) != v or not 0 <= v <= 10000): sp.append(f'{at("Settings","value",r)} {k} ต้องเป็นจำนวนเต็ม 0–10000')
    if k in ('matching.priceTolAmount', 'matching.vatTolAmount', 'wht.minimumBase') and not re.fullmatch(r'\d{1,13}\.\d{2}', s_(v)): sp.append(f'{at("Settings","value",r)} {k} ต้องเป็นบาทแบบข้อความ เช่น 1000.00')
    if k == 'wht.timing' and s_(v) != 'AT_PAYMENT': sp.append(f'{at("Settings","value",r)} wht.timing ระยะ 1 ต้องเป็น AT_PAYMENT')
    if k == 'ap.defaultTermDays' and (not isinstance(v, (int, float)) or int(v) != v or not 0 <= v <= 180): sp.append(f'{at("Settings","value",r)} ap.defaultTermDays ต้องเป็น 0–180 วัน')
    if k == 'ap.inboxAddress' and not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', s_(v)): sp.append(f'{at("Settings","value",r)} ap.inboxAddress ต้องเป็นอีเมล')
# S6 keys: the same ranges as OrgSettingsSchema in src/lib/org-settings.ts · the phase-1 file must have them all
S6_SET = {'duplicateCheck.windowDays': (1, 3660), 'priceRef.windowDays': (1, 3660), 'priceRef.minSamples': (1, None),
          'budget.forecastMinElapsedDays': (1, 3660), 'budget.overrunLapseDays': (1, 3660)}
S6_LIST = {'budget.alertThresholdsBp': (1, 100000), 'renewal.milestoneDays': (1, 3660)}
def whole_in(v, lo, hi): return isinstance(v, int) and not isinstance(v, bool) and v >= lo and (hi is None or v <= hi)
for k in [*S6_SET, *S6_LIST, 'numbering.BT', 'numbering.OB']:
    if k not in SET:
        if PROFILE == 'p1': sp.append(f'ชีต Settings ไม่มีแถว {k} (ค่าตั้งของ S6)')
        continue
    v, r = SET[k]
    if k in S6_SET and not whole_in(v, *S6_SET[k]): sp.append(f'{at("Settings","value",r)} {k} ต้องเป็นจำนวนเต็ม {S6_SET[k][0]}' + (f'–{S6_SET[k][1]}' if S6_SET[k][1] else ' ขึ้นไป'))
    if k in S6_LIST:
        parts = s_(v).split(',')
        if not all(re.fullmatch(r'\s*\d+\s*', p_) and whole_in(int(p_), *S6_LIST[k]) for p_ in parts): sp.append(f'{at("Settings","value",r)} {k} ต้องเป็นจำนวนเต็ม {S6_LIST[k][0]}–{S6_LIST[k][1]} คั่นด้วยจุลภาค')
hs, he = s_(SET.get('businessHoursStart', ('', 0))[0]), s_(SET.get('businessHoursEnd', ('', 0))[0])
if not (re.fullmatch(r'\d\d:\d\d', hs) and re.fullmatch(r'\d\d:\d\d', he) and hs < he): sp.append('businessHoursStart/End ต้องเป็น HH:MM และเริ่มก่อนเลิก')
# S17-01: the chat and the BCS Go app, the highest value of each key = S17_SETTING_LIMITS of src/lib/s17-settings.ts
# (tests/unit/s17-settings.test.ts reads this line) · the phase-1 file must have them all, the demo file none
S17_MAX = {'chatIntake.windowMinutes': 1440, 'chatIntake.maxImages': 10, 'chatIntake.maxTextChars': 2000, 'chatIntake.hourlyLimit': 1000, 'chatIntake.expireHours': 168, 'chatIntake.textRetentionDays': 30, 'bcsGo.offlineRetentionDays': 30, 'bcsGo.maxPreparedPos': 200}
for k in ['chatIntake.enabled', *S17_MAX]:
    if k not in SET:
        if PROFILE == 'p1': sp.append(f'ชีต Settings ไม่มีแถว {k} (ค่าตั้งของ S17)')
        continue
    v, r = SET[k]
    if k == 'chatIntake.enabled':
        if s_(v) not in ('Y', 'N'): sp.append(f'{at("Settings","value",r)} {k} ต้องเป็น Y หรือ N')
    elif not (isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= S17_MAX[k]): sp.append(f'{at("Settings","value",r)} {k} ต้องเป็นจำนวนเต็ม 1–{S17_MAX[k]}')
check(not sp, 'ค่าตั้งต้น (Settings)', f'{len(SET)} ค่า', '; '.join(sp), 'ระบบคำนวณ VAT เลขเอกสาร หรือ SLA ผิด', 'แก้ช่องที่ระบุในชีต Settings')
RATE_BP = int(round(float(rate) * 10000)) if isinstance(rate, (int, float)) else 700

# ---------- ข้อมูลอ้างอิงอื่น ----------
SUP, sup_p = {}, []
for r, d in table('Suppliers'):
    c = s_(d['code'])
    if c in SUP: sup_p.append(f'{c} ซ้ำ')
    if not taxid_ok(d['taxId']): sup_p.append(f'{at("Suppliers","taxId",r)} {s_(d["taxId"])} ไม่ผ่าน mod-11')
    if s_(d['vatRegistered']) not in ('Y', 'N'): sup_p.append(f'{at("Suppliers","vatRegistered",r)} ต้องเป็น Y หรือ N')
    SUP[c] = (re.sub(r'[\s-]', '', s_(d['taxId'])), s_(d['branchCode']))
pairs = list(SUP.values())
if len(set(pairs)) != len(pairs): sup_p.append('มีผู้ขายเลขผู้เสียภาษีและสาขาซ้ำ')
check(not sup_p, 'ผู้ขาย', f'{len(SUP)} ราย เลขผู้เสียภาษีผ่าน mod-11 ทั้งหมด', '; '.join(sup_p), 'สร้างผู้ขายไม่ได้ (BR-TAXID-01)', 'แก้ช่องที่ระบุในชีต Suppliers')
SITE = {s_(d['code']) for r, d in table('Sites')}
TYPES = {s_(d['code']): s_(d['documentType']) for r, d in table('RequestTypes')}
tp = [c for c, t in TYPES.items() if t not in ('PURCHASE_REQUEST', 'SUPPLIER_REQUEST')]
# S8-12 (BR-RET-03 · OQ-125): the retention a PO of the type starts with, when the sheet has the columns
for r, d in table('RequestTypes'):
    if 'defaultRetentionBp' not in d: continue
    bp, days = d['defaultRetentionBp'], d.get('defaultRetentionHoldDays')
    if not isinstance(bp, (int, float)) or int(bp) != bp or not 0 <= bp <= 10000: tp.append(f'{at("RequestTypes","defaultRetentionBp",r)} ต้องเป็นจำนวนเต็ม 0–10000')
    elif bp > 0 and (not isinstance(days, (int, float)) or int(days) != days or not 0 <= days <= 3650): tp.append(f'{at("RequestTypes","defaultRetentionHoldDays",r)} ต้องเป็น 0–3650 วันเมื่อมีเงินประกัน')
check(SITE and TYPES and not tp, 'สถานที่ส่งและประเภทคำขอ', f'{len(SITE)} สถานที่ · {len(TYPES)} ประเภท', f'documentType ไม่ถูกต้อง: {tp}', 'ฟอร์มหรือการรวม PR ทำงานผิด', 'ใส่ documentType เป็น PURCHASE_REQUEST หรือ SUPPLIER_REQUEST')
hol, hp = [], []
for r, d in table('Holidays'):
    v = d['date']
    if not isinstance(v, (datetime, date)): hp.append(f'{at("Holidays","date",r)} ไม่ใช่วันที่'); continue
    hol.append(v.date() if isinstance(v, datetime) else v)
if len(set(hol)) != len(hol): hp.append('วันหยุดซ้ำ')
wk = [str(x) for x in hol if x.weekday() >= 5]
check(not hp, 'วันหยุด', f'{len(hol)} วัน' + (f' · ตรงเสาร์อาทิตย์ {wk} (ตรวจว่าตั้งใจ)' if wk else ''), '; '.join(hp), 'นับ SLA ผิด', 'ใส่วันที่ในรูปแบบวันที่ของ Excel')

STAT = {'COMPLETED','ORDERED','APPROVED','PENDING_APPROVAL','RETURNED','REJECTED','CANCELLED'}; DECIDED = STAT - {'PENDING_APPROVAL','CANCELLED'}
low_pct = SET.get('digest.budgetLowPct', (0.1, 0))[0]

def history_route_checks(ref, d, sheet, req, dept, st, net, rbad, chbad, overdue, counters):
    """Route, channel and hour rules shared by Demo_History and Request_History (BR-DOA-02..06, BR-TOK-05)."""
    vat = rhu(net * RATE_BP, 10000); gross = net + vat; amt = gross if BASIS == 'GROSS' else net
    rt = route('PURCHASE_REQUEST', amt, req, dept); exp = (s_(d['expectedRule']), s_(d['expectedApprover']), s_(d['escalated']) or 'N')
    if 'error' in rt or (rt['rule'], rt['approver'], rt['escalated']) != exp:
        rbad.append(f'{ref} (รวม VAT {baht(gross)}): คาด {exp} แต่ engine ได้ {rt}')
    ch = s_(d['channel'])
    if st in DECIDED:
        counters['decided'] += 1; counters['viachat'] += ch in ('LINE_CHAT', 'LIFF')
        if ch not in ('LINE_CHAT', 'LIFF', 'WEB'): chbad.append(f'{at(sheet,"channel",d["_r"])} ตัดสินแล้วต้องมีช่องทาง')
        if ch == 'LINE_CHAT' and amt >= STEPUP: chbad.append(f'{ref}: ยอด {baht(amt)} ต้องยืนยัน PIN จึงอนุมัติจากปุ่มในแชทไม่ได้ (BR-TOK-05)')
        if ch == 'LINE_CHAT' and st in ('REJECTED', 'RETURNED'): chbad.append(f'{ref}: ไม่อนุมัติหรือตีกลับต้องกรอกเหตุผลใน LIFF หรือเว็บ')
    elif ch: chbad.append(f'{ref}: ยังค้างอยู่แต่มีช่องทาง')
    hrs = d['hours']
    if not isinstance(hrs, (int, float)) or hrs < 0: chbad.append(f'{at(sheet,"hours",d["_r"])} ต้องเป็นตัวเลข ≥ 0')
    elif st == 'PENDING_APPROVAL' and 'rule' in rt:
        sla = next(x['sla'] for x in RS if x['code'] == rt['rule'])
        if hrs > sla: overdue.append(f'{ref} ค้าง {hrs} ชม. ที่ {rt.get("approver")} (SLA {sla})')
    return vat, gross

if PROFILE == 'demo':
    # ---------- คำขอย้อนหลัง ----------
    BUD = {}
    for r, d in table('Budget'): BUD[s_(d['code'])] = {'dept': s_(d['department']), 'planned': sat(d['planned']), 'row': r, 'used': d['usedDemo'], 'rem': d['remaining']}
    used = {k: 0 for k in BUD}; refp, arith, rbad, chbad, overdue = [], [], [], [], []; cnts = {'decided': 0, 'viachat': 0}
    for r, d in table('Demo_History'):
        d['_r'] = r
        ref, req, dept, line, st = s_(d['ref']), s_(d['requester']), s_(d['chargedDept']), s_(d['budgetLine']), s_(d['status'])
        if req not in USR: refp.append(f'{ref}: ไม่มีผู้ใช้ {req}')
        elif USR[req]['dept'] != dept: refp.append(f'{ref}: {req} อยู่ {USR[req]["dept"]} แต่ตั้งเบิก {dept} (ต้องมีสิทธิ์ใช้งบข้ามฝ่าย)')
        if line not in BUD: refp.append(f'{ref}: ไม่มีบรรทัดงบ {line}'); continue
        if BUD[line]['dept'] != dept: refp.append(f'{ref}: บรรทัดงบ {line} เป็นของ {BUD[line]["dept"]}')
        if s_(d['requestType']) not in TYPES: refp.append(f'{ref}: ไม่มีประเภท {s_(d["requestType"])}')
        if s_(d['supplier']) not in SUP: refp.append(f'{ref}: ไม่มีผู้ขาย {s_(d["supplier"])}')
        if s_(d['site']) not in SITE: refp.append(f'{ref}: ไม่มีสถานที่ {s_(d["site"])}')
        if st not in STAT: refp.append(f'{at("Demo_History","status",r)} สถานะ {st}')
        if Decimal(str(d['net'])) % 1 != 0: refp.append(f'{at("Demo_History","net",r)} ยอดก่อน VAT ต้องเป็นบาทเต็ม (ใบเสนอราคาเปรียบเทียบ 104% และ 107% ต้องลงตัวที่สตางค์ และห้ามปัด BR-MONEY-02)')
        net = sat(d['net'])
        vat, gross = history_route_checks(ref, d, 'Demo_History', req, dept, st, net, rbad, chbad, overdue, cnts)
        cnt = 0 if st in ('REJECTED', 'CANCELLED') else net
        for key, want in (('vat', vat), ('gross', gross), ('countsAgainstBudget', cnt)):
            if d[key] is None: arith.append(f'{at("Demo_History",key,r)} ยังไม่มีค่าที่คำนวณ (บันทึกไฟล์จาก Excel ก่อน)')
            elif sat(d[key]) != want: arith.append(f'{at("Demo_History",key,r)} ได้ {baht(sat(d[key]))} ควรเป็น {baht(want)}')
        used[line] += cnt
    nh = len(table('Demo_History'))
    check(not refp, 'คำขอย้อนหลัง: ข้อมูลอ้างอิง', f'{nh} รายการ อ้างผู้ใช้ แผนก งบ ผู้ขาย สถานที่ได้ครบ', '; '.join(refp[:8]), 'seed สร้างคำขอไม่ได้', 'แก้รหัสในแถวที่ระบุของชีต Demo_History')
    check(not arith, 'คำขอย้อนหลัง: VAT ยอดรวม และยอดที่นับเข้างบ', f'{nh} รายการ ตรงกับการคำนวณ half-up ระดับเอกสาร', '; '.join(arith[:8]), 'dashboard งบและ DOA ใช้ยอดผิด', 'แก้ตามค่าที่ระบุ (สูตรต้องอ้าง Settings!$B$3)')
    check(not rbad, 'คำขอย้อนหลัง: เส้นทาง DOA ตรงกับ engine', f'{nh} รายการ ข้อ ผู้อนุมัติ และการยกระดับตรงทุกแถว', '; '.join(rbad[:6]), 'ข้อมูล demo ขัดกับกฎ DOA ที่กำลังโชว์', 'แก้ expectedRule expectedApprover หรือ escalated ตามค่าที่ engine ได้')
    check(not chbad, 'คำขอย้อนหลัง: ช่องทางและเวลา', 'สอดคล้องกับกติกา step-up และการกรอกเหตุผล', '; '.join(chbad[:6]), 'ข้อมูล audit ใน demo ขัดกับกติกาของระบบ', 'แก้คอลัมน์ channel หรือ hours ในแถวที่ระบุ')

    # ---------- งบ ----------
    bp = []
    for k, b in BUD.items():
        if b['planned'] <= 0: bp.append(f'{at("Budget","planned",b["row"])} ต้องมากกว่า 0')
        if used[k] > b['planned']: bp.append(f'{k}: ใช้ {baht(used[k])} เกินงบ {baht(b["planned"])}')
        for key, want in (('used', used[k]), ('rem', b['planned'] - used[k])):
            col = 'usedDemo' if key == 'used' else 'remaining'
            if b[key] is None: bp.append(f'{at("Budget",col,b["row"])} ยังไม่มีค่าที่คำนวณ')
            elif sat(b[key]) != want: bp.append(f'{at("Budget",col,b["row"])} ได้ {baht(sat(b[key]))} ควรเป็น {baht(want)}')
    low = [f'{k} เหลือ {(b["planned"] - used[k]) / b["planned"]:.1%}' for k, b in BUD.items() if b['planned'] and (b['planned'] - used[k]) / b['planned'] < low_pct]
    check(not bp, 'งบ: ยอดใช้และคงเหลือ', f'{len(BUD)} บรรทัด รวม {baht(sum(b["planned"] for b in BUD.values()))} · ตรงกับคำขอย้อนหลัง', '; '.join(bp), 'dashboard งบแสดงตัวเลขผิดต่อหน้าลูกค้า', 'แก้ตามช่องที่ระบุ')
    share = cnts['viachat'] / cnts['decided'] if cnts['decided'] else 0
    story = bool(overdue) and bool(low) and share >= 0.6
    check(story, 'ข้อมูลพอสำหรับฉาก dashboard', f'ค้างเกิน SLA: {overdue} · งบใกล้หมด: {low} · อนุมัติผ่าน LINE {share:.0%}',
          f'ค้างเกิน SLA {overdue or "ไม่มี"} · งบใกล้หมด {low or "ไม่มี"} · LINE {share:.0%}', 'ฉาก 9 ไม่มีอะไรให้โชว์', 'เพิ่มคำขอที่ค้างเกิน SLA หรือปรับยอดให้มีบรรทัดงบเหลือต่ำกว่าเกณฑ์')

    # ---------- สคริปต์ demo ----------
    remain = {k: BUD[k]['planned'] - used[k] for k in BUD}; sp, mins, ns = [], 0, 0
    for r, d in table('Demo_Script'):
        ns += 1; sc, actor = s_(d['scene']), s_(d['actor']); mins += d['minutes'] or 0
        if actor not in USR: sp.append(f'ฉาก {sc}: ไม่มีผู้ใช้ {actor}')
        if d['net'] in (None, ''): continue
        line, dept = s_(d['budgetLine']), s_(d['chargedDept'])
        if line not in BUD: sp.append(f'ฉาก {sc}: ไม่มีบรรทัดงบ {line}'); continue
        net = sat(d['net']); vat = rhu(net * RATE_BP, 10000); gross = net + vat
        for key, want in (('vat', vat), ('gross', gross)):
            if d[key] is None or sat(d[key]) != want: sp.append(f'{at("Demo_Script",key,r)} ควรเป็น {baht(want)}')
        out = s_(d['expectedOutcome'])
        if out == 'BLOCKED':
            if net <= remain[line]: sp.append(f'ฉาก {sc}: คาดว่างบไม่พอ แต่ {line} ยังเหลือ {baht(remain[line])}')
            continue
        if net > remain[line]: sp.append(f'ฉาก {sc}: งบ {line} เหลือ {baht(remain[line])} ไม่พอ {baht(net)}')
        remain[line] -= net
        dl = tuple(s_(d['delegation']).split('>')) if s_(d['delegation']) else None
        rt = route('PURCHASE_REQUEST', gross if BASIS == 'GROSS' else net, actor, dept, dl)
        exp = (s_(d['expectedRule']), s_(d['expectedApprover']), s_(d['escalated']) or 'N')
        if 'error' in rt or (rt['rule'], rt['approver'], rt['escalated']) != exp: sp.append(f'ฉาก {sc} (รวม VAT {baht(gross)}): คาด {exp} แต่ engine ได้ {rt}')
    check(not sp, 'สคริปต์ demo: เส้นทาง งบ และสูตรของทุกฉาก', f'{ns} ฉาก · {mins} นาที · ยอดและผู้รับงานตรงกับ engine และงบพอเรียงตามลำดับฉาก', '; '.join(sp), 'ฉากที่เล่นจริงจะได้ผลไม่ตรงกับที่พูด', 'แก้ยอดหรือผลที่คาดของฉากที่ระบุ')

if PROFILE == 'p1':
    # ---------- งบสองปีงบ ศูนย์ต้นทุน และผังบัญชี ----------
    CC = {s_(d['code']): s_(d['department']) for r, d in table('CostCenters')}
    GL = {s_(d['code']) for r, d in table('GL_Accounts')}
    KEYS, BCODES, bp = {}, set(), []
    for r, d in table('Budget'):
        code, key, fy, dept = s_(d['code']), s_(d['budgetKey']), s_(d['fiscalYear']), s_(d['department'])
        if code in BCODES: bp.append(f'{code} ซ้ำ')
        BCODES.add(code)
        if not re.fullmatch(r'FY\d{4}', fy): bp.append(f'{at("Budget","fiscalYear",r)} ต้องเป็น FYปปปป')
        elif code != f'{key}-{fy[2:]}': bp.append(f'{at("Budget","code",r)} ต้องเป็น {key}-{fy[2:]}')
        if dept not in DEP: bp.append(f'{at("Budget","department",r)} ไม่มีแผนก {dept}')
        if s_(d['costCenter']) not in CC: bp.append(f'{at("Budget","costCenter",r)} ไม่มีในชีต CostCenters')
        elif CC[s_(d['costCenter'])] != dept: bp.append(f'{at("Budget","costCenter",r)} เป็นของ {CC[s_(d["costCenter"])]} ไม่ใช่ {dept}')
        if s_(d['accountCode']) not in GL: bp.append(f'{at("Budget","accountCode",r)} ไม่มีในชีต GL_Accounts')
        if not money_ok(d['planned']) or sat(d['planned']) <= 0: bp.append(f'{at("Budget","planned",r)} ต้องเป็นเงินบวกไม่เกิน 2 ตำแหน่ง')
        ent = KEYS.setdefault(key, {'dept': dept, 'fy': {}})
        if ent['dept'] != dept: bp.append(f'{key}: แต่ละปีงบอยู่คนละแผนก')
        if fy in ent['fy']: bp.append(f'{key} {fy} ซ้ำ')
        ent['fy'][fy] = sat(d['planned']) if money_ok(d['planned']) else 0
    badcc = [c for c, dep in CC.items() if dep not in DEP]
    if badcc: bp.append(f'CostCenters อ้างแผนกที่ไม่มี: {badcc}')
    fys = sorted({fy for e in KEYS.values() for fy in e['fy']})
    check(not bp, 'งบ ศูนย์ต้นทุน และผังบัญชี', f'{len(KEYS)} กุญแจงบ × {len(fys)} ปีงบ ({", ".join(fys)}) · {len(CC)} ศูนย์ต้นทุน · {len(GL)} บัญชี', '; '.join(bp[:8]),
          'seed สร้างบรรทัดงบไม่ได้ หรือไฟล์ส่ง Express อ้างบัญชีผิด', 'แก้ชีต Budget CostCenters หรือ GL_Accounts ตามช่องที่ระบุ')

    # ---------- ธนาคาร ภาษีหัก ณ ที่จ่าย และการจ่ายผู้ขาย ----------
    BANKS = {s_(d['code']) for r, d in table('Banks')}
    WHT, pp = {}, []
    for r, d in table('WHT_Types'):
        c, bpv = s_(d['code']), d['rateBp']
        if not isinstance(bpv, (int, float)) or not 0 < bpv <= 1500 or int(bpv) != bpv: pp.append(f'{at("WHT_Types","rateBp",r)} ต้องเป็นจำนวนเต็ม 1–1500')
        if s_(d['form']) not in ('PND3', 'PND53', 'PND3_53'): pp.append(f'{at("WHT_Types","form",r)} ต้องเป็น PND3 PND53 หรือ PND3_53')
        WHT[c] = int(bpv) if isinstance(bpv, (int, float)) else 0
    seen = {}
    for r, d in table('SupplierPayment'):
        c = s_(d['supplierCode'])
        if c not in SUP: pp.append(f'{at("SupplierPayment","supplierCode",r)} ไม่มีผู้ขาย {c}'); continue
        seen[c] = seen.get(c, 0) + 1
        if s_(d['payeeType']) not in ('JURISTIC', 'INDIVIDUAL'): pp.append(f'{at("SupplierPayment","payeeType",r)} ต้องเป็น JURISTIC หรือ INDIVIDUAL')
        if s_(d['whtIncomeType']) and s_(d['whtIncomeType']) not in WHT: pp.append(f'{at("SupplierPayment","whtIncomeType",r)} ไม่มีในชีต WHT_Types')
        t = d['paymentTermDays']
        if not isinstance(t, (int, float)) or not 0 <= t <= 180: pp.append(f'{at("SupplierPayment","paymentTermDays",r)} ต้องเป็น 0–180 วัน')
        if s_(d['bankCode']) not in BANKS: pp.append(f'{at("SupplierPayment","bankCode",r)} ไม่มีในชีต Banks')
        if not re.fullmatch(r'\d{10,12}', re.sub(r'-', '', s_(d['accountNo']))): pp.append(f'{at("SupplierPayment","accountNo",r)} เลขบัญชีต้องเป็นตัวเลข 10–12 หลัก')
        if not s_(d['accountName']): pp.append(f'{at("SupplierPayment","accountName",r)} ว่าง')
        if s_(d['eTaxIssuer']) not in ('NONE', 'EMAIL', 'FULL'): pp.append(f'{at("SupplierPayment","eTaxIssuer",r)} ต้องเป็น NONE EMAIL หรือ FULL')
        if s_(d['registryStatus']) not in ('ACTIVE', 'CEASED', 'VAT_CANCELLED'): pp.append(f'{at("SupplierPayment","registryStatus",r)} ต้องเป็น ACTIVE CEASED หรือ VAT_CANCELLED')
    pp += [f'{c} มีข้อมูลการจ่าย {n} แถว' for c, n in seen.items() if n != 1] + [f'{c} ไม่มีข้อมูลการจ่าย' for c in SUP if c not in seen]
    for r, d in table('CompanyBankAccounts'):
        if s_(d['bankCode']) not in BANKS: pp.append(f'{at("CompanyBankAccounts","bankCode",r)} ไม่มีในชีต Banks')
    STATUS = {s_(d['supplierCode']): s_(d['registryStatus']) for r, d in table('SupplierPayment')}
    check(not pp, 'การจ่ายผู้ขาย ธนาคาร และภาษีหัก ณ ที่จ่าย', f'{len(seen)} ผู้ขายมีบัญชีรับเงิน · {len(BANKS)} ธนาคาร · {len(WHT)} ประเภทเงินได้ · ไม่ใช้งาน {sum(1 for v in STATUS.values() if v != "ACTIVE")} ราย',
          '; '.join(pp[:8]), 'รอบจ่ายและไฟล์ธนาคารของ S9 หรือภาษีหัก ณ ที่จ่ายของ S8 ใช้ข้อมูลผิด', 'แก้ชีต SupplierPayment WHT_Types Banks หรือ CompanyBankAccounts')

    # ---------- รายการสินค้า ----------
    ITEMS, ip_ = {}, []
    for r, d in table('Items'):
        c = s_(d['code'])
        if c in ITEMS: ip_.append(f'{c} ซ้ำ')
        if not money_ok(d['refUnitPrice']) or sat(d['refUnitPrice']) <= 0: ip_.append(f'{at("Items","refUnitPrice",r)} ต้องเป็นเงินบวกไม่เกิน 2 ตำแหน่ง')
        if s_(d['accountCode']) not in GL: ip_.append(f'{at("Items","accountCode",r)} ไม่มีในชีต GL_Accounts')
        if s_(d['isService']) not in ('Y', 'N'): ip_.append(f'{at("Items","isService",r)} ต้องเป็น Y หรือ N')
        if s_(d['whtIncomeType']) and s_(d['whtIncomeType']) not in WHT: ip_.append(f'{at("Items","whtIncomeType",r)} ไม่มีในชีต WHT_Types')
        if s_(d['agreementSupplier']):
            if s_(d['agreementSupplier']) not in SUP: ip_.append(f'{at("Items","agreementSupplier",r)} ไม่มีผู้ขาย')
            if not money_ok(d['agreedUnitPrice']) or sat(d['agreedUnitPrice']) <= 0: ip_.append(f'{at("Items","agreedUnitPrice",r)} ต้องเป็นเงินบวก')
        ITEMS[c] = {'unit': s_(d['unit'])}
    check(not ip_, 'รายการสินค้าและราคาที่ตกลง', f'{len(ITEMS)} รายการ', '; '.join(ip_[:8]), 'แคตตาล็อกและราคาอ้างอิงผิด', 'แก้ชีต Items ตามช่องที่ระบุ')

    # ---------- ร่างผู้ตรวจคู่ขนานของระยะ 1 (S6 อ่านเอง) ----------
    dr = []
    for r, d in table('Workflow_Reviewers'):
        if s_(d['requestType']) not in TYPES: dr.append(f'{at("Workflow_Reviewers","requestType",r)} ไม่มีประเภทคำขอ')
        if (s_(d['reviewerPosition']), s_(d['reviewerDepartment'])) not in HOLD: dr.append(f'{at("Workflow_Reviewers","reviewerPosition",r)} ไม่มีผู้ดำรง {s_(d["reviewerPosition"])}@{s_(d["reviewerDepartment"])}')
        if s_(d['mode']) not in ('ALL', 'ANY'): dr.append(f'{at("Workflow_Reviewers","mode",r)} ต้องเป็น ALL หรือ ANY')
        # S6 (BR-WF-07, BR-WF-08): the condition the seed reads, and a fallback that walks up to a holder
        try:
            w = json.loads(s_(d['whenJson']) or 'null')
            if not isinstance(w, dict): raise ValueError('not an object')
            for x in wf_fields(w):
                if x.startswith('$') and x not in ('$amountGross', '$amountNet', '$requestType', '$lineCategories', '$budgetAccountCodes'): dr.append(f'{at("Workflow_Reviewers","whenJson",r)} ไม่รู้จักตัวแปร {x}')
        except ValueError as e: dr.append(f'{at("Workflow_Reviewers","whenJson",r)} ไม่ใช่ JSON ของเงื่อนไข ({e})')
        fp, fd = s_(d['fallbackPosition']), s_(d['fallbackDepartment'])
        if fp or fd:
            dd, held = fd, False
            while dd and not held: held = (fp, dd) in HOLD; dd = DEP.get(dd)
            if not held: dr.append(f'{at("Workflow_Reviewers","fallbackPosition",r)} ไม่มีผู้ดำรง {fp}@{fd} ทั้งฝ่ายและสายขึ้นไป')
    check(not dr, 'ผู้ตรวจคู่ขนานของระยะ 1 (WF-SIMEC ฉบับ 1)', f'{len(table("Workflow_Reviewers"))} ข้อ · ผู้ตรวจและผู้สำรองมีผู้ดำรงทุกข้อ · เงื่อนไขอ่านได้', '; '.join(dr[:8]),
          'seed สร้าง WF-SIMEC ไม่ได้ หรือได้ผู้ตรวจที่ไม่มีตัวตน', 'แก้ชีต Workflow_Reviewers ใน scripts/inputs_p1/p1_master.py')

    # ---------- ประวัติคำขอ (Request_History) ----------
    EXTRA = {'APPROVED': 1, 'REJECTED': 1, 'RETURNED': 1, 'CANCELLED': 1, 'ORDERED': 6, 'COMPLETED': 34}  # = scripts/inputs_p1/p1_history.py
    def safe_hours(days):  # = scripts/inputs_p1/p1_common.py guaranteed_business_hours
        return max(0, 9 * (days - 2 * ((days + 6) // 7) - 3) - 9) if days > 0 else 0
    REQ_FIELDS = {'HIRE_SERVICE': ('scopeOfWork', 'servicePeriod', 'processesPersonalData', 'accessesSystems', 'accessesPremises'),
                  'CONTRACT_WORK': ('scopeOfWork', 'milestones', 'site'),
                  'IT_PURCHASE': ('category', 'processesPersonalData', 'accessesSystems', 'accessesPremises')}
    SCEN = {'MATCH', 'PRICE_WITHIN_TOL', 'PRICE_OVER', 'QTY_OVER', 'DUPLICATE', 'SERVICE_2WAY', 'MISSING'}
    used = {k: 0 for k in KEYS}; refs, titles = set(), set()
    refp, arith, rbad, chbad, overdue, timing, inv = [], [], [], [], [], [], []; cnts = {'decided': 0, 'viachat': 0}
    for r, d in table('Request_History'):
        d['_r'] = r
        ref, req, dept, key, st = s_(d['ref']), s_(d['requester']), s_(d['chargedDept']), s_(d['budgetKey']), s_(d['status'])
        if not re.fullmatch(r'H\d{3}', ref) or ref in refs: refp.append(f'{at("Request_History","ref",r)} ต้องเป็น Hnnn และไม่ซ้ำ')
        refs.add(ref)
        if s_(d['title']) in titles: refp.append(f'{ref}: ชื่อเรื่องซ้ำ (เทสต์จับคู่คำขอด้วยชื่อเรื่อง)')
        titles.add(s_(d['title']))
        if req not in USR: refp.append(f'{ref}: ไม่มีผู้ใช้ {req}')
        elif USR[req]['dept'] != dept: refp.append(f'{ref}: {req} อยู่ {USR[req]["dept"]} แต่ตั้งเบิก {dept}')
        if key not in KEYS: refp.append(f'{ref}: ไม่มีกุญแจงบ {key}'); continue
        if KEYS[key]['dept'] != dept: refp.append(f'{ref}: งบ {key} เป็นของ {KEYS[key]["dept"]}')
        if TYPES.get(s_(d['requestType'])) != 'PURCHASE_REQUEST': refp.append(f'{ref}: ประเภท {s_(d["requestType"])} ไม่ใช่คำขอซื้อ')
        if s_(d['supplier']) not in SUP: refp.append(f'{ref}: ไม่มีผู้ขาย {s_(d["supplier"])}')
        elif st == 'PENDING_APPROVAL' and STATUS.get(s_(d['supplier'])) == 'CEASED': refp.append(f'{ref}: คำขอที่ยังค้างใช้ผู้ขายที่เลิกกิจการ')
        if s_(d['site']) not in SITE: refp.append(f'{ref}: ไม่มีสถานที่ {s_(d["site"])}')
        if s_(d['itemCode']) not in ITEMS: refp.append(f'{ref}: ไม่มีรายการ {s_(d["itemCode"])}')
        if st not in STAT: refp.append(f'{at("Request_History","status",r)} สถานะ {st}')
        days = d['daysAgo']
        if not isinstance(days, (int, float)) or not 0 <= days <= 366 or int(days) != days: refp.append(f'{at("Request_History","daysAgo",r)} ต้องเป็นจำนวนเต็ม 0–366')
        if Decimal(str(d['net'])) % 1 != 0: refp.append(f'{at("Request_History","net",r)} ยอดก่อน VAT ต้องเป็นบาทเต็ม (BR-MONEY-02)')
        net = sat(d['net'])
        try:
            if sat(Decimal(str(d['qty'])) * Decimal(str(d['unitPrice']))) != net: arith.append(f'{ref}: จำนวน × ราคาต่อหน่วย ไม่เท่ายอดก่อน VAT')
        except Exception: arith.append(f'{ref}: จำนวนหรือราคาต่อหน่วยไม่ใช่ตัวเลข')
        vat, gross = history_route_checks(ref, d, 'Request_History', req, dept, st, net, rbad, chbad, overdue, cnts)
        cnt = 0 if st in ('REJECTED', 'CANCELLED') else net
        for k2, want in (('vat', vat), ('gross', gross), ('countsAgainstBudget', cnt)):
            if d[k2] is None or sat(d[k2]) != want: arith.append(f'{at("Request_History",k2,r)} ควรเป็น {baht(want)}')
        hrs = d['hours'] if isinstance(d['hours'], (int, float)) else 0
        if st in EXTRA and isinstance(days, (int, float)) and hrs + EXTRA[st] > safe_hours(int(days)):
            timing.append(f'{ref}: {st} {hrs} ชม. ไม่พอดีใน {int(days)} วัน (ใช้ได้ {safe_hours(int(days)) - EXTRA[st]} ชม.)')
        rt = s_(d['requestType'])
        if s_(d['form']):
            try:
                f = json.loads(s_(d['form']))
                lack_f = [x for x in REQ_FIELDS.get(rt, ()) if not s_(f.get(x))]
                if lack_f: refp.append(f'{ref}: ฟอร์มขาด {lack_f}')
            except Exception: refp.append(f'{at("Request_History","form",r)} ไม่ใช่ JSON')
        elif rt in REQ_FIELDS: refp.append(f'{ref}: {rt} ต้องมีคำตอบในฟอร์ม')
        sc = s_(d['invoiceScenario'])
        if sc and sc not in SCEN: inv.append(f'{ref}: invoiceScenario {sc}')
        if sc and st != 'COMPLETED': inv.append(f'{ref}: มีใบแจ้งหนี้แต่สถานะ {st}')
        if st == 'COMPLETED' and not sc: inv.append(f'{ref}: COMPLETED ต้องระบุ invoiceScenario')
        if sc and sc != 'MISSING' and not (s_(d['invoiceNo']) and s_(d['paymentStatus']) in ('PAID', 'DUE', 'OVERDUE', 'NOT_DUE')): inv.append(f'{ref}: ต้องมีเลขใบแจ้งหนี้และสถานะการจ่าย')
        if s_(d['whtIncomeType']) and s_(d['whtIncomeType']) not in WHT: inv.append(f'{ref}: ไม่มีประเภทหัก ณ ที่จ่าย {s_(d["whtIncomeType"])}')
        used[key] += cnt
    nh = len(refs)
    over = [f'{k}: ใช้ {baht(used[k])} เกินงบปีที่น้อยที่สุด {baht(min(e["fy"].values()))}' for k, e in KEYS.items() if e['fy'] and used[k] > min(e['fy'].values())]
    check(not refp, 'ประวัติคำขอ: ข้อมูลอ้างอิงและฟอร์ม', f'{nh} รายการ อ้างผู้ใช้ งบ ผู้ขาย สถานที่ รายการ และคำตอบในฟอร์มครบ', '; '.join(refp[:8]), 'seed สร้างคำขอไม่ได้', 'แก้ scripts/inputs_p1/p1_history.py แล้วสร้างไฟล์ใหม่')
    check(not arith, 'ประวัติคำขอ: จำนวน ราคา VAT ยอดรวม และยอดที่นับเข้างบ', f'{nh} รายการ ตรงกับการคำนวณ half-up ระดับเอกสาร', '; '.join(arith[:8]), 'dashboard งบและ DOA ใช้ยอดผิด', 'แก้ตัวสร้างข้อมูลแล้วสร้างไฟล์ใหม่')
    check(not rbad, 'ประวัติคำขอ: เส้นทาง DOA ตรงกับ engine', f'{nh} รายการ ข้อ ผู้อนุมัติ และการยกระดับตรงทุกแถว', '; '.join(rbad[:6]), 'ข้อมูลขัดกับกฎ DOA', 'แก้ตัวสร้างข้อมูลแล้วสร้างไฟล์ใหม่')
    check(not chbad and not timing, 'ประวัติคำขอ: ช่องทาง เวลา และการ seed ได้ทุกวันที่รัน', f'สอดคล้องกับ step-up การกรอกเหตุผล และเวลาทำการที่มีแน่ ๆ ใน daysAgo วัน',
          '; '.join((chbad + timing)[:6]), 'ข้อมูล audit ขัดกับกติกา หรือ seed ล้มในบางวัน', 'ลด hours หรือเพิ่ม daysAgo ของแถวที่ระบุในตัวสร้างข้อมูล')
    check(not inv and not over, 'ประวัติคำขอ: ใบแจ้งหนี้ การจ่าย และงบพอทุกปีงบ', f'{sum(1 for x in used.values() if x)} กุญแจงบถูกใช้ ไม่เกินงบของปีที่น้อยที่สุด', '; '.join((inv + over)[:8]),
          'S8 S9 seed ใบแจ้งหนี้หรือรอบจ่ายไม่ได้ หรือคำขอเกินงบ', 'แก้ตัวสร้างข้อมูลแล้วสร้างไฟล์ใหม่')
    low = [f'{k} เหลือ {(min(e["fy"].values()) - used[k]) / min(e["fy"].values()):.1%}' for k, e in KEYS.items() if e['fy'] and (min(e['fy'].values()) - used[k]) / min(e['fy'].values()) < low_pct]
    share = cnts['viachat'] / cnts['decided'] if cnts['decided'] else 0
    story = bool(overdue) and bool(low) and share >= 0.6
    check(story, 'ข้อมูลพอสำหรับฉาก dashboard', f'ค้างเกิน SLA: {overdue} · งบใกล้หมด: {low} · อนุมัติผ่าน LINE {share:.0%}',
          f'ค้างเกิน SLA {overdue or "ไม่มี"} · งบใกล้หมด {low or "ไม่มี"} · LINE {share:.0%}', 'หน้า dashboard และกระดานค้างไม่มีอะไรให้โชว์', 'เพิ่มคำขอค้างเกิน SLA หรือปรับยอดให้มีงบเหลือต่ำกว่าเกณฑ์')

    # ---------- คำตอบของเอกสารชุดประเมิน AI ----------
    ds, ndoc = [], 0
    for r, d in table('DocSamples'):
        ndoc += 1; sid = s_(d['sampleId'])
        if s_(d['docType']) not in ('QUOTATION', 'DELIVERY_NOTE', 'TAX_INVOICE', 'ETAX_XML'): ds.append(f'{sid}: docType {s_(d["docType"])}')
        if s_(d['historyRef']) not in refs: ds.append(f'{sid}: ไม่มีคำขอ {s_(d["historyRef"])}')
        if s_(d['supplierCode']) not in SUP: ds.append(f'{sid}: ไม่มีผู้ขาย')
        try: lines = json.loads(s_(d['linesJson']))
        except Exception: ds.append(f'{sid}: linesJson ไม่ใช่ JSON'); continue
        if d['net'] in (None, ''): continue
        amts = [rhu(int(Decimal(str(l['qty'])) * 10000) * sat(l['unitPrice']), 10000) for l in lines]
        tot = sum(amts)
        if s_(d['priceIncludesVat']) == 'Y': vat = rhu(tot * RATE_BP, 10000 + RATE_BP); net, gross = tot - vat, tot
        else: net, vat = tot, rhu(tot * RATE_BP, 10000); gross = net + vat
        for k2, want in (('net', net), ('vat', vat), ('gross', gross)):
            if sat(d[k2]) != want: ds.append(f'{sid}: {k2} ควรเป็น {baht(want)}')
        if d['expectedWhtBp'] not in (None, '') and sat(d['expectedWht']) != rhu(net * int(d['expectedWhtBp']), 10000): ds.append(f'{sid}: ภาษีหัก ณ ที่จ่ายที่คาดผิด (BR-WHT-01 ฐานก่อน VAT)')
    check(not ds, 'คำตอบของเอกสารชุดประเมิน AI', f'{ndoc} ฉบับ ยอดตรงกับการคำนวณ (VAT ระดับเอกสาร ราคารวม VAT และหัก ณ ที่จ่าย)', '; '.join(ds[:8]),
          'ชุดประเมินของ S13 วัดผลด้วยคำตอบที่ผิด', 'แก้ doc_samples ใน scripts/inputs_p1/p1_history.py')

# ---------- รายการข้อมูลและคำถาม ----------
def contiguous(ids, prefix):
    nums = sorted(int(x.split('-')[1]) for x in ids if x.startswith(prefix + '-'))
    return nums == list(range(1, len(nums) + 1))
inp = table('Inputs'); qs = table('Questions')
ip = [f'{s_(d["id"])}: ไม่มีชีต {s_(d["sheet"])}' for r, d in inp if s_(d['sheet']) not in ('', '-') and s_(d['sheet']) not in wb.sheetnames]
if not contiguous([s_(d['id']) for r, d in inp], 'IN'): ip.append('รหัส IN ไม่ต่อเนื่องหรือซ้ำ')
qids = [s_(d['id']) for r, d in qs]
if len(set(qids)) != len(qids) or not contiguous(qids, 'Q') or not contiguous(qids, 'B'): ip.append('รหัส Q หรือ B ไม่ต่อเนื่องหรือซ้ำ')
check(not ip, 'รายการข้อมูลและคำถาม', f'{len(inp)} รายการข้อมูล · {len(qs)} คำถาม', '; '.join(ip), 'ติดตามข้อมูลที่ต้องขอไม่ได้', 'แก้รหัสหรือชื่อชีตที่ระบุ')

# ---------- เทียบกับ spec ----------
if SPEC:
    try: import yaml
    except ImportError: yaml = None
    text = open(SPEC, encoding='utf-8').read()
    oq_spec = set(re.findall(r'^\| (OQ-\d+) \|', text, re.M)); defined = set(re.findall(r'^\| ((?:OQ|P0|A|ADR)-\d+) \|', text, re.M)) | set(re.findall(r'^- \[[ x]\] \*\*((?:P0|P1|S\d+|D|NEW)-\d+)\*\*', text, re.M))
    qrefs = set(re.findall(r'OQ-\d+', ' '.join(s_(d['ref']) for r, d in qs)))
    irefs = set(re.findall(r'(?:OQ|P0|A)-\d+', ' '.join(s_(d['ref']) for r, d in inp)))
    unknown = sorted((qrefs | irefs) - defined)
    if PROFILE == 'p1':
        notcov = sorted(oq_spec - qrefs)
        check(not unknown and not notcov, 'คำถามครอบคลุม OQ ทุกข้อใน spec', f'{len(oq_spec)} OQ มีคำถามรองรับครบ',
              f'OQ ที่ยังไม่มีคำถาม: {notcov} · อ้างถึงแต่ไม่มีใน spec: {unknown}', 'จะลืมถามเรื่องที่ spec ยังต้องการคำตอบ', 'เพิ่มคำถามใน scripts/inputs_p1/p1_texts.py แล้วสร้างไฟล์ใหม่ หรือแก้คอลัมน์ ref')
    else:
        notcov = sorted(x for x in oq_spec - qrefs if int(x.split('-')[1]) <= DEMO_LAST_OQ)
        check(not unknown and not notcov, 'คำถามครอบคลุม OQ ทุกข้อใน spec', f'{len([x for x in oq_spec if int(x.split("-")[1]) <= DEMO_LAST_OQ])} OQ มีคำถามรองรับครบ' + (' (OQ ใหม่กว่า OQ-39 อยู่ในไฟล์ระยะ 1)' if len(oq_spec) > DEMO_LAST_OQ else ''),
              f'OQ ที่ยังไม่มีคำถาม: {notcov} · อ้างถึงแต่ไม่มีใน spec: {unknown}', 'จะลืมถามเรื่องที่ spec ยังต้องการคำตอบ', 'เพิ่มแถวในชีต Questions หรือแก้คอลัมน์ ref')
    if yaml and PROFILE == 'demo':
        fx = {}
        for b in re.findall(r'```yaml\n(.*?)```', text, re.S):
            m = re.match(r'#\s*tests/golden/fixtures/(\S+)\.yaml', b.splitlines()[0])
            if m: fx[m.group(1)] = yaml.safe_load(b)
        org, dv = fx.get('org-demo'), fx.get('doa-versions')
        diff = []
        if org:
            if {(x['code'], x['parent']) for x in org['departments']} != set(DEP.items()): diff.append('ผังแผนกต่างจาก fixture')
            if {(x['position'], x['department'], x['member']) for x in org['positions']} != {(p, d, m) for (p, d), m in HOLD.items()}: diff.append('ผู้ดำรงตำแหน่งต่างจาก fixture')
        if dv:
            v1 = next(v for v in dv['versions'] if v['version'] == VER)
            def n(r):
                am = (r.get('when') or {}).get('amount') or {}
                return (r['code'], r['documentType'], sat(am['gt']) if 'gt' in am else None, sat(am['lte']) if 'lte' in am else None, r['approver']['kind'], r['approver'].get('position', ''))
            if {n(r) for r in v1['rules']} != {(r['code'], r['doc'], r['gt'], r['lte'], r['kind'], r['pos']) for r in RS}: diff.append(f'ข้อ DOA ฉบับ {VER} ต่างจาก fixture')
            if v1['amountBasis'] != BASIS or sat(v1['stepUpThreshold']) != STEPUP: diff.append('นโยบาย DOA ต่างจาก fixture')
        check(org and dv and not diff, 'โครงองค์กรและ DOA ตรงกับ fixture ใน spec §7.4', 'แผนก ผู้ดำรงตำแหน่ง ข้อ DOA และนโยบายตรงกัน', '; '.join(diff) or 'ไม่พบ fixture ใน spec',
              'seed ของ demo กับ golden tests ใช้ข้อมูลคนละชุด', 'ปรับไฟล์ให้ตรง fixture หรือแก้ fixture ใน spec พร้อม golden cases')
finish()
