#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_inputs.py — ตรวจไฟล์ input ของ BCS (demo และข้อมูลจริง v2) แบบรันจริง ทั้งโครงสร้างและการคำนวณ
ใช้:  python3 validate_inputs.py BCS_inputs_v1_demo.xlsx [--spec spec.md]
- อ่านค่าที่คำนวณแล้วของสูตร จึงต้องบันทึกไฟล์จาก Excel หรือ LibreOffice ก่อนตรวจ
- --spec: เทียบกับ fixture และรายการ OQ ใน spec.md (ต้องมี PyYAML)
- นับจำนวนแถวเองทุกชีต ไม่ hardcode · exit 0 = ไม่มี FAIL
"""
import re, sys
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, date
import openpyxl
from openpyxl.utils import get_column_letter

argv = sys.argv[1:]; SPEC = None
if '--spec' in argv:
    k = argv.index('--spec'); SPEC = argv[k + 1]; del argv[k:k + 2]
PATH = argv[0] if argv else 'BCS_inputs_v1_demo.xlsx'
wb = openpyxl.load_workbook(PATH, data_only=True)
RES = []
def rep(st, name, detail='', impact='', fix=''): RES.append((st, name, detail, impact, fix))
def check(cond, name, good, bad, impact, fix): rep('PASS' if cond else 'FAIL', name, good if cond else bad, impact, fix)
def finish():
    n = {'PASS': 0, 'FAIL': 0}
    print(f'validate_inputs — {PATH}')
    for st, name, d, imp, fix in RES:
        n[st] += 1; print(f'{st:5} {name} — {d}')
        if st == 'FAIL':
            if imp: print(f'      ผลกระทบ: {imp}')
            if fix: print(f'      วิธีแก้: {fix}')
    print(f"สรุป: {n['PASS']} PASS · {n['FAIL']} FAIL"); sys.exit(1 if n['FAIL'] else 0)

REQ = {'Inputs': ['id','group','item','usedFor','demoValue','provider','neededBefore','ref','sheet','status'],
 'Questions': ['id','meeting','askWhom','question','whyItMatters','demoDefault','ref','answer','docsToRequest'],
 'Org': ['key','value'], 'Departments': ['code','nameTh','parent','kind'], 'Positions': ['code','nameTh','scope'],
 'Users': ['code','displayNameTh','email','department','roles','positions'],
 'DOA': ['version','ruleCode','documentType','gt','lte','approverKind','approverPosition','approverMember','slaBusinessHours'],
 'DOA_Policy': ['key','value'], 'Budget': ['fiscalYear','code','department','planned','usedDemo','remaining'],
 'Suppliers': ['code','nameTh','taxId','branchCode','vatRegistered','email'], 'Sites': ['code','nameTh'],
 'RequestTypes': ['code','nameTh','documentType','active'], 'Holidays': ['date','nameTh'], 'Settings': ['key','value'],
 'Demo_History': ['ref','daysAgo','requester','chargedDept','requestType','site','supplier','budgetLine','net','vat','gross','status','countsAgainstBudget','expectedRule','expectedApprover','escalated','hours','channel'],
 'Demo_Script': ['scene','core','actor','channel','chargedDept','budgetLine','net','vat','gross','expectedOutcome','expectedRule','expectedApprover','escalated','delegation','minutes']}
miss = [s for s in REQ if s not in wb.sheetnames]
check(not miss, 'ชีตครบ', f'{len(REQ)} ชีตข้อมูล', f'ขาด {miss}', 'ข้อมูลส่วนนั้นจะไม่ถูกนำเข้า', 'เพิ่มชีตที่ขาดโดยคัดลอกหัวตารางจากไฟล์ v1')
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
DOCS = {'PURCHASE_REQUEST','PURCHASE_ORDER','GR_VARIANCE','DOA_CHANGE','ORG_AUTHORITY_CHANGE'}
for r, d in table('DOA'):
    rule = {'code': s_(d['ruleCode']), 'doc': s_(d['documentType']), 'gt': None if d['gt'] in (None, '') else sat(d['gt']),
            'lte': None if d['lte'] in (None, '') else sat(d['lte']), 'kind': s_(d['approverKind']), 'pos': s_(d['approverPosition']), 'mem': s_(d['approverMember']), 'sla': d['slaBusinessHours']}
    if rule['doc'] not in DOCS: rprob.append(f'{at("DOA","documentType",r)} {rule["doc"]}')
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
errs, warns, docs = [], [], []
for r in RS:
    if r['doc'] not in docs: docs.append(r['doc'])
for doc in docs:
    rs = sorted([r for r in RS if r['doc'] == doc and is_amt(r)], key=lower)
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
hs, he = s_(SET.get('businessHoursStart', ('', 0))[0]), s_(SET.get('businessHoursEnd', ('', 0))[0])
if not (re.fullmatch(r'\d\d:\d\d', hs) and re.fullmatch(r'\d\d:\d\d', he) and hs < he): sp.append('businessHoursStart/End ต้องเป็น HH:MM และเริ่มก่อนเลิก')
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
check(SITE and TYPES and not tp, 'สถานที่ส่งและประเภทคำขอ', f'{len(SITE)} สถานที่ · {len(TYPES)} ประเภท', f'documentType ไม่ถูกต้อง: {tp}', 'ฟอร์มหรือการรวม PR ทำงานผิด', 'ใส่ documentType เป็น PURCHASE_REQUEST หรือ SUPPLIER_REQUEST')
hol, hp = [], []
for r, d in table('Holidays'):
    v = d['date']
    if not isinstance(v, (datetime, date)): hp.append(f'{at("Holidays","date",r)} ไม่ใช่วันที่'); continue
    hol.append(v.date() if isinstance(v, datetime) else v)
if len(set(hol)) != len(hol): hp.append('วันหยุดซ้ำ')
wk = [str(x) for x in hol if x.weekday() >= 5]
check(not hp, 'วันหยุด', f'{len(hol)} วัน' + (f' · ตรงเสาร์อาทิตย์ {wk} (ตรวจว่าตั้งใจ)' if wk else ''), '; '.join(hp), 'นับ SLA ผิด', 'ใส่วันที่ในรูปแบบวันที่ของ Excel')

# ---------- คำขอย้อนหลัง ----------
BUD = {}
for r, d in table('Budget'): BUD[s_(d['code'])] = {'dept': s_(d['department']), 'planned': sat(d['planned']), 'row': r, 'used': d['usedDemo'], 'rem': d['remaining']}
STAT = {'COMPLETED','ORDERED','APPROVED','PENDING_APPROVAL','RETURNED','REJECTED','CANCELLED'}; DECIDED = STAT - {'PENDING_APPROVAL','CANCELLED'}
used = {k: 0 for k in BUD}; refp, arith, rbad, chbad, overdue, decided, viachat = [], [], [], [], [], 0, 0
for r, d in table('Demo_History'):
    ref, req, dept, line, st = s_(d['ref']), s_(d['requester']), s_(d['chargedDept']), s_(d['budgetLine']), s_(d['status'])
    if req not in USR: refp.append(f'{ref}: ไม่มีผู้ใช้ {req}')
    elif USR[req]['dept'] != dept: refp.append(f'{ref}: {req} อยู่ {USR[req]["dept"]} แต่ตั้งเบิก {dept} (ต้องมีสิทธิ์ใช้งบข้ามฝ่าย)')
    if line not in BUD: refp.append(f'{ref}: ไม่มีบรรทัดงบ {line}'); continue
    if BUD[line]['dept'] != dept: refp.append(f'{ref}: บรรทัดงบ {line} เป็นของ {BUD[line]["dept"]}')
    if s_(d['requestType']) not in TYPES: refp.append(f'{ref}: ไม่มีประเภท {s_(d["requestType"])}')
    if s_(d['supplier']) not in SUP: refp.append(f'{ref}: ไม่มีผู้ขาย {s_(d["supplier"])}')
    if s_(d['site']) not in SITE: refp.append(f'{ref}: ไม่มีสถานที่ {s_(d["site"])}')
    if st not in STAT: refp.append(f'{at("Demo_History","status",r)} สถานะ {st}')
    if sat(d['net']) % 100 != 0: refp.append(f'{at("Demo_History","net",r)} ยอดก่อน VAT ต้องเป็นบาทเต็ม (ใบเสนอราคาเปรียบเทียบ 104% และ 107% ต้องลงตัวที่สตางค์ และห้ามปัด BR-MONEY-02)')
    net = sat(d['net']); vat = rhu(net * RATE_BP, 10000); gross = net + vat; cnt = 0 if st in ('REJECTED', 'CANCELLED') else net
    for key, want in (('vat', vat), ('gross', gross), ('countsAgainstBudget', cnt)):
        if d[key] is None: arith.append(f'{at("Demo_History",key,r)} ยังไม่มีค่าที่คำนวณ (บันทึกไฟล์จาก Excel ก่อน)')
        elif sat(d[key]) != want: arith.append(f'{at("Demo_History",key,r)} ได้ {baht(sat(d[key]))} ควรเป็น {baht(want)}')
    used[line] += cnt; amt = gross if BASIS == 'GROSS' else net
    rt = route('PURCHASE_REQUEST', amt, req, dept); exp = (s_(d['expectedRule']), s_(d['expectedApprover']), s_(d['escalated']) or 'N')
    if 'error' in rt or (rt['rule'], rt['approver'], rt['escalated']) != exp:
        rbad.append(f'{ref} (รวม VAT {baht(gross)}): คาด {exp} แต่ engine ได้ {rt}')
    ch = s_(d['channel'])
    if st in DECIDED:
        decided += 1; viachat += ch in ('LINE_CHAT', 'LIFF')
        if ch not in ('LINE_CHAT', 'LIFF', 'WEB'): chbad.append(f'{at("Demo_History","channel",r)} ตัดสินแล้วต้องมีช่องทาง')
        if ch == 'LINE_CHAT' and amt >= STEPUP: chbad.append(f'{ref}: ยอด {baht(amt)} ต้องยืนยัน PIN จึงอนุมัติจากปุ่มในแชทไม่ได้ (BR-TOK-05)')
        if ch == 'LINE_CHAT' and st in ('REJECTED', 'RETURNED'): chbad.append(f'{ref}: ไม่อนุมัติหรือตีกลับต้องกรอกเหตุผลใน LIFF หรือเว็บ')
    elif ch: chbad.append(f'{ref}: ยังค้างอยู่แต่มีช่องทาง')
    hrs = d['hours']
    if not isinstance(hrs, (int, float)) or hrs < 0: chbad.append(f'{at("Demo_History","hours",r)} ต้องเป็นตัวเลข ≥ 0')
    elif st == 'PENDING_APPROVAL' and 'rule' in rt:
        sla = next(x['sla'] for x in RS if x['code'] == rt['rule'])
        if hrs > sla: overdue.append(f'{ref} ค้าง {hrs} ชม. ที่ {rt.get("approver")} (SLA {sla})')
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
low_pct = SET.get('digest.budgetLowPct', (0.1, 0))[0]
low = [f'{k} เหลือ {(b["planned"] - used[k]) / b["planned"]:.1%}' for k, b in BUD.items() if b['planned'] and (b['planned'] - used[k]) / b['planned'] < low_pct]
check(not bp, 'งบ: ยอดใช้และคงเหลือ', f'{len(BUD)} บรรทัด รวม {baht(sum(b["planned"] for b in BUD.values()))} · ตรงกับคำขอย้อนหลัง', '; '.join(bp), 'dashboard งบแสดงตัวเลขผิดต่อหน้าลูกค้า', 'แก้ตามช่องที่ระบุ')
share = viachat / decided if decided else 0
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
    oq_spec = set(re.findall(r'^\| (OQ-\d+) \|', text, re.M)); defined = set(re.findall(r'^\| ((?:OQ|P0|A|ADR)-\d+) \|', text, re.M)) | set(re.findall(r'^- \[[ x]\] \*\*((?:P0|S\d+|D|NEW)-\d+)\*\*', text, re.M))
    qrefs = set(re.findall(r'OQ-\d+', ' '.join(s_(d['ref']) for r, d in qs)))
    irefs = set(re.findall(r'(?:OQ|P0|A)-\d+', ' '.join(s_(d['ref']) for r, d in inp)))
    unknown = sorted((qrefs | irefs) - defined); notcov = sorted(oq_spec - qrefs)
    check(not unknown and not notcov, 'คำถามครอบคลุม OQ ทุกข้อใน spec', f'{len(oq_spec)} OQ มีคำถามรองรับครบ',
          f'OQ ที่ยังไม่มีคำถาม: {notcov} · อ้างถึงแต่ไม่มีใน spec: {unknown}', 'จะลืมถามเรื่องที่ spec ยังต้องการคำตอบ', 'เพิ่มแถวในชีต Questions หรือแก้คอลัมน์ ref')
    if yaml:
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
