#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
spec_check.py — ตรวจ spec.md ของ BCS แบบรันจริง รายงาน PASS/FAIL ทีละข้อ
 1) โครงสร้าง: code fence ตาราง หัวข้อ การอ้าง § YAML mermaid
 2) ID: ซ้ำ อ้างถึงแต่ไม่มีนิยาม เลขกระโดด FR ชั้น 1 อยู่ในแผน §16 FR มี AC OQ มีค่าเริ่มต้น
 3) Golden cases: คำนวณซ้ำด้วย implementation อ้างอิง และเทียบคำอ่านจำนวนเงินกับ LibreOffice ถ้ามี
ใช้:  python3 spec_check.py spec.md [-v]      ต้องมี PyYAML · exit 0 = ไม่มี FAIL
"""
import re, sys, shutil, subprocess, tempfile, csv, os, copy
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timedelta, timezone, time as dtime
from zoneinfo import ZoneInfo
try:
    import yaml
except ImportError:
    print("FAIL  setup  ต้องติดตั้ง PyYAML: pip install pyyaml"); sys.exit(2)

BKK, UTC = ZoneInfo("Asia/Bangkok"), timezone.utc
args = [a for a in sys.argv[1:] if not a.startswith("-")]
VERBOSE = "-v" in sys.argv
PATH = args[0] if args else "spec.md"
TEXT = open(PATH, encoding="utf-8").read()
LINES = TEXT.splitlines()
RESULTS = []

def report(status, name, detail="", impact="", fix=""):
    RESULTS.append((status, name, detail, impact, fix))

# ---------- parse: code blocks ----------
code_line = [False] * len(LINES)
blocks, fence_err, in_code, lang, start, buf = [], [], False, None, 0, []
for i, line in enumerate(LINES):
    st = line.strip()
    if st.startswith("```"):
        code_line[i] = True
        if not in_code:
            in_code, lang, start, buf = True, st[3:].strip(), i, []
        else:
            if st != "```": fence_err.append(i + 1)
            blocks.append((lang, start + 1, "\n".join(buf))); in_code = False
        continue
    if in_code:
        code_line[i] = True; buf.append(line)
if in_code: fence_err.append(start + 1)
report("PASS" if not fence_err else "FAIL", "code fences",
       f"{len(blocks)} บล็อก ปิดครบ" if not fence_err else f"ปิดไม่ครบหรือผิดรูปที่บรรทัด {fence_err}",
       "เนื้อหาหลัง fence ที่ไม่ปิดจะถูกแสดงเป็นโค้ดทั้งหมด agent อ่านผิดส่วน", "ปิด ``` ให้ครบที่บรรทัดที่ระบุ")

# ---------- parse: tables ----------
def split_cells(row):
    s = row.strip()
    if s.startswith("|"): s = s[1:]
    if s.endswith("|"): s = s[:-1]
    cells, cur, tick = [], "", False
    for ch in s:
        if ch == "`": tick = not tick
        if ch == "|" and not tick: cells.append(cur.strip()); cur = ""
        else: cur += ch
    cells.append(cur.strip()); return cells

tables, i = [], 0
while i < len(LINES):
    if not code_line[i] and LINES[i].lstrip().startswith("|"):
        rows = []
        while i < len(LINES) and not code_line[i] and LINES[i].lstrip().startswith("|"):
            rows.append((i + 1, split_cells(LINES[i]))); i += 1
        tables.append(rows)
    else: i += 1
bad_tables = []
for rows in tables:
    n = len(rows[0][1])
    if len(rows) < 2 or not all(re.fullmatch(r":?-{3,}:?", c) for c in rows[1][1]):
        bad_tables.append(f"บรรทัด {rows[0][0]} ไม่มีแถวคั่นหัวตาราง"); continue
    for ln, cells in rows[1:]:
        if len(cells) != n: bad_tables.append(f"บรรทัด {ln}: {len(cells)} คอลัมน์ (หัวตารางมี {n})")
report("PASS" if not bad_tables else "FAIL", "ตาราง markdown",
       f"{len(tables)} ตาราง จำนวนคอลัมน์ตรงกันทุกแถว" if not bad_tables else "; ".join(bad_tables[:8]),
       "แถวที่คอลัมน์เพี้ยนถูกแสดงผิดช่อง agent อาจอ่านกฎหรือค่าผิดคอลัมน์", "แก้จำนวน | ในแถวที่ระบุให้เท่าหัวตาราง")

# ---------- headings & § refs ----------
heads = [(i + 1, l) for i, l in enumerate(LINES) if not code_line[i] and re.match(r"^#{1,6} ", l)]
secs = set()
for _, l in heads:
    m = re.match(r"^## (\d+)\. ", l)
    if m: secs.add(m.group(1))
    m = re.match(r"^### (\d+\.\d+) ", l)
    if m: secs.add(m.group(1))
missing_top = [str(n) for n in range(0, 20) if str(n) not in secs]
report("PASS" if not missing_top else "FAIL", "หัวข้อหลัก §0–§19",
       "ครบ 20 หัวข้อ" if not missing_top else f"ขาด §{', §'.join(missing_top)}",
       "สารบัญและลำดับการอ่านใน §0.4 ชี้ไปหัวข้อที่ไม่มี", "เพิ่มหัวข้อที่ขาด")
ref_re = re.compile(r"§(\d+)(?:\.(\d+))?(?:\s*[–-]\s*(\d+)\.(\d+))?")
bad_refs = set()
for m in ref_re.finditer(TEXT):
    keys = [m.group(1) + (("." + m.group(2)) if m.group(2) else "")]
    if m.group(3): keys.append(m.group(3) + "." + m.group(4))
    for k in keys:
        if k not in secs: bad_refs.add("§" + k)
report("PASS" if not bad_refs else "FAIL", "การอ้างอิง §",
       "ทุก § ที่อ้างมีหัวข้อจริง" if not bad_refs else f"ไม่มีหัวข้อ: {sorted(bad_refs)}",
       "agent ถูกสั่งให้อ่านหัวข้อที่ไม่มีอยู่ จะเดาเนื้อหาเอง", "แก้เลขหัวข้อที่อ้าง หรือเพิ่มหัวข้อ")

# ---------- YAML & mermaid ----------
golden, yaml_err = {}, []
for lang, ln, content in blocks:
    if lang in ("yaml", "yml"):
        try: data = yaml.safe_load(content)
        except Exception as ex: yaml_err.append(f"บรรทัด {ln}: {str(ex).splitlines()[0]}"); continue
        m = re.match(r"#\s*(tests/golden/\S+\.yaml)", content.splitlines()[0] if content else "")
        if m:
            if m.group(1) in golden: yaml_err.append(f"ชื่อไฟล์ซ้ำ {m.group(1)}")
            golden[m.group(1)] = (data, ln)
report("PASS" if not yaml_err else "FAIL", "YAML ทุกบล็อก parse ได้",
       f"{sum(1 for b in blocks if b[0] in ('yaml','yml'))} บล็อก" if not yaml_err else "; ".join(yaml_err),
       "ไฟล์ golden หรือ config ที่ agent คัดลอกไปใช้จะโหลดไม่ขึ้น", "แก้ไวยากรณ์ YAML ที่บรรทัดที่ระบุ")
mer_err = []
for lang, ln, content in blocks:
    if lang == "mermaid":
        first = content.strip().splitlines()[0].strip()
        if first.split()[0] not in ("flowchart", "graph", "sequenceDiagram", "stateDiagram-v2"):
            mer_err.append(f"บรรทัด {ln}: ชนิดไม่รู้จัก {first}")
        if first.startswith(("flowchart", "graph")):
            sg = len(re.findall(r"^\s*subgraph\b", content, re.M)); en = len(re.findall(r"^\s*end\s*$", content, re.M))
            if sg != en: mer_err.append(f"บรรทัด {ln}: subgraph {sg} แต่ end {en}")
        if first == "sequenceDiagram" and re.search(r"->>[^\n]*;", content):
            mer_err.append(f"บรรทัด {ln}: มี ; ในข้อความ (mermaid ตัดเป็นบรรทัดใหม่)")
report("PASS" if not mer_err else "FAIL", "mermaid (ตรวจโครงสร้าง)",
       f"{sum(1 for b in blocks if b[0]=='mermaid')} แผนภาพ" if not mer_err else "; ".join(mer_err),
       "แผนภาพไม่ render", "แก้ตามรายละเอียด")

# ---------- IDs ----------
ID_PAT = r"(?:(?:FR|NFR|BR|INV|GC)-[A-Z0-9]+-\d{2,3}|(?:EG|NG|ADR|OQ|G|P|A|R)-\d{1,3}|S\d{1,2}-\d{2}|P0-\d{2}|P1-\d{2}|D-\d{2}|NEW-\d{2,3})"
ID_RE = re.compile(r"(?<![A-Za-z0-9_\-/])" + ID_PAT + r"(?![A-Za-z0-9_])")
FULL = re.compile("^" + ID_PAT + "$")
defs = {}
def add_def(k, ln): defs.setdefault(k, []).append(ln)
for rows in tables:
    if rows[0][1][0].strip() != "ID": continue
    for ln, cells in rows[2:]:
        c0 = re.sub(r"[`*]", "", cells[0]).strip()
        if FULL.match(c0): add_def(c0, ln)
for ln, l in heads:
    m = re.match(r"^#{2,5} (FR-[A-Z0-9]+-\d{3})\b", l)
    if m: add_def(m.group(1), ln)
for path, (data, ln) in golden.items():
    for c in (data or {}).get("cases", []) or []:
        add_def(c["id"], ln)
CHECK_RE = re.compile(r"^- \[([ x])\] \*\*((?:S\d{1,2}|P0|P1|D)-\d{2}|NEW-\d{2,3})\*\*(.*)$")
ITEMS = []
for i, line in enumerate(LINES):
    if code_line[i]: continue
    m = CHECK_RE.match(line)
    if not m: continue
    add_def(m.group(2), i + 1); subs, j = [], i + 1
    while j < len(LINES) and LINES[j].startswith("  - "): subs.append(LINES[j].strip()[2:]); j += 1
    ITEMS.append({"id": m.group(2), "done": m.group(1) == "x", "head": m.group(3), "subs": subs, "ln": i + 1})
dups = {k: v for k, v in defs.items() if len(v) > 1}
report("PASS" if not dups else "FAIL", "ID ไม่ซ้ำ", f"{len(defs)} ID มีนิยามที่เดียว" if not dups else f"ซ้ำ: {dups}",
       "เทสต์และ traceability ชี้ไปสองความหมาย", "เปลี่ยนเลข ID ที่ซ้ำ")
refs = set(ID_RE.findall(TEXT))
max_new = max((int(k[4:]) for k in defs if k.startswith("NEW-")), default=0)
def range_start(r):  # the next NEW id, named only as where the new items of a round start (spec 0.3.1: NEW-72 for A2)
    if not r.startswith("NEW-") or int(r[4:]) != max_new + 1: return False
    uses = [m.start() for m in re.finditer(re.escape(r) + r"(?![0-9])", TEXT)]
    return all(TEXT[u + len(r):u + len(r) + 8].startswith(" ขึ้นไป") or TEXT[max(0, u - 9):u].endswith("เริ่มที่ ") for u in uses)
undef = sorted(r for r in refs if r not in defs and not range_start(r))
report("PASS" if not undef else "FAIL", "ID ที่อ้างถึงมีนิยาม", f"อ้างถึง {len(refs)} ID ทุกตัวมีนิยาม" if not undef else f"ไม่มีนิยาม: {undef}",
       "agent จะเดาความหมายของกฎหรือคำถามที่ไม่มีอยู่", "เพิ่มแถวนิยาม หรือแก้ ID ที่อ้าง")
groups = {}
for k in defs:
    m = re.match(r"^(FR|NFR|BR|INV|GC)-([A-Z0-9]+)-(\d+)$", k)
    if m:
        n = int(m.group(3)); key = f"{m.group(1)}-{m.group(2)}" + (f" ชุด {n//100}xx" if m.group(1) == "FR" else "")
        groups.setdefault(key, [(n // 100) * 100 if m.group(1) == "FR" else 0, []])[1].append(n); continue
    m = re.match(r"^(S\d+|P0|P1|EG|NG|ADR|OQ|G|P|A|R|D|NEW)-(\d+)$", k)
    if m: groups.setdefault(m.group(1), [0, []])[1].append(int(m.group(2)))
# ADR and OQ numbers reserved per step so parallel lanes never pick the same number (spec 0.4 §16.13 · ADR-066):
# the table whose header has the columns "เลข ADR" and "เลข OQ" lists ranges like 101–119 (bare numbers, no prefix)
RANGES = {"ADR": [], "OQ": []}
for rows in tables:
    hdr = [c.strip() for c in rows[0][1]]
    cols = {p: hdr.index(f"เลข {p}") for p in RANGES if f"เลข {p}" in hdr}
    if len(cols) != 2: continue
    for ln, cells in rows[2:]:
        for p, j in cols.items():
            for a, b in re.findall(r"(\d+)\s*[–-]\s*(\d+)", cells[j] if j < len(cells) else ""):
                RANGES[p].append((int(a), int(b)))
gaps = []
for key, (base, nums) in sorted(groups.items()):
    if RANGES.get(key):
        rs = sorted(RANGES[key]); floor = rs[0][0]
        legacy = sorted(n for n in nums if n < floor)
        miss = sorted(set(range(1, max(legacy) + 1)) - set(legacy)) if legacy else []
        outside = sorted(n for n in nums if n >= floor and not any(a <= n <= b for a, b in rs))
        for a, b in rs:
            inr = sorted(n for n in nums if a <= n <= b)
            if inr: miss += sorted(set(range(a, max(inr) + 1)) - set(inr))
        if outside: gaps.append(f"{key} เลข {outside} อยู่นอกช่วงที่จองไว้ในตารางสายของ §16.13")
        if miss: gaps.append(f"{key} ขาด {miss}")
        continue
    exp = set(range(base + 1, max(nums) + 1)); miss = sorted(exp - set(nums))
    if miss: gaps.append(f"{key} ขาด {miss}")
report("PASS" if not gaps else "FAIL", "เลข ID ต่อเนื่อง", f"{len(groups)} กลุ่ม ไม่มีเลขกระโดด" if not gaps else "; ".join(gaps),
       "เลขที่หายทำให้สงสัยว่ามีกฎถูกลบโดยไม่ตั้งใจ", "เติมหรือเรียงเลขใหม่")
t1 = sorted(k for k in defs if re.match(r"^FR-[A-Z0-9]+-0\d\d$", k))
s16 = TEXT[TEXT.find("\n## 16. "):TEXT.find("\n## 17. ")]
not_planned = [k for k in t1 if k not in s16]
report("PASS" if not not_planned else "FAIL", "FR ชั้น 1 ทุกข้ออยู่ในแผน §16",
       f"{len(t1)} FR ครอบคลุมครบ" if not not_planned else f"ไม่อยู่ในแผน: {not_planned}",
       "FR ที่ไม่มีขั้นรองรับจะไม่ถูกสร้าง", "เพิ่ม FR ในรายการ 'FR ที่ครอบคลุม' ของขั้นที่เหมาะสม")
few_ac = []
for idx, (ln, l) in enumerate(heads):
    m = re.match(r"^#### (FR-[A-Z0-9]+-0\d\d)", l)
    if not m: continue
    end = heads[idx + 1][0] if idx + 1 < len(heads) else len(LINES)
    n = sum(1 for x in LINES[ln:end - 1] if x.startswith("- AC"))
    if n < 2: few_ac.append(f"{m.group(1)} มี {n} AC")
report("PASS" if not few_ac else "FAIL", "FR ชั้น 1 มี AC อย่างน้อย 2 ข้อ", f"{len(t1)} FR" if not few_ac else "; ".join(few_ac),
       "FR ที่ไม่มีเกณฑ์ยอมรับตรวจไม่ได้ว่าเสร็จ", "เพิ่ม AC ในรูปแบบ 'เงื่อนไข → ผล'")
oq_bad, oq_n = [], 0
for rows in tables:
    if rows[0][1][0] == "ID" and len(rows) > 2 and rows[2][1][0].startswith("OQ-"):
        for ln, cells in rows[2:]:
            oq_n += 1
            if len(cells) < 3 or not cells[2].strip(): oq_bad.append(cells[0])
report("PASS" if oq_n and not oq_bad else "FAIL", "OQ ทุกข้อมีค่าเริ่มต้น", f"{oq_n} OQ" if not oq_bad else f"ไม่มีค่าเริ่มต้น: {oq_bad}",
       "agent ไม่มีค่าให้ใช้ระหว่างรอคำตอบ (§0.6)", "ใส่ค่าเริ่มต้นในคอลัมน์ที่ 3")

# ---------- checklist และส่วนเริ่มที่นี่ ----------
nodone = [it["id"] for it in ITEMS if not any(x.startswith("เสร็จเมื่อ:") for x in it["subs"])]
nosplit = [it["id"] for it in ITEMS if "`[คน]`" not in it["head"] and not any(x.startswith("แยกงาน:") for x in it["subs"])]
notag = [it["id"] for it in ITEMS if "`[demo]`" not in it["head"] and "`[go-live]`" not in it["head"]]
nodate = [it["id"] for it in ITEMS if it["done"] and not re.search(r"— เสร็จ \d{4}-\d{2}-\d{2}", it["head"])]
report("PASS" if ITEMS and not nodone else "FAIL", "checklist: ทุกข้อมีเส้นชัยของตัวเอง", f"{len(ITEMS)} ข้อมีบรรทัด เสร็จเมื่อ" if not nodone else f"ไม่มี เสร็จเมื่อ: {nodone}",
       "agent ไม่รู้ว่าข้อนั้นเสร็จเมื่อไร อาจติ๊กเร็วเกินหรือทำไม่จบ", "เพิ่มบรรทัด '  - เสร็จเมื่อ: <คำสั่งหรือผลที่ตรวจได้>' ใต้ข้อที่ระบุ")
report("PASS" if not nosplit else "FAIL", "checklist: ข้อของ agent มีบรรทัดแยกงาน", f"{sum(1 for it in ITEMS if '`[คน]`' not in it['head'])} ข้อ" if not nosplit else f"ไม่มี แยกงาน: {nosplit}",
       "งานใหญ่อาจไม่ถูกแยกให้ subagent และไม่ถูกตรวจหลักฐาน", "เพิ่มบรรทัด '  - แยกงาน: ...' ใต้ข้อที่ระบุ")
report("PASS" if not notag else "FAIL", "checklist: ทุกข้อมีแท็ก demo หรือ go-live", "ครบทุกข้อ" if not notag else f"ไม่มีแท็ก: {notag}",
       "agent ไม่รู้ว่าข้อนั้นต้องเสร็จก่อนเส้นชัยไหน", "เติมแท็ก `[demo]` หรือ `[go-live]` ในบรรทัดของข้อนั้น")
report("PASS" if not nodate else "FAIL", "checklist: ข้อที่ติ๊กแล้วมีวันที่เสร็จ", f"{sum(it['done'] for it in ITEMS)} ข้อที่ติ๊ก" if not nodate else f"ไม่มีวันที่: {nodate}",
       "ตรวจย้อนไม่ได้ว่าเสร็จเมื่อไรและ commit ไหน", "ต่อท้ายบรรทัดด้วย '— เสร็จ YYYY-MM-DD · <commit>'")
# §16 subsection of every item ("16.11"), from the nearest "### 16.x" heading above it
sec16 = [(ln, re.match(r"^### (16\.\d+) ", l).group(1)) for ln, l in heads if re.match(r"^### 16\.\d+ ", l)]
for it in ITEMS: it["sec"] = next((s for ln, s in reversed(sec16) if ln < it["ln"]), "")
A2_FIRST_NEW, A3_FIRST_NEW = 72, 89  # §16.11 items found during round A2 are NEW-72 to NEW-88; round P1 (A3) starts at NEW-89
def subsec(it): return int(it["sec"].split(".")[1]) if it["sec"] else 0
def is_a2(it): return it["sec"] == "16.12" or (it["id"].startswith("NEW-") and A2_FIRST_NEW <= int(it["id"][4:]) < A3_FIRST_NEW)
def is_a3(it): return 13 <= subsec(it) <= 18 or (it["id"].startswith("NEW-") and int(it["id"][4:]) >= A3_FIRST_NEW)
def agent_demo(it): return "`[demo]`" in it["head"] and "`[คน]`" not in it["head"]
def step_items(*steps): return [it for it in ITEMS if re.match(r"^S(\d+)-", it["id"]) and int(it["id"].split("-")[0][1:]) in steps and agent_demo(it)]
def progress(items, what):
    return f"{what} เสร็จ {sum(it['done'] for it in items)}/{len(items)}" if items else f"{what}: ยังไม่มีข้อใน checklist (ข้อแรกของขั้นคือเขียน sub-spec และ checklist · §16.0)"
lines_ = {
    "A3": progress([it for it in ITEMS if agent_demo(it) and is_a3(it)], "ข้อ [demo] ของ agent ใน §16.13 ถึง §16.18 และ NEW-89 ขึ้นไป"),
    "A": progress([it for it in ITEMS if agent_demo(it) and 3 <= subsec(it) <= 11 and not is_a2(it) and not is_a3(it)], "ข้อ [demo] ของ agent ใน §16.3 ถึง §16.11 (ถึง NEW-71)"),
    "A2": progress([it for it in ITEMS if agent_demo(it) and is_a2(it)], "ข้อ [demo] ของ agent ใน §16.12 และ NEW-72 ถึง NEW-88"),
    "B": "ไม่มีข้อใน checklist: เสร็จเมื่อผู้ใช้ส่งไฟล์ input จริงและคำตอบในชีต Questions แล้ว spec ถูกปรับ",
    "C": progress([it for it in ITEMS if "`[go-live]`" in it["head"] and subsec(it) >= 3], "ข้อ [go-live] ใน §16.3 ขึ้นไป"),
    "D": progress(step_items(6), "ข้อ [demo] ของ agent ใน S6"),
    "E": progress(step_items(8, 9), "ข้อ [demo] ของ agent ใน S8 S9"),
    "F": progress(step_items(13), "ข้อ [demo] ของ agent ใน S13"),
    "G": progress(step_items(17), "ข้อ [demo] ของ agent ใน S17"),
    "H": progress(step_items(7, 10, 11), "ข้อ [demo] ของ agent ใน S7 S10 S11"),
}
for k in ("A3", "A2", "A", "B", "C", "D", "E", "F", "G", "H"):
    report("PASS", f"ความคืบหน้าสู่เส้นชัย {k}", lines_[k] + (f" · ทั้ง checklist เสร็จ {sum(it['done'] for it in ITEMS)}/{len(ITEMS)}" if k == "A3" else ""))
start_ok = "## เริ่มที่นี่" in TEXT and "เส้นชัย A" in TEXT and "ทำตาม spec.md" in TEXT and "### หยุดและถามเมื่อ" in TEXT
report("PASS" if start_ok else "FAIL", "ส่วนเริ่มที่นี่: คำสั่ง เส้นชัย และวิธีทำงาน", "ครบ" if start_ok else "ขาดคำสั่ง เส้นชัย หรือรายการหยุดถาม",
       "ผู้ใช้สั่งสั้น ๆ แล้ว agent ไม่รู้งานทั้งหมดหรือเส้นชัย", "คืนส่วน '## เริ่มที่นี่' ไว้บนสุดของไฟล์")
i9 = TEXT.find("\n### 9.9 "); s99 = TEXT[i9:TEXT.find("\n---", i9)] if i9 >= 0 else ""
donts = [x for x in s99.splitlines() if x.startswith("- ห้าม")]
report("PASS" if len(donts) >= 10 else "FAIL", "§9.9 รายการสิ่งที่ห้ามใช้ในงานออกแบบ", f"{len(donts)} ข้อ", "หน้าจอจะออกมาเป็นหน้าตาแบบ template ทั่วไป", "เพิ่มบรรทัด '- ห้าม...' ใน §9.9")
tok = dict(re.findall(r"^\| `(--[a-z-]+)` \| `(#[0-9A-Fa-f]{6})` \|", s99, re.M))
def _lum(h):
    c = [int(h[k:k + 2], 16) / 255 for k in (1, 3, 5)]; c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
def _cr(a, b): la, lb = sorted((_lum(a), _lum(b)), reverse=True); return (la + 0.05) / (lb + 0.05)
pairs = [(f, b) for f in ("--ink", "--ink-muted", "--primary", "--warn", "--danger", "--info") for b in ("--bg", "--surface")]
low = [f"{f} บน {b} = {_cr(tok[f], tok[b]):.2f}:1" for f, b in pairs if f in tok and b in tok and _cr(tok[f], tok[b]) < 4.5]
if "--primary" in tok and _cr("#FFFFFF", tok["--primary"]) < 4.5: low.append("ตัวอักษรขาวบน --primary")
missing_tok = [t for t in ("--bg", "--surface", "--ink", "--ink-muted", "--primary", "--warn", "--danger", "--info") if t not in tok]
report("PASS" if tok and not low and not missing_tok else "FAIL", "§9.9 token สีผ่าน contrast 4.5:1",
       (f"{len(pairs) + 1} คู่ผ่าน (ต่ำสุด {min(_cr(tok[f], tok[b]) for f, b in pairs):.2f}:1)" if not low else f"ไม่ผ่าน {len(low)} คู่: {low}") if tok and not missing_tok else f"ไม่พบ token: {missing_tok}",
       "ตัวอักษรบางสีอ่านยากและไม่ผ่าน WCAG AA (NFR-A11Y-02)", "แก้ค่าสีในตาราง token ของ §9.9 ให้เข้มขึ้น: " + "; ".join(low + missing_tok))

i10 = TEXT.find("\n### 9.10 "); s910 = TEXT[i10:TEXT.find("\n---", i10)] if i10 >= 0 else ""
tok10 = dict(tok)
for names, vals in re.findall(r"^\| ((?:`--[a-z0-9-]+`(?: · )?)+) \| ((?:`#[0-9A-Fa-f]{6}`(?: · )?)+) \|", s910, re.M):
    ns, vs = re.findall(r"`(--[a-z0-9-]+)`", names), re.findall(r"`(#[0-9A-Fa-f]{6})`", vals)
    if len(ns) == len(vs): tok10.update(zip(ns, vs))
pair_rows = re.findall(r"^\| `(--[a-z0-9-]+)`[^|]* \| `(--[a-z0-9-]+)` \| ([\d.]+) \| ([\d.]+) \|", s910, re.M)
bad10, ratios = [], []
for f, b, mn, stated in pair_rows:
    if f not in tok10 or b not in tok10: bad10.append(f"ไม่พบค่าของ {f if f not in tok10 else b}"); continue
    got = int(_cr(tok10[f], tok10[b]) * 100) / 100  # WCAG 2.1 ratio, rounded down to 2 places as the table states
    ratios.append(got)
    if got < float(mn): bad10.append(f"{f} บน {b} = {got:.2f}:1 ต่ำกว่า {mn}:1")
    elif f"{got:.2f}" != stated: bad10.append(f"{f} บน {b} คำนวณได้ {got:.2f} แต่ตารางเขียน {stated}")
report("PASS" if pair_rows and not bad10 else "FAIL", "§9.10 คู่สีผ่าน contrast (คำนวณซ้ำ)",
       f"{len(pair_rows)} คู่ตรงกับตาราง (ต่ำสุด {min(ratios):.2f}:1)" if pair_rows and not bad10 else ("; ".join(bad10) if pair_rows else "ไม่พบตารางคู่สีใน §9.10"),
       "สีของหน้าจอใหม่อ่านยากหรือไม่ผ่าน WCAG AA (NFR-A11Y-02) และตารางใน spec ไม่ตรงกับค่าจริง", "แก้ค่าสีในตาราง token ของ §9.10 หรือแก้ค่าที่ได้ในตารางคู่สีให้ตรงกับการคำนวณ")

# ---------- CLAUDE.md ข้างไฟล์ spec ----------
CLAUDE = os.path.join(os.path.dirname(os.path.abspath(PATH)), "CLAUDE.md")
if not os.path.exists(CLAUDE):
    report("SKIP", "CLAUDE.md ตรงกับ spec §17", "ไม่พบ CLAUDE.md ในโฟลเดอร์เดียวกับ spec")
else:
    cm = open(CLAUDE, encoding="utf-8").read(); cprob = []
    i17 = TEXT.find("### 17.3 "); forb = [x[2:] for x in TEXT[i17:TEXT.find("\n### 17.4", i17)].splitlines() if x.startswith("- ")]
    cprob += [f"ขาดข้อห้าม: {x[:40]}…" for x in forb if x not in cm]
    cprob += [f"ขาดหัวข้อ {h}" for h in ("รอคุณ (Blocked on me)", "เปลี่ยนแปลง (Changed)", "สิ่งที่พบ (Found)") if h not in cm]
    cprob += [f"ขาดกติกาหยุด: {h}" for h in ("When a step doesn't need my input, keep going", "Stop and ask only when") if h not in cm]
    if "เริ่มที่นี่" not in cm: cprob.append("ไม่ได้สั่งให้อ่านส่วนเริ่มที่นี่")
    nlines = cm.count("\n") + 1
    if nlines >= 200: cprob.append(f"ยาว {nlines} บรรทัด (ควรต่ำกว่า 200)")
    s54 = TEXT[TEXT.find("### 5.4 "):TEXT.find("\n---", TEXT.find("### 5.4 "))]
    scripts = {"install", "dlx", "exec"} | {n for row in s54.splitlines() if row.startswith("| `") for n in re.findall(r"`([a-z0-9:]+)`", row.split("|")[1])}
    badcmd = sorted({x for x in re.findall(r"pnpm ([a-z0-9]+(?::[a-z0-9]+)?)", cm) if x not in scripts})
    if badcmd: cprob.append(f"คำสั่ง pnpm ที่ไม่มีใน §5.4: {badcmd}")
    i179 = TEXT.find("### 17.9 "); s179 = TEXT[i179:TEXT.find("\n---", i179)] if i179 >= 0 else ""
    rules179 = [x for x in s179.splitlines() if x.startswith(("- ", "| `"))]
    cprob += [f"ขาดกติกา §17.9: {x[:40]}…" for x in rules179 if x not in cm]
    if i179 >= 0 and not rules179: cprob.append("§17.9 ไม่มีรายการให้เทียบ")
    badref = sorted({k for m in re.finditer(r"§(\d+)(?:\.(\d+))?", cm) for k in [m.group(1) + ("." + m.group(2) if m.group(2) else "")] if k not in secs})
    if badref: cprob.append(f"อ้าง § ที่ไม่มี: {badref}")
    report("PASS" if not cprob else "FAIL", "CLAUDE.md ตรงกับ spec §17", f"{nlines} บรรทัด · ข้อห้ามครบ {len(forb)} ข้อ · มีกติกาหยุดและสรุป 3 หัวข้อ · กติกา effort ครบ {len(rules179)} บรรทัด (§17.9)" if not cprob else "; ".join(cprob),
           "agent ได้กติกาไม่ตรงกับ spec เช่น ข้อห้ามหายหรือไม่รู้ว่าจะหยุดเมื่อไร", "แก้ CLAUDE.md ให้มีรายการตาม spec §17.3 §17.8 และ §17.9 ครบ")

# ---------- reference implementations ----------
def sat(x): return int((Decimal(str(x)) * 100).to_integral_value(rounding=ROUND_HALF_UP))
def baht(s): return f"{'-' if s < 0 else ''}{abs(s)//100}.{abs(s)%100:02d}"
def rhu(n, d): return (2 * n + d) // (2 * d) if n >= 0 else -((2 * -n + d) // (2 * d))
def dt(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))
def z(t): return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
def line_net(q, unit):
    qs = Decimal(str(q)) * 10000; assert qs == qs.to_integral_value(), "จำนวนเกิน 4 ตำแหน่ง"
    return rhu(int(qs) * unit, 10000)
def doc_totals(inp):
    r, inc = inp["rateBp"], inp.get("priceIncludesVat", False)
    amts = [(line_net(l["qty"], sat(l["unitPrice"])), l.get("vatable", True)) for l in inp["lines"]]
    tot, base = sum(a for a, _ in amts), sum(a for a, v in amts if v)
    if inc:
        vat = rhu(base * r, 10000 + r); return {"net": baht(tot - vat), "vat": baht(vat), "gross": baht(tot)}
    vat = rhu(base * r, 10000); return {"net": baht(tot), "vat": baht(vat), "gross": baht(tot + vat)}
TH_DIG = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"]
UNIT = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"]
def block6(n):
    d = [int(c) for c in str(n)][::-1]; out = ""
    for pos in range(len(d) - 1, -1, -1):
        v = d[pos]
        if v == 0: continue
        if pos == 1: out += "สิบ" if v == 1 else ("ยี่สิบ" if v == 2 else TH_DIG[v] + "สิบ")
        elif pos == 0: out += "เอ็ด" if (v == 1 and len(d) > 1 and d[1] != 0) else TH_DIG[v]
        else: out += TH_DIG[v] + UNIT[pos]
    return out
def int_text(n):
    parts = []
    while n > 0: parts.append(n % 1_000_000); n //= 1_000_000
    out = ""
    for i in range(len(parts) - 1, -1, -1):
        if parts[i]: out += block6(parts[i])
        if i > 0: out += "ล้าน"
    return out
def baht_text(s):
    b, st = divmod(s, 100)
    if b == 0 and st == 0: return "ศูนย์บาทถ้วน"
    return (int_text(b) + "บาท" if b else "") + ("ถ้วน" if st == 0 else int_text(st) + "สตางค์")
def taxid_ok(s):
    s = re.sub(r"[\s-]", "", s)
    if not re.fullmatch(r"\d{13}", s): return False
    tot = sum(int(s[i]) * (13 - i) for i in range(12))
    return (11 - tot % 11) % 10 == int(s[12])
TH_MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]

# ---------- golden runners ----------
def cmp(expect, got):
    return all(str(got.get(k)) == str(v) if not isinstance(v, (list, dict)) else got.get(k) == v for k, v in expect.items())
def run_money(d):
    out = []
    for c in d["cases"]:
        i = c["input"]
        if c["fn"] == "vatFromNet":
            n = sat(i["net"]); v = rhu(n * i["rateBp"], 10000); got = {"vat": baht(v), "gross": baht(n + v)}
        elif c["fn"] == "vatFromGross":
            g = sat(i["gross"]); v = rhu(g * i["rateBp"], 10000 + i["rateBp"]); got = {"vat": baht(v), "net": baht(g - v)}
        elif c["fn"] == "lineNet": got = {"net": baht(line_net(i["qty"], sat(i["unitPrice"])))}
        else: got = doc_totals(i)
        out.append((c["id"], cmp(c["expect"], got), got))
    return out
def run_vat(d):
    rates, out = d["fixture"]["rates"], []
    for c in d["cases"]:
        i = c["input"]; day = i.get("date") or dt(i["at"]).astimezone(BKK).date().isoformat(); got = {"date": day}
        hit = [r for r in rates if r["effectiveFrom"] <= day <= r["effectiveTo"]]
        if hit: got["rateBp"] = hit[0]["rateBp"]
        else: got["error"] = "TAX_RATE_NOT_CONFIGURED"
        out.append((c["id"], cmp(c["expect"], got), got))
    return out
def run_thai(d):
    return [(c["id"], baht_text(sat(c["input"])) == c["expect"], baht_text(sat(c["input"]))) for c in d["cases"]]
def run_taxid(d):
    return [(c["id"], taxid_ok(c["input"]) == c["expect"], taxid_ok(c["input"])) for c in d["cases"]]
def run_dates(d):
    out = []
    for c in d["cases"]:
        t = dt(c["input"]).astimezone(BKK)
        got = {"buddhistYear": t.year + 543, "formatThaiDate": f"{t.day} {TH_MON[t.month-1]} {t.year+543}",
               "formatThaiDateTime": f"{t.day} {TH_MON[t.month-1]} {t.year+543} {t:%H:%M} น."}[c["fn"]]
        out.append((c["id"], got == c["expect"], got))
    return out
def run_numbering(d):
    out = []
    for c in d["cases"]:
        i = c["input"]; t = dt(i["at"]).astimezone(BKK); be = t.year + 543; p = i["pattern"]
        num = p.replace("{BE}", str(be)).replace("{YY}", str(be)[-2:]).replace("{CE}", str(t.year)).replace("{MM}", f"{t.month:02d}").replace("{DEPT}", i.get("department", ""))
        num = re.sub(r"\{SEQ(\d+)\}", lambda m: str(i["seq"]).zfill(int(m.group(1))), num)
        per = {"YEARLY": str(be), "MONTHLY": f"{be}-{t.month:02d}", "NEVER": "ALL"}[i["reset"]]
        scope = f"{i['documentType']}:{per}" + (f":{i['department']}" if "{DEPT}" in p else "")
        got = {"number": num, "scopeKey": scope}; out.append((c["id"], cmp(c["expect"], got), got))
    return out

# DOA document types in lint order and their traits (BR-DOA-20 to BR-DOA-23 · src/core/doa/types.ts DOC_TYPE_TRAITS)
DOC_ORDER = ("PURCHASE_REQUEST", "PURCHASE_ORDER", "GR_VARIANCE", "DOA_CHANGE", "ORG_AUTHORITY_CHANGE", "BUDGET_TRANSFER",
             "OVER_BUDGET", "INVOICE_EXCEPTION", "PO_CHANGE", "PAYMENT_RUN", "BANK_ACCOUNT_CHANGE")
AMOUNT_REQUIRED = {"PURCHASE_REQUEST", "PURCHASE_ORDER", "BUDGET_TRANSFER", "OVER_BUDGET", "INVOICE_EXCEPTION", "PO_CHANGE", "PAYMENT_RUN"}
AMOUNT_NONE = {"BANK_ACCOUNT_CHANGE"}
MODULE_DOCS = {"PAY": ("INVOICE_EXCEPTION", "PAYMENT_RUN", "BANK_ACCOUNT_CHANGE")}
DEFAULT_FIXTURES = ["fixtures/org-demo.yaml", "fixtures/doa-versions.yaml"]
def use_fixtures(files=None):
    # Each DOA golden file names its own fixtures (`fixtures:` line · ADR-069); the helpers below read these globals
    global ORG, DOAV, PARENT, ROOT, HOLD
    files = files or DEFAULT_FIXTURES
    ORG = next((golden.get("tests/golden/" + f, ({}, 0))[0] for f in files if "org-" in f), None) or {}
    DOAV = next((golden.get("tests/golden/" + f, ({}, 0))[0] for f in files if "doa-versions" in f), None) or {}
    PARENT = {x["code"]: x["parent"] for x in ORG.get("departments", [])}
    ROOT = next((k for k, v in PARENT.items() if v is None), None)
    HOLD = {(x["position"], x["department"]): x["member"] for x in ORG.get("positions", [])}
use_fixtures()
def versions():
    vs = sorted(DOAV.get("versions", []), key=lambda v: dt(v["effectiveFrom"]))
    for a, b in zip(vs, vs[1:] + [None]): a["_to"] = dt(b["effectiveFrom"]) if b else None
    return vs
def lower(r):
    am = (r.get("when") or {}).get("amount") or {}
    return sat(am.get("gt", am.get("gte", "0")))
def matches(r, amt):
    am = (r.get("when") or {}).get("amount")
    if not am: return True
    if amt is None: return False
    return (("gt" not in am or amt > sat(am["gt"])) and ("gte" not in am or amt >= sat(am["gte"])) and
            ("lte" not in am or amt <= sat(am["lte"])) and ("lt" not in am or amt < sat(am["lt"])))
def rule_approvers(r): return r["step"]["approvers"] if "step" in r else [r["approver"]]
def approver(r, dept, vac): return approver_spec(r["approver"], dept, vac)
def approver_spec(a, dept, vac):
    if a["kind"] == "MEMBER": return None if a["member"] in vac else a["member"]
    pos = a["position"]
    d = dept if a["kind"] == "POSITION_OF_DEPARTMENT" else ROOT
    while d:
        h = HOLD.get((pos, d))
        if h and f"{pos}@{d}" not in vac: return h
        if a["kind"] == "POSITION_OF_ORG": return None
        d = PARENT.get(d)
    return None
def resolve(inp):
    at = dt(inp["at"]); vs = [v for v in versions() if dt(v["effectiveFrom"]) <= at and (v["_to"] is None or at < v["_to"])]
    if not vs: return {"error": "DOA_NOT_CONFIGURED"}
    v = vs[-1]; doc = inp["documentType"]; basis = inp.get("amountBasis", v["amountBasis"])
    if "amount" in inp: amt = sat(inp["amount"])
    elif "net" in inp: amt = sat(inp["net"]) + (sat(inp["vat"]) if basis == "GROSS" else 0)
    else: amt = None
    if doc in AMOUNT_NONE and ("amount" in inp or "net" in inp): return {"error": "VALIDATION_FAILED"}
    if doc in AMOUNT_REQUIRED and (amt is None or amt <= 0): return {"error": "VALIDATION_FAILED"}
    cand = sorted([r for r in v["rules"] if r["documentType"] == doc and matches(r, amt)], key=lambda r: (r["priority"], -len(r.get("when") or {})))
    if not cand: return {"error": "DOA_NOT_CONFIGURED"}
    if len(cand) > 1 and (cand[0]["priority"], len(cand[0].get("when") or {})) == (cand[1]["priority"], len(cand[1].get("when") or {})):
        return {"error": "DOA_AMBIGUOUS"}
    top = cand[0]; band = sorted([r for r in v["rules"] if r["documentType"] == doc], key=lower)
    conf = {inp["requester"]} | set(inp.get("alsoConflicting", [])); vac = set(inp.get("vacate", []))
    ap = approver(top, inp["department"], vac)
    if ap is None: return {"error": "APPROVER_NOT_FOUND"}
    res = {"version": v["version"], "rule": top["code"]}
    if ap in conf:
        if v["selfApprovalPolicy"] == "BLOCK": return {"error": "SOD_VIOLATION"}
        for r in band[band.index(top) + 1:]:
            a2 = approver(r, inp["department"], vac)
            if a2 is None: return {"error": "APPROVER_NOT_FOUND"}
            if a2 not in conf: ap = a2; res["escalatedTo"] = r["code"]; break
        else: return {"error": "NO_HIGHER_AUTHORITY"}
    res["approvers"] = [ap]; res["_amt"] = amt; res["_conf"] = conf; return res
def run_doa(d):
    use_fixtures(d.get("fixtures")); out = []
    for c in d["cases"]:
        got = resolve({**d["defaults"], **c["input"]}); g = {k: v for k, v in got.items() if not k.startswith("_")}
        exp = c["expect"]; ok = all(g.get(k) == v for k, v in exp.items()) and ("escalatedTo" in exp) == ("escalatedTo" in g)
        out.append((c["id"], ok, g))
    return out
def run_delegation(d):
    use_fixtures(d.get("fixtures")); out, D = [], d["delegations"]
    for c in d["cases"]:
        if "create" in c:
            n = c["create"]; holds = any(m == n["delegator"] for m in HOLD.values())
            if not holds: got = {"error": "VALIDATION_FAILED", "reason": "NOTHING_TO_DELEGATE"}
            elif any(D[e]["delegator"] == n["delegator"] and dt(n["startsAt"]) < dt(D[e]["endsAt"]) and dt(D[e]["startsAt"]) < dt(n["endsAt"]) for e in c.get("existing", [])):
                got = {"error": "VALIDATION_FAILED", "reason": "OVERLAPPING_DELEGATION"}
            else: got = {"ok": True}
        else:
            inp = {**d["defaults"], **c["input"]}; r = resolve(inp); ap = r["approvers"][0]; at = dt(inp["at"])
            got = {"assignee": ap, "principal": None}
            for k in inp.get("active", []):
                x = D[k]
                if x["delegator"] == ap and dt(x["startsAt"]) <= at < dt(x["endsAt"]) and ("maxAmount" not in x or r["_amt"] <= sat(x["maxAmount"])):
                    if x["delegate"] in r["_conf"]: got["notifyOrgAdmin"] = True
                    else: got = {"assignee": x["delegate"], "principal": ap}
        out.append((c["id"], all(got.get(k) == v for k, v in c["expect"].items()), got))
    return out
def sod_recent_change(i):  # BR-SOD-10: the actor proposed a bank change in force within recentBankChangeDays before payDate
    if not i.get("bankChanges"): return False
    since = (datetime.strptime(i["payDate"], "%Y-%m-%d") - timedelta(days=i["recentBankChangeDays"])).date().isoformat()
    return any(b["proposer"] == i["actor"] and b["effectiveOn"] >= since for b in i["bankChanges"])
def run_sod(d):
    st, out = d["sodPolicy"], []
    for c in d["cases"]:
        i = c["input"]; rule = None
        if i["action"] == "PROPOSE_ORG_AUTHORITY_CHANGE":
            if i["actor"] == i.get("beneficiary"): rule = "BR-SOD-08"
        elif i["action"] == "DECIDE_APPROVAL":
            subj = i.get("subject", "REQUEST")
            if subj == "ORG_AUTHORITY_CHANGE" and i["actor"] == i.get("requester"): rule = "BR-SOD-08"
            elif subj == "DOA_VERSION" and i["actor"] == i.get("requester"): rule = "BR-SOD-06"
            elif subj == "PAYMENT_RUN" and i["actor"] == i.get("requester"): rule = "BR-SOD-09"
            elif subj == "PAYMENT_RUN" and i["actor"] in i.get("invoiceRecorders", []): rule = "BR-SOD-04"
            elif subj == "PAYMENT_RUN" and sod_recent_change(i): rule = "BR-SOD-10"
            elif subj == "BANK_ACCOUNT_CHANGE" and i["actor"] == i.get("requester"): rule = "BR-SOD-05"
            elif i["actor"] == i.get("requester"): rule = "BR-SOD-01"
            elif subj == "PURCHASE_ORDER" and i["actor"] == i.get("poCreator"): rule = "BR-SOD-03"
        elif i["action"] == "PREPARE_PAYMENT":
            if sod_recent_change(i): rule = "BR-SOD-10"
        elif i["action"] == "POST_GR":
            if not st["approverMayReceive"] and i["actor"] in i.get("approvers", []): rule = "BR-SOD-02"
            elif i["actor"] == i.get("requester") and not st["requesterMayReceive"]: rule = "BR-SOD-07"
        got = {"error": "SOD_VIOLATION", "rule": rule} if rule else {"ok": True}
        out.append((c["id"], got == c["expect"], got))
    return out
class BudgetErr(Exception): pass
def run_budget(d):
    out = []
    for c in d["cases"]:
        B = {"available": 0, "reserved": 0, "committed": 0, "actual": 0}; res, po, funded, ok, why = {}, {}, 0, True, ""
        def mv(a, b, amt):
            if amt < 0 or B[a] < amt: raise BudgetErr("BUDGET_INSUFFICIENT" if a == "available" else "INVARIANT")
            B[a] -= amt; B[b] += amt
        for n, s in enumerate(c["steps"], 1):
            snap = (dict(B), dict(res), {k: dict(v) for k, v in po.items()}); err = None
            try:
                op = s["op"]
                if op == "fund": B["available"] += sat(s["amount"]); funded += sat(s["amount"])
                elif op == "reserve": mv("available", "reserved", sat(s["amount"])); res[s["source"]] = res.get(s["source"], 0) + sat(s["amount"])
                elif op == "release": a = res.pop(s["source"]); mv("reserved", "available", a)
                elif op == "submitPo":
                    need = sat(s["need"]); rel = sum(sat(x["releasable"]) for x in s["sources"]); delta = max(need - rel, 0)
                    po[s["po"]] = {"need": need, "src": [(x["source"], sat(x["releasable"])) for x in s["sources"]], "delta": delta, "com": 0}
                    if delta: mv("available", "reserved", delta)
                elif op in ("approvePo", "rejectPo"):
                    p = po[s["po"]]
                    if op == "approvePo":
                        for src, r in p["src"]: mv("reserved", "available", r); res[src] -= r
                    if p["delta"]: mv("reserved", "available", p["delta"]); p["delta"] = 0
                    if op == "approvePo": mv("available", "committed", p["need"]); p["com"] = p["need"]
                elif op == "cancelPo":
                    p = po[s["po"]]; mv("committed", "available", p["com"]); p["com"] = 0
                    for src, r in p["src"]: mv("available", "reserved", r); res[src] = res.get(src, 0) + r
                elif op == "actualize":
                    p = po[s["po"]]; a = sat(s["amount"])
                    if a > p["com"]: raise BudgetErr("INVOICE_EXCEEDS_COMMITTED")
                    mv("committed", "actual", a); p["com"] -= a
                elif op == "closePo": p = po[s["po"]]; mv("committed", "available", p["com"]); p["com"] = 0
                elif op == "parallelReserve":
                    succ = 0
                    for a in s["amounts"]:
                        try: mv("available", "reserved", sat(a)); succ += 1
                        except BudgetErr: pass
                    if succ != s["expectSuccesses"]: ok, why = False, f"step {n}: สำเร็จ {succ} รายการ"
            except BudgetErr as e:
                err = str(e); B, res, po = snap[0], snap[1], snap[2]
            if err != s.get("expectError"): ok, why = False, f"step {n}: error คาด {s.get('expectError')} ได้ {err}"
            if "expect" in s:
                gotb = {k: baht(v) for k, v in B.items()}
                if gotb != s["expect"]: ok, why = False, f"step {n}: คาด {s['expect']} ได้ {gotb}"
            if sum(B.values()) != funded: ok, why = False, f"step {n}: INV-BUD-01 ผลรวม {baht(sum(B.values()))} ≠ {baht(funded)}"
            if not ok: break
        out.append((c["id"], ok, why or "ตรงทุก step และผลรวมคงที่"))
    return out
def run_sla(d):
    cal = d["calendar"]; wd = {"MON": 0, "TUE": 1, "WED": 2, "THU": 3, "FRI": 4, "SAT": 5, "SUN": 6}
    work = {wd[x] for x in cal["workdays"]}; hol = set(cal["holidays"])
    s0, e0 = dtime.fromisoformat(cal["start"]), dtime.fromisoformat(cal["end"])
    def isw(day): return day.weekday() in work and day.isoformat() not in hol
    def bounds(day): return datetime.combine(day, s0, BKK), datetime.combine(day, e0, BKK)
    def add(t, m):
        t = t.astimezone(BKK)
        while True:
            a, b = bounds(t.date())
            if not isw(t.date()) or t >= b: t = bounds(t.date() + timedelta(days=1))[0]; continue
            t = max(t, a); av = (b - t).total_seconds() / 60
            if m <= av: return t + timedelta(minutes=m)
            m -= av; t = bounds(t.date() + timedelta(days=1))[0]
    def between(x, y):
        x, y, tot, day = x.astimezone(BKK), y.astimezone(BKK), 0.0, x.astimezone(BKK).date()
        while day <= y.date():
            if isw(day):
                a, b = bounds(day); lo, hi = max(a, x), min(b, y)
                if hi > lo: tot += (hi - lo).total_seconds() / 60
            day += timedelta(days=1)
        return int(tot)
    out = []
    for c in d["cases"]:
        i = c["input"]; f = c["fn"]
        if f == "addBusinessMinutes": got = z(add(dt(i["from"]), i["minutes"]))
        elif f == "businessMinutesBetween": got = between(dt(i["from"]), dt(i["to"]))
        elif f == "resumeDue": got = z(add(dt(i["resumedAt"]), i["slaMinutes"] - between(dt(i["assignedAt"]), dt(i["pausedAt"]))))
        else: got = z(add(dt(i["assignedAt"]), i["slaMinutes"] * i["remindPct"] / 100))
        out.append((c["id"], got == c["expect"], got))
    return out
def run_forms(d):
    def val(field, ctx):
        return ctx["amountGross"] if field == "$amountGross" else ctx["fields"].get(field)
    def cond(cn, ctx):
        if "all" in cn: return all(cond(x, ctx) for x in cn["all"])
        if "any" in cn: return any(cond(x, ctx) for x in cn["any"])
        if "attachments" in cn: return ctx["att"].get(cn["attachments"], 0) >= cn["min"]
        v, op = val(cn["field"], ctx), cn["op"]
        if op == "notEmpty": return bool(v and str(v).strip())
        if op == "empty": return not (v and str(v).strip())
        if op == "eq": return v == cn["value"]
        if op == "gt": return Decimal(str(v)) > Decimal(cn["value"])
        raise ValueError(op)
    out = []
    for c in d["cases"]:
        i = c["input"]; ctx = {"amountGross": i["amountGross"], "fields": dict(i.get("fields", {})), "att": i.get("attachments") or {}}
        dropped = [v["field"] for v in d.get("visibility", []) if v["field"] in ctx["fields"] and not cond(v["when"], ctx)]
        for f in dropped: ctx["fields"].pop(f)
        got = {"ok": True}
        for r in d["rules"]:
            if cond(r["when"], ctx) and not cond(r["require"], ctx): got = {"error": "ATTACHMENT_RULE_FAILED", "rule": r["id"]}; break
        if dropped and "error" not in got: got["droppedFields"] = dropped
        out.append((c["id"], got == c["expect"], got))
    return out
def run_cons(d):
    key = lambda r: tuple(int(x) for x in re.findall(r"\d+", r))
    out = []
    for c in d["cases"]:
        lines = sorted(c["input"]["lines"], key=lambda l: key(l["ref"])); groups, imm, un = {}, [], []
        for l in lines:
            if not l.get("supplier"): un.append(l["ref"])
            elif l.get("urgent"): imm.append([l["ref"]])
            else: groups.setdefault((l["supplier"], l["site"], l["kind"]), []).append(l["ref"])
        got = {"cycleGroups": sorted(groups.values(), key=lambda g: key(g[0])), "immediate": imm, "unassigned": un}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_gr(d):
    out = []
    for c in d["cases"]:
        i = c["input"]; o, r, pr = Decimal(i["ordered"]), Decimal(i["received"]), sat(i["unitPrice"])
        amt = lambda q: int((q * pr).to_integral_value(rounding=ROUND_HALF_UP)); ex = r - o; var, delta = [], 0
        if ex > 0:
            status = "RECEIVED"
            if ex <= o * Decimal(i["tolerancePct"]) / 100: acc, delta = r, amt(ex)
            else:
                keep = i.get("disposition") == "ACCEPT_EXCESS"; acc = r if keep else o; delta = amt(ex) if keep else 0
                var = [{"type": "OVER", "quantity": str(ex), "amount": baht(amt(ex)), "needsApproval": keep}]
        elif ex < 0:
            acc = r
            if i.get("closeShort"): status, delta = "CLOSED", -amt(-ex); var = [{"type": "SHORT", "quantity": str(-ex), "amount": baht(amt(-ex)), "needsApproval": True}]
            else: status = "PARTIALLY_RECEIVED"
        else: acc, status = r, "RECEIVED"
        got = {"poStatus": status, "accepted": str(acc), "variances": var, "commitDelta": baht(delta)}
        e = c["expect"]; ok = all((got[k] == v) if k != "variances" else [{kk: str(x[kk]) if kk == "quantity" else x[kk] for kk in y} for x, y in zip(got[k], v)] == v and len(got[k]) == len(v) for k, v in e.items())
        out.append((c["id"], ok, got))
    return out
def run_ivc(d):
    out = []
    for c in d["cases"]:
        i = c["input"]; rem = [sat(x) for x in i["committed"]]; act = [0] * len(rem)
        norm = lambda s: re.sub(r"\s+", "", s).upper(); seen = {norm(x) for x in i.get("existingInvoiceNos", [])}; res = []
        for inv in i["invoices"]:
            no, net = norm(inv["invoiceNo"]), sat(inv["net"])
            if no in seen: res.append("DUPLICATE_INVOICE"); continue
            if net > sum(rem): res.append("INVOICE_EXCEEDS_COMMITTED"); continue
            W = sum(rem); fl = [net * w // W for w in rem]; rm = [net * w % W for w in rem]
            for k in sorted(range(len(rem)), key=lambda k: (-rm[k], k))[: net - sum(fl)]: fl[k] += 1
            act = [a + b for a, b in zip(act, fl)]; rem = [a - b for a, b in zip(rem, fl)]; seen.add(no); res.append("ok")
        got = {"results": res, "actualByLine": [baht(x) for x in act], "remaining": [baht(x) for x in rem]}
        out.append((c["id"], got == c["expect"], got))
    return out
WHT_MINIMUM_BASE = "1000.00"  # BR-WHT-06 · settings.wht.minimumBase ค่าเริ่มต้นของ OQ-122 (ตามหมายเหตุใน wht.yaml)
def wht_for_payment(i):  # BR-WHT-03 BR-WHT-04 BR-WHT-06 · ภาษีของการจ่ายครั้งเดียว
    if i["incomeType"] is None: return {"form": None, "wht": "0.00", "reason": "NOT_APPLICABLE"}  # GOODS ไม่หัก
    if i["payeeType"] == "FOREIGN": return {"error": "VALIDATION_FAILED", "reason": "FOREIGN_PAYEE"}
    form = "PND3" if i["payeeType"] == "INDIVIDUAL" else "PND53"
    if i["typeForm"] not in ("PND3_53", form): return {"error": "WHT_FORM_PAYEE_MISMATCH"}
    if sat(i["poNet"]) < sat(WHT_MINIMUM_BASE): return {"form": form, "wht": "0.00", "reason": "BELOW_MINIMUM"}
    return {"form": form, "wht": baht(rhu(sat(i["base"]) * i["rateBp"], 10000))}
def payment_withholding(lines):  # BR-WHT-10 · รวมฐานต่อ (ประเภท, อัตรา) ปัดครั้งเดียวต่อกลุ่ม แล้วปันกลับต่อเอกสาร
    order, groups = [], {}
    for l in lines:
        k = (l["incomeType"], l["rateBp"])
        if k not in groups: order.append(k); groups[k] = []
        groups[k].append((l["doc"], sat(l["base"])))
    if any(sum(b for _, b in groups[k]) < 0 for k in order): return {"error": "VALIDATION_FAILED", "reason": "WHT_BASE_NEGATIVE"}
    out, total = [], 0
    for k in order:
        base = sum(b for _, b in groups[k]); w = rhu(base * k[1], 10000); total += w
        shares = lr_split(w, [b for _, b in groups[k]])
        out.append({"incomeType": k[0], "rateBp": k[1], "base": baht(base), "wht": baht(w),
                    "docs": [{"doc": d, "wht": baht(s)} for (d, _), s in zip(groups[k], shares)]})
    return {"groups": out, "wht": baht(total)}
def run_wht(d):  # BR-WHT-01 (ไม่มี fn) · whtForPayment · paymentWithholding (S8-08)
    out = []
    for c in d["cases"]:
        i = c["input"]; fn = c.get("fn")
        if fn is None:
            n = sat(i["net"]); v = rhu(n * i["vatRateBp"], 10000); w = rhu(n * i["whtRateBp"], 10000)
            got = {"vat": baht(v), "wht": baht(w), "payable": baht(n + v - w)}
        elif fn == "whtForPayment": got = wht_for_payment(i)
        elif fn == "paymentWithholding": got = payment_withholding(i["lines"])
        else: got = {"error": f"fn {fn} ยังไม่มีตัวคำนวณอ้างอิง"}
        out.append((c["id"], got == c["expect"], got))
    return out
GOV = ("DOA_CHANGE", "ORG_AUTHORITY_CHANGE")
def amount_only(r): return set((r.get("when") or {}).keys()) == {"amount"}
def build_version(inp):
    v = copy.deepcopy(next(x for x in DOAV["versions"] if x["version"] == inp.get("base", 1)))
    for r in inp.get("replaceRules") or []:
        v["rules"] = [r if x["code"] == r["code"] else x for x in v["rules"]]
    drop = set(inp.get("removeRules") or [])
    v["rules"] = [x for x in v["rules"] if x["code"] not in drop]
    return v
def lint_version(v, vac=frozenset(), modules=()):
    errs, warns = [], []
    # The known types in lint order, then any other type a rule names (a typo is linted, and refused below)
    docs = [x for x in DOC_ORDER if x not in AMOUNT_NONE] + list(dict.fromkeys(r["documentType"] for r in v["rules"] if r["documentType"] not in DOC_ORDER))
    for doc in docs:
        rs = sorted([r for r in v["rules"] if r["documentType"] == doc and amount_only(r)], key=lower)
        if not rs: continue
        prev, inf = 0, False
        for r in rs:
            lo, am = lower(r), r["when"]["amount"]
            if inf: errs.append({"code": "DOA_LINT_OVERLAP", "documentType": doc, "gt": baht(lo), "lte": None}); continue
            if lo > prev: errs.append({"code": "DOA_LINT_GAP", "documentType": doc, "gt": baht(prev), "lte": baht(lo)})
            elif lo < prev: errs.append({"code": "DOA_LINT_OVERLAP", "documentType": doc, "gt": baht(lo), "lte": baht(prev)})
            if "lte" in am: prev = max(prev, sat(am["lte"]))
            else: inf = True
        if not inf: errs.append({"code": "DOA_LINT_GAP", "documentType": doc, "gt": baht(prev), "lte": None})
    present = {r["documentType"] for r in v["rules"]}
    required = set(GOV) | {x for m in modules for x in MODULE_DOCS.get(m, ())}
    errs += [{"code": "DOA_LINT_MISSING_DOCTYPE", "documentType": g} for g in DOC_ORDER if g in required and g not in present]
    for r in v["rules"]:
        aps = rule_approvers(r)
        if r["documentType"] in GOV:
            if any(approver_spec(a, ROOT, vac) is None for a in aps): errs.append({"code": "DOA_LINT_UNRESOLVABLE_GOVERNANCE", "rule": r["code"]})
        elif any(a["kind"] == "MEMBER" for a in aps): warns.append({"code": "DOA_LINT_MEMBER_APPROVER", "rule": r["code"]})
        elif any(not any(p == a["position"] and f"{p}@{dd}" not in vac and (a["kind"] != "POSITION_OF_ORG" or dd == ROOT) for (p, dd) in HOLD) for a in aps):
            warns.append({"code": "DOA_LINT_VACANT_POSITION", "rule": r["code"]})
    errs += [{"code": "DOA_LINT_AMOUNT_NOT_ALLOWED", "rule": r["code"]} for r in v["rules"] if r["documentType"] in AMOUNT_NONE and (r.get("when") or {}).get("amount")]
    # BR-WF-05 (S6): PARALLEL = a committee of two or more · COUNT names quorumCount in 1..N, the other quorums none
    for r in v["rules"]:
        st = r.get("step")
        if (st and len(st["approvers"]) < 2) or (not st and r.get("mode") == "PARALLEL"): errs.append({"code": "DOA_LINT_PARALLEL_STEP", "rule": r["code"]})
        elif st and ((st["quorum"] == "COUNT") != ("quorumCount" in st) or ("quorumCount" in st and not 1 <= st["quorumCount"] <= len(st["approvers"]))):
            errs.append({"code": "DOA_LINT_QUORUM_INVALID", "rule": r["code"]})
    errs += [{"code": "UNKNOWN_DOCUMENT_TYPE", "rule": r["code"]} for r in v["rules"] if r["documentType"] not in DOC_ORDER]
    return {"errors": errs, "warnings": warns}
def boundary_table(v, doc):
    if doc in AMOUNT_NONE: return {"rows": []}
    rs = sorted([r for r in v["rules"] if r["documentType"] == doc and amount_only(r)], key=lower); rows = []
    for r in rs:
        am = r["when"]["amount"]
        if "lte" not in am: continue
        for amt in (sat(am["lte"]), sat(am["lte"]) + 1):
            hit = [x["code"] for x in rs if matches(x, amt)]
            rows.append({"amount": baht(amt), "rule": hit[0] if len(hit) == 1 else hit})
    return {"rows": rows}
def run_doa_lint(d):
    use_fixtures(d.get("fixtures")); out = []
    for c in d["cases"]:
        i = c["input"]; v = build_version(i)
        got = lint_version(v, frozenset(i.get("vacate") or []), tuple(i.get("modules") or ())) if c["fn"] == "lintDoaVersion" else boundary_table(v, i["documentType"])
        out.append((c["id"], got == c["expect"], got))
    return out
def run_quotes(d):
    bp, out = d.get("vatRateBp", 700), []
    for c in d["cases"]:
        i, nets = c["input"], {}
        for q in i["quotes"]:
            a = sat(q["amount"]); nets[q["ref"]] = a - (2 * a * bp + (10000 + bp)) // (2 * (10000 + bp)) if q["includesVat"] else a
        low = min(nets.values()); lowest = [r for r, v in nets.items() if v == low]
        ok = i["selected"] in lowest or bool(str(i.get("nonLowestQuoteReason", "")).strip())
        got = {"ok": True} if ok else {"error": "VALIDATION_FAILED", "rule": "QUOTE-LOWEST"}
        if "nets" in c["expect"]: got["nets"] = {r: baht(v) for r, v in nets.items()}
        got["lowest"] = lowest
        out.append((c["id"], got == c["expect"], got))
    return out
def run_grni(d):
    from decimal import ROUND_HALF_UP as _HU
    out = []
    for c in d["cases"]:
        lines, by = [], {}
        for l in c["input"]["lines"]:
            rv = int((Decimal(l["accepted"]) * Decimal(l["unitPrice"])).quantize(Decimal("0.01"), _HU) * 100); iv = sat(l["invoiced"])
            g, x = max(rv - iv, 0), max(iv - rv, 0); lines.append({"grni": baht(g), "invoicedNotReceived": baht(x)}); by[l["costCenter"]] = by.get(l["costCenter"], 0) + g
        got = {"lines": lines, "byCostCenter": {k: baht(v) for k, v in by.items()}}
        out.append((c["id"], got == c["expect"], got))
    return out
# ---------- suite workflow (§7.17 · S6): committees, the outcome of a step of slots, the lint of BR-WF-05 ----------
def wf_outcome(i):
    # BR-WF-01, BR-WF-09: a group's result from the first decision of each slot; a REVIEW step's from its groups
    sl = i["slots"]; opens = [n + 1 for n, x in enumerate(sl) if x is None]
    def group(q, qc, nos):
        ds = [sl[n - 1] for n in nos]
        if "RETURN" in ds: return "RETURNED"
        a, r = ds.count("APPROVE"), ds.count("REJECT")
        if q == "ALL": return "REJECTED" if r else ("APPROVED" if a == len(ds) else "OPEN")
        if q == "ANY": return next(({"APPROVE": "APPROVED", "REJECT": "REJECTED"}[x] for x in ds if x is not None), "OPEN")
        need = qc if qc is not None else len(ds)
        return "APPROVED" if a >= need else ("REJECTED" if r > len(ds) - need else "OPEN")
    if i.get("kind") == "REVIEW":
        if "REJECT" in sl: return {"error": "VALIDATION_FAILED", "reason": "REVIEW_CANNOT_REJECT"}
        gs = [(g, group(g["quorum"], g.get("quorumCount"), g["slots"])) for g in i["groups"]]
        if any(o == "RETURNED" for _, o in gs) or all(o == "APPROVED" for _, o in gs):
            return {"outcome": "RETURNED" if any(o == "RETURNED" for _, o in gs) else "APPROVED", "cancel": opens}
        waiting = {n for g, o in gs if o != "APPROVED" for n in g["slots"]}; done = {n for g, o in gs if o == "APPROVED" for n in g["slots"]}
        return {"outcome": "OPEN", "cancel": [n for n in opens if n in done and n not in waiting]}
    o = group(i.get("quorum", "ALL"), i.get("quorumCount"), list(range(1, len(sl) + 1)))
    return {"outcome": o, "cancel": [] if o == "OPEN" else opens}
def wf_versions(d, code, rep_step):
    vs = [copy.deepcopy(v) for f in d["fixtures"] if "/doa-" in f for v in golden["tests/golden/" + f][0]["versions"] if v["code"] == code]
    for v in vs:
        for r in v["rules"]:
            if rep_step and r["code"] == rep_step["rule"]:
                st = r["step"]
                for k in ("quorum", "quorumCount", "approvers"):
                    if k in rep_step: st[k] = rep_step[k]
                if st["quorum"] != "COUNT": st.pop("quorumCount", None)
    return vs
def wf_resolve(d, i, versions=None):
    at = dt(i["at"]); vs = [v for v in (versions if versions is not None else wf_versions(d, i["doa"], i.get("replaceStep"))) if dt(v["effectiveFrom"]) <= at]
    if not vs: return {"error": "DOA_NOT_CONFIGURED"}
    v = vs[-1]; amt = sat(i["amount"]); doc = i["documentType"]
    band = sorted([r for r in v["rules"] if r["documentType"] == doc and amount_only(r)], key=lower)
    top = next((r for r in band if matches(r, amt)), None)
    if top is None: return {"error": "DOA_NOT_CONFIGURED"}
    conf = {i["requester"]} | set(i.get("alsoConflicting", [])); vac = set(i.get("vacate", [])); res = {"rule": top["code"]}
    for r in band[band.index(top):]:
        found = [approver_spec(a, i["department"], vac) for a in rule_approvers(r)]
        if None in found: return {"error": "APPROVER_NOT_FOUND"}
        if r is not top: res["escalatedTo"] = r["code"]
        if "step" not in r:
            if found[0] not in conf: res["steps"] = [{"mode": "SEQUENTIAL", "approvers": found}]; return res
            continue
        st = r["step"]; q = "COUNT" if st["quorum"] == "MAJORITY" else st["quorum"]
        qc = len(st["approvers"]) // 2 + 1 if st["quorum"] == "MAJORITY" else st.get("quorumCount")
        cut = [a for a in found if a in conf]; rest = list(dict.fromkeys(a for a in found if a not in conf))
        if (q == "ALL" and cut) or (q == "ANY" and not rest) or (q == "COUNT" and len(rest) < qc): continue
        res["steps"] = [{"mode": "PARALLEL", "quorum": q, **({"quorumCount": qc} if q == "COUNT" else {}), "approvers": rest}]; return res
    return {"error": "NO_HIGHER_AUTHORITY"}
WF_VARS = ("$amountGross", "$amountNet", "$requestType", "$lineCategories", "$budgetAccountCodes")
def wf_holds(w, i):
    # BR-WF-07: all/any, anyIn over the set variables, money in satang for $amountGross, the ops of §7.9 otherwise
    if "all" in w: return all(wf_holds(x, i) for x in w["all"])
    if "any" in w: return any(wf_holds(x, i) for x in w["any"])
    if "field" not in w: return True
    f, op, v = w["field"], w["op"], w.get("value")
    if op == "anyIn": return bool(set(map(str, v)) & set(i.get(f[1:], []) if f.startswith("$") else i.get("fields", {}).get(f, [])))
    if f == "$amountGross":
        a, b = i["_gross"], sat(v)
        return {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b, "eq": a == b, "ne": a != b}[op]
    x = i.get("requestType") if f == "$requestType" else i.get("fields", {}).get(f)
    return {"eq": str(x) == str(v), "ne": str(x) != str(v), "in": str(x) in [str(y) for y in (v or [])]}[op]
def wf_reviewer(spec, vac):
    # BR-WF-08: POSITION_AT walks up from its department to the root
    if spec["kind"] == "MEMBER": return None if spec["member"] in vac else spec["member"]
    d = spec["department"]
    while d:
        h = HOLD.get((spec["position"], d))
        if h and f"{spec['position']}@{d}" not in vac: return h
        d = PARENT.get(d)
    return None
def wf_one(rule, spec, conf, vac):
    own = wf_reviewer(spec, vac)
    if own is not None and own not in conf: return own, None
    fb = wf_reviewer(rule["fallback"], vac) if rule.get("fallback") else None
    if fb is None or fb in conf: return None, None
    return fb, ("CONFLICT" if own is not None else "VACANT")
def wf_review(d, i):
    at = dt(i["at"]); wfs = [golden["tests/golden/" + f][0] for f in d["fixtures"] if "workflow-versions" in f]
    vs = sorted([v for w in wfs for v in w["versions"] if v["code"] == i.get("workflow") and dt(v["effectiveFrom"]) <= at], key=lambda v: dt(v["effectiveFrom"]))
    if not vs: return None
    rules = [r for r in vs[-1]["rules"] if i["requestType"] in r["requestTypes"] and wf_holds(r["when"], i)]
    if not rules: return None
    conf = {i["requester"]} | set(i.get("alsoConflicting", [])); vac = set(i.get("vacate", []))
    slots, groups = [], []   # slot = {rules, people: [(who, fallback)], groups: set}
    for r in [x for x in rules if x["mode"] == "ALL"]:
        who, fb = wf_one(r, r["reviewers"][0], conf, vac)
        if who is None: return {"error": "REVIEWER_NOT_FOUND", "rule": r["code"]}
        groups.append(("ALL", None, [r["code"]])); slots.append({"rules": [r["code"]], "people": [(who, fb)], "groups": {len(groups) - 1}})
    anys = [x for x in rules if x["mode"] == "ANY"]
    if anys:
        people = []
        for r in anys:
            who, fb = wf_one(r, r["reviewers"][0], conf, vac)
            if who is None: return {"error": "REVIEWER_NOT_FOUND", "rule": r["code"]}
            if who not in [p for p, _ in people]: people.append((who, fb))
        groups.append(("ANY", None, [r["code"] for r in anys])); slots.append({"rules": [r["code"] for r in anys], "people": people, "groups": {len(groups) - 1}})
    for r in [x for x in rules if x["mode"] == "COUNT"]:
        own = []
        for spec in r["reviewers"]:
            who, fb = wf_one(r, spec, conf, vac)
            if who is not None and who not in [o["people"][0][0] for o in own]: own.append({"rules": [r["code"]], "people": [(who, fb)], "groups": set()})
        if len(own) < r["quorumCount"]: return {"error": "REVIEWER_NOT_FOUND", "rule": r["code"]}
        groups.append(("COUNT", r["quorumCount"], [r["code"]]))
        for o in own: o["groups"].add(len(groups) - 1)
        slots += own
    merged = []
    for sl in slots:
        if len(sl["people"]) == 1:
            p = sl["people"][0][0]; into = next((m for m in merged if len(m["people"]) == 1 and m["people"][0][0] == p), None)
            if into:
                into["rules"] += [c for c in sl["rules"] if c not in into["rules"]]; into["groups"] |= sl["groups"]; continue
        merged.append(sl)
    out = {"quorum": "ALL", "slots": []}
    for m in merged:
        x = {"rules": m["rules"], "reviewers": [p for p, _ in m["people"]]}
        if len(m["people"]) == 1 and m["people"][0][1]: x["fallback"] = m["people"][0][1]
        out["slots"].append(x)
    counts = [{"rules": g[2], "quorum": "COUNT", "quorumCount": g[1], "slots": [n + 1 for n, m in enumerate(merged) if gi in m["groups"]]} for gi, g in enumerate(groups) if g[0] == "COUNT"]
    if counts: out["groups"] = counts
    return out
def wf_request_route(d, i):
    i = dict(i)
    i["_gross"] = sat(i["amount"]) if "amount" in i else sat(i["net"]) + sat(i.get("vat", "0"))
    use_doa = {**i, "doa": i["doa"]}
    appr = resolve_doa_code(d, use_doa)
    if "error" in appr: return appr
    rv = wf_review(d, i)
    if rv is not None and "error" in rv: return rv
    return {"review": rv, "approval": appr}
def resolve_doa_code(d, i):
    # the DOA route of a purchase request by the version of one code (resolve() reads DOAV: the file's versions of that code)
    global DOAV
    keep = DOAV
    DOAV = {"versions": [v for f in d["fixtures"] if "/doa-" in f for v in golden["tests/golden/" + f][0]["versions"] if v["code"] == i["doa"]]}
    try:
        got = resolve(i)
    finally:
        DOAV = keep
    return {k: v for k, v in got.items() if k in ("rule", "escalatedTo", "approvers", "error")}
def wf_lint(d, i):
    wfx = next(golden["tests/golden/" + f][0] for f in d["fixtures"] if "workflow-versions" in f)
    v = copy.deepcopy(next(x for x in wfx["versions"] if x["code"] == d["defaults"].get("workflow")))
    v["rules"] += copy.deepcopy(i.get("addRules") or [])
    for r in v["rules"]:
        if r["code"] == (i.get("replaceWhen") or {}).get("rule"): r["when"] = i["replaceWhen"]["when"]
        if r["code"] in (i.get("removeFallback") or []): r.pop("fallback", None)
    types, vac = wfx["requestTypes"], set(i.get("vacate") or [])
    errs, warns, seen = [], [], set()
    def fields(w): return [x for c in w.get("all", []) + w.get("any", []) for x in fields(c)] + ([w["field"]] if "field" in w else [])
    for r in v["rules"]:
        errs += [{"code": "WF_LINT_UNKNOWN_REQUEST_TYPE", "rule": r["code"]} for t in r["requestTypes"] if t not in types]
        known = [t for t in r["requestTypes"] if t in types]
        for f in dict.fromkeys(fields(r["when"])):
            if f not in WF_VARS and (not known or any(f not in types[t] for t in known)): errs.append({"code": "WF_LINT_UNKNOWN_FIELD", "rule": r["code"], "field": f})
        n, qc = len(r["reviewers"]), r.get("quorumCount")
        if not ((r["mode"] == "COUNT" and n >= 2 and qc is not None and 1 <= qc <= n) or (r["mode"] != "COUNT" and n == 1 and qc is None)): errs.append({"code": "WF_LINT_QUORUM_INVALID", "rule": r["code"]})
        if r["code"] in seen: errs.append({"code": "WF_LINT_DUPLICATE_CODE", "rule": r["code"]})
        seen.add(r["code"])
        if any(x["kind"] != "MEMBER" and wf_reviewer(x, vac) is None for x in r["reviewers"]): warns.append({"code": "WF_LINT_VACANT_REVIEWER", "rule": r["code"]})
        if not r.get("fallback"): warns.append({"code": "WF_LINT_NO_FALLBACK", "rule": r["code"]})
        if any(x["kind"] == "MEMBER" for x in r["reviewers"]): warns.append({"code": "WF_LINT_MEMBER_REVIEWER", "rule": r["code"]})
    return {"errors": errs, "warnings": warns}
def wf_withdraw(i, vs):
    # FR-DOA-104 · BR-DOA-18: the version must still wait; the one it was to follow runs until the next waiting one
    at = dt(i["at"]); t = next(v for v in vs if v["no"] == i["withdraw"])
    if t["from"] <= at: return {"error": "INVALID_STATE_TRANSITION", "reason": "ALREADY_EFFECTIVE"}
    nxt = min((v for v in vs if v is not t and v["from"] > t["from"]), key=lambda v: v["from"], default=None)
    for v in vs:
        if v is not t and v["to"] == t["from"]: v["to"] = nxt["from"] if nxt else None
    t["status"] = "WITHDRAWN"
    def at_time(x):
        live = [v for v in vs if v["status"] != "WITHDRAWN" and v["from"] <= x and (v["to"] is None or x < v["to"])]
        return max(live, key=lambda v: v["from"])["no"] if live else None
    return {"ok": True, "to": {v["no"]: v["to"] for v in vs}, "at": at_time}
def wf_withdraw_ok(d, i, exp):
    vs = [{"no": v["version"], "from": dt(v["effectiveFrom"]), "status": "PUBLISHED"} for v in wf_versions(d, i["doa"], None)]
    if i.get("extraVersion"): vs.append({"no": i["extraVersion"]["version"], "from": dt(i["extraVersion"]["effectiveFrom"]), "status": "PUBLISHED"})
    vs.sort(key=lambda v: v["from"])
    for k, v in enumerate(vs): v["to"] = vs[k + 1]["from"] if k + 1 < len(vs) else None
    got = wf_withdraw(i, vs)
    if "error" in got: return got == exp, got
    ok = exp.get("ok") is True and all((got["to"][int(n)] is None) if w is None else got["to"][int(n)] == dt(w) for n, w in (exp.get("effectiveTo") or {}).items())
    ok = ok and all(got["at"](dt(t)) == n for t, n in (exp.get("versionAt") or {}).items())
    return ok, {"ok": True, "effectiveTo": {n: (z(x) if x else None) for n, x in got["to"].items()}}
def wf_backtest(d, i):
    # BR-WF-13: each document twice — by the version in effect when it was sent, and by the draft as if in effect then
    vs = wf_versions(d, i["doa"], None)
    cur = [v for v in vs if v["version"] == i["current"]]; dra = [dict(v, effectiveFrom="1970-01-01T00:00:00Z") for v in vs if v["version"] == i["draft"]]
    def side(r): return {"rule": None, "approvers": [], "error": r["error"]} if "error" in r else {"rule": r.get("escalatedTo", r["rule"]), "approvers": [a for s in r["steps"] for a in s["approvers"]], "error": None}
    rows, load = [], {}
    for doc in i["documents"]:
        base = {**i, "amount": doc["amount"], "at": doc["submittedAt"]}
        c, g = side(wf_resolve(d, base, cur)), side(wf_resolve(d, base, dra))
        ch = c != g
        if ch:
            for m in c["approvers"]: load[m] = load.get(m, 0) - 1
            for m in g["approvers"]: load[m] = load.get(m, 0) + 1
        rows.append({"ref": doc["ref"], "current": {"rule": c["rule"], "approvers": c["approvers"]}, "draft": {"rule": g["rule"], "approvers": g["approvers"]}, "changed": ch})
    return {"rows": rows, "summary": {"total": len(rows), "changed": sum(r["changed"] for r in rows), "load": {k: n for k, n in sorted(load.items()) if n}}}
def wf_reresolve(i):
    # BR-WF-14: the departments of `reparent` sit under their new parent; a task found by its department moves when the
    # walk up now meets another holder; organization-wide positions and named members stay
    old = dict(PARENT); PARENT.update(i["change"]["reparent"]); out = []
    for t in i["tasks"]:
        a = t["approver"]
        if a["kind"] != "POSITION_OF_DEPARTMENT": continue
        dd = t["chargedDepartment"]
        while dd and (a["position"], dd) not in HOLD: dd = PARENT.get(dd)
        if dd and HOLD[(a["position"], dd)] != t["assignee"]: out.append({"task": t["id"], "to": HOLD[(a["position"], dd)], "resolvedFrom": f"POSITION:{a['position']}@{dd}"})
    PARENT.clear(); PARENT.update(old)
    return {"reassign": out}
def wf_activate(d, i):
    # GC-WF-45: the route's version and rule, the holders valid when the step starts
    global HOLD
    at = dt(i["activateAt"]); saved = HOLD; HOLD = dict(HOLD)
    for h in i["holders"]:
        if dt(h.get("validFrom", "2020-01-01T00:00:00Z")) <= at and ("validTo" not in h or at < dt(h["validTo"])): HOLD[(h["position"], h["department"])] = h["member"]
    vs = [v for v in wf_versions(d, i["doa"], None) if dt(v["effectiveFrom"]) <= dt(i["routeCreatedAt"])]
    v = vs[-1]; rule = next(r for r in v["rules"] if r["code"] == i["step"]["rule"])
    amt = baht(sat(rule["when"]["amount"]["gt"]) + 1)
    res = wf_resolve(d, {**i, "amount": amt, "at": i["routeCreatedAt"]}, [v]); HOLD = saved
    if "error" in res: return res
    return {"assignee": res["steps"][0]["approvers"][0], "rule": res.get("escalatedTo", res["rule"]), "version": v["version"]}
def run_workflow(d):
    global HOLD
    use_fixtures(d["fixtures"]); base, out = dict(HOLD), []
    for c in d["cases"]:
        i = {**d["defaults"], **c["input"]}
        HOLD = {**base, **{tuple(k.split("@")): m for k, m in (i.get("replaceHolders") or {}).items()}}
        if c["fn"] in ("reresolveOpenTasks", "activateStep"):
            got = wf_reresolve(i) if c["fn"] == "reresolveOpenTasks" else wf_activate(d, i)
            out.append((c["id"], all(got.get(k) == x for k, x in c["expect"].items()), got)); continue
        if c["fn"] == "withdrawVersion":
            ok, got = wf_withdraw_ok(d, i, c["expect"]); out.append((c["id"], ok, got)); continue
        if c["fn"] == "backtestPolicy":
            got = wf_backtest(d, i); exp = c["expect"]; rows = {r["ref"]: r for r in got["rows"]}
            ok = got["summary"] == exp["summary"] and all(all(rows[w["ref"]].get(k) == x for k, x in w.items()) for w in exp["rows"])
            out.append((c["id"], ok, got)); continue
        if c["fn"] == "stepOutcome": got = wf_outcome(c["input"])
        elif c["fn"] == "lintDoaVersion": got = lint_version(wf_versions(d, i["doa"], i.get("replaceStep"))[0], frozenset(i.get("vacate") or []))
        elif c["fn"] == "lintWorkflowVersion": got = wf_lint(d, i)
        elif c["fn"] == "resolveRequestRoute": got = wf_request_route(d, i)
        else: got = wf_resolve(d, i)
        exp = c["expect"]
        if c["fn"] in ("lintDoaVersion", "lintWorkflowVersion"): ok = got == exp
        elif c["fn"] == "resolveRequestRoute": ok = all(got.get(k) == x for k, x in exp.items()) and ("escalatedTo" in exp.get("approval", {})) == ("escalatedTo" in (got.get("approval") or {}))
        else: ok = all(got.get(k) == x for k, x in exp.items()) and ("escalatedTo" in exp) == ("escalatedTo" in got)
        out.append((c["id"], ok, got))
    HOLD = base; use_fixtures()
    return out
def run_ai_credits(d):
    import math
    prices, out = (d.get("fixture") or {}).get("prices", {}), []
    for c in d["cases"]:
        i = c["input"]
        if "model" in i:
            p, t = prices[i["model"]], i["tokens"]
            n = {k: t.get(k, 0) for k in ("input", "output", "cacheWrite", "cacheRead")}
            if sum(n.values()) == 0: got = {"credits": 0, "ledgerRow": False}
            else:
                r = p["long"] if "long" in p and n["input"] + n["cacheWrite"] + n["cacheRead"] > p["longPromptAbove"] else p
                got = {"credits": -(-sum(n[k] * r[k] for k in n) // 1_000_000_000), "ledgerRow": True}
        elif "uses" in i:
            used, rem, alert = 0, [], None
            for k, u in enumerate(i["uses"]):
                before, used = used, used + u; rem.append(i["grant"] - used)
                if alert is None and before * 10000 < i["grant"] * i["alertAtBp"] <= used * 10000: alert = k
            got = {"remaining": rem, "alertAfterUse": alert}
        else:
            used, res = i["used"], []
            for cost in i["calls"]:
                if i["grant"] - used > 0: res.append("ok"); used += cost
                else: res.append("AI_CREDITS_EXHAUSTED")
            got = {"results": res, "remaining": i["grant"] - used}
        exp = c["expect"]
        out.append((c["id"], all(got.get(k) == v for k, v in exp.items()), got))
    return out
def q4(q):  # quantity ×10⁴ as int
    qs = Decimal(str(q)) * 10000; assert qs == qs.to_integral_value(), "จำนวนเกิน 4 ตำแหน่ง"; return int(qs)
def q4s(n): return str((Decimal(n) / 10000).normalize()) if n % 10000 else str(n // 10000)
def lr_split(total, weights):  # BR-MONEY-02 ข้อ 4 · เศษเท่ากันให้ตำแหน่งแรกก่อน
    W = sum(weights)
    if W == 0: return [0] * len(weights)
    fl = [total * w // W for w in weights]; rm = [total * w % W for w in weights]
    for k in sorted(range(len(weights)), key=lambda k: (-rm[k], k))[: total - sum(fl)]: fl[k] += 1
    return fl
def ivc_nets(inv):  # BR-MATCH-06: ยอดต่อบรรทัดหักส่วนลดท้ายบิลที่ปันตามยอด
    amts = [line_net(l["qty"], sat(l["unitPrice"])) for l in inv["lines"]]
    disc = lr_split(sat(inv.get("discount", "0.00")), amts)
    return [a - d for a, d in zip(amts, disc)], disc
def bud_moves(polines, avail, nets_by_pl, release):  # BR-MATCH-11 ต่อบรรทัดงบตามลำดับที่บรรทัด PO อ้าง
    order, mv = [], {}
    for p in polines:
        net = nets_by_pl.get(p["line"], 0); held = sat(p["held"]); hm = max(net - held, 0); rl = held + hm - net if release else 0
        if p["budgetLine"] not in mv: order.append(p["budgetLine"]); mv[p["budgetLine"]] = [0, 0, 0]
        m = mv[p["budgetLine"]]; m[0] += hm; m[1] += net; m[2] += rl
    short = [(b, mv[b][0] - sat(avail.get(b, "0.00"))) for b in order if mv[b][0] > sat(avail.get(b, "0.00"))]
    return [{"budgetLine": b, "holdMore": baht(mv[b][0]), "actual": baht(mv[b][1]), "release": baht(mv[b][2])} for b in order], short
def run_matching(d):
    pol0, out = d["policy"], []
    for c in d["cases"]:
        i, fn = c["input"], c.get("fn", "match")
        if fn == "duplicates":
            norm = lambda s: re.sub(r"\s+", "", s).upper(); cd = i["candidate"]; no = norm(cd["invoiceNo"])
            live = [e for e in i["existing"] if e["table"] == "CONFIRMATION" or e["status"] not in ("DRAFT", "CANCELLED", "REJECTED")]
            hard = "DUPLICATE_INVOICE" if any(e["supplier"] == cd["supplier"] and norm(e["invoiceNo"]) == no for e in live) else None
            day = lambda s: datetime.fromisoformat(s).toordinal()
            soft = [{"invoiceNo": e["invoiceNo"], "days": abs(day(cd["invoiceDate"]) - day(e["invoiceDate"]))} for e in live
                    if e["taxId"] == cd["taxId"] and sat(e["gross"]) == sat(cd["gross"]) and norm(e["invoiceNo"]) != no]
            got = {"hard": hard, "soft": [s for s in soft if s["days"] <= 3]}
        elif fn == "approveVariance":
            nets, _ = ivc_nets(i["invoice"]); by = {l["poLine"]: n for l, n in zip(i["invoice"]["lines"], nets)}
            budget, short = bud_moves(i["poLines"], i["available"], by, False)
            got = {"error": "BUDGET_INSUFFICIENT", "budgetLine": short[0][0], "shortfall": baht(short[0][1])} if short else {"budget": budget}
        else:
            pol = {**pol0, **i.get("policy", {})}; inv = i["invoice"]; nets, disc = ivc_nets(inv); pls = {p["line"]: p for p in i["poLines"]}
            lines, exc = [], []
            for n, (l, net, dc) in enumerate(zip(inv["lines"], nets, disc), 1):
                p = pls[l["poLine"]]; pu = sat(p["unitPrice"]); exp = line_net(l["qty"], pu); over = max(net - exp, 0); fl = []
                if over > 0:
                    if over * 10000 <= exp * pol["priceTolBp"] and over <= sat(pol["priceTolAmount"]): fl.append("PRICE_OVER_WITHIN")
                    else: exc.append({"type": "PRICE_OVER", "line": n, "amount": baht(over)})
                elif net < exp: fl.append("PRICE_UNDER")
                q, acc, inv_q = q4(l["qty"]), q4(p["accepted"]), q4(p["invoiced"])
                def add(t, x): exc.append({"type": t, "line": n, "qty": q4s(x), "amount": baht(line_net(q4s(x), pu))})
                if i["kind"] == "GOODS":
                    left = max(acc - inv_q, 0)
                    if q * 10000 > left * (10000 + pol["qtyTolBp"]): add("QTY_NOT_RECEIVED", q - left)
                else:
                    oleft = max(q4(p["ordered"]) - inv_q, 0); aleft = max(acc - inv_q, 0)
                    if q > oleft: add("QTY_OVER_ORDERED", q - oleft)
                    if min(q, oleft) > aleft: add("ACCEPTANCE_PENDING", min(q, oleft) - aleft)
                row = {"line": n, "net": baht(net), "expected": baht(exp), "over": baht(over), "flags": fl}
                if "discount" in inv: row["discount"] = baht(dc)
                lines.append(row)
            got = {"lines": lines}
            if exc:
                got.update(result="EXCEPTION", exceptions=exc)
                if all(e["type"] == "PRICE_OVER" for e in exc):
                    dn = sum(sat(e["amount"]) for e in exc); got["doaAmount"] = {"net": baht(dn), "vat": baht(rhu(dn * pol["vatRateBp"], 10000))}
            else:
                by = {l["poLine"]: n for l, n in zip(inv["lines"], nets)}
                budget, short = bud_moves(i["poLines"], i["available"], by, bool(i.get("poClosed")) and bool(inv.get("isFinal")))
                if short: got.update(result="EXCEPTION", exceptions=[{"type": "BUDGET_SHORT", "budgetLine": b, "amount": baht(a)} for b, a in short])
                else: got.update(result="MATCHED", exceptions=[], budget=budget)
        out.append((c["id"], all(got.get(k) == v for k, v in c["expect"].items()), got))
    return out
def run_invoice_vat(d):
    out = []
    for c in d["cases"]:
        i = c["input"]; zero = i["supplierVat"] in ("NOT_REGISTERED", "REGISTRY_VAT_CANCELLED"); r = 0 if zero else i["rateBp"]
        amts = [line_net(l["qty"], sat(l["unitPrice"])) for l in i["lines"]]; disc = lr_split(sat(i.get("discount", "0.00")), amts)
        after = [a - x for a, x in zip(amts, disc)]; base = sum(a for a, l in zip(after, i["lines"]) if l.get("vatable", True))
        if i.get("priceIncludesVat"): v = rhu(base * r, 10000 + r); net = sum(after) - v
        else: v = rhu(base * r, 10000); net = sum(after)
        st = sat(i["statedVat"]); diff = st - v
        status = "VAT_SUPPLIER_NOT_REGISTERED" if i["supplierVat"] != "REGISTERED" and st > 0 else ("VAT_MISMATCH" if abs(diff) > sat("1.00") else "OK")
        got = {"rateBp": r, "net": baht(net), "computedVat": baht(v), "computedGross": baht(net + v), "invoiceGross": baht(net + st), "diff": baht(diff), "status": status}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_ap(d):  # BR-AP-07 วันครบกำหนด (S8-03) · BR-AP-10 เสนอรหัสบัญชี (S8-11)
    out = []
    for c in d["cases"]:
        i = c["input"]
        if c["fn"] == "dueDate":
            days = next(x for x in (i["poTermDays"], i["supplierTermDays"], i["defaultTermDays"]) if x is not None)
            got = {"dueDate": (datetime.fromisoformat(i["invoiceDate"]) + timedelta(days=days)).date().isoformat()}
        elif c["fn"] == "suggestCoding":  # BR-AP-10 · OQ-128 ย้อนหลัง 365 วัน (วันที่ 365 นับ) · บ่อยสุด เท่ากันใช้ครั้งล่าสุด
            day = datetime.fromisoformat(i["invoiceDate"]).date(); uses = {}
            for h in i["history"]:
                at = datetime.fromisoformat(h["invoiceDate"]).date()
                if h["taxId"] != i["taxId"] or h["categoryCode"] != i["categoryCode"] or at > day or (day - at).days > 365: continue
                n, last = uses.get(h["accountCode"], (0, None)); uses[h["accountCode"]] = (n + 1, max(last, at) if last else at)
            bl = i["budgetLine"]
            if uses:
                code, (n, _) = sorted(uses.items(), key=lambda kv: (-kv[1][0], -kv[1][1].toordinal()))[0]
                got = {"accountCode": code, "source": "HISTORY", "count": n, "costCenter": bl["costCenter"]}
            elif bl["accountCode"]: got = {"accountCode": bl["accountCode"], "source": "BUDGET_LINE", "count": 0, "costCenter": bl["costCenter"]}
            else: got = {"accountCode": None, "source": "NONE", "count": 0, "costCenter": bl["costCenter"]}
        else:
            got = {"error": f"fn {c['fn']} ยังไม่มีตัวคำนวณอ้างอิง"}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_price_reference(d):
    # BR-PRC-06 (S6-10): periods [validFrom, validTo) of one item and supplier never overlap; a catalogue line takes the
    # agreed price of its supplier, or needs a reason when the item has an agreement with another supplier
    out = []
    for c in d["cases"]:
        i = c["input"]
        fn = c.get("fn")
        if fn == "checkAgreement":
            a = i["add"]
            clash = any(e["item"] == a["item"] and e["supplier"] == a["supplier"] and a["validFrom"] < e["validTo"] and e["validFrom"] < a["validTo"] for e in i["existing"])
            got = {"error": "VALIDATION_FAILED", "reason": "AGREEMENT_OVERLAP"} if clash else {"ok": True}
        elif fn == "checkAgreementLine":
            ag, ln = i["agreement"], i["line"]
            if ag["item"] != ln["item"]: got = {"ok": True}
            elif ag["supplier"] == ln["supplier"]:
                got = {"ok": True} if sat(ag["unitPrice"]) == sat(ln["unitPrice"]) else {"error": "VALIDATION_FAILED", "reason": "AGREEMENT_PRICE_LOCKED"}
            else:
                got = {"ok": True} if (i.get("offAgreementReason") or "").strip() else {"error": "VALIDATION_FAILED", "reason": "AGREEMENT_OFF"}
        elif fn == "quoteRange":
            # BR-PRC-04: each quote before VAT (BR-FORM-06: net = gross × 10000 ÷ (10000 + rate), half up)
            rate = i["vatRateBp"]
            nets = {q["ref"]: (int((Decimal(sat(q["amount"])) * 10000 / (10000 + rate)).to_integral_value(rounding=ROUND_HALF_UP)) if q["includesVat"] else sat(q["amount"])) for q in i["quotes"]}
            sel = nets.get(i.get("selected")); low = min(nets.values())
            got = {"count": len(nets), "lowest": baht(low), "highest": baht(max(nets.values())), "selected": baht(sel) if sel is not None else None, "selectedIsLowest": sel == low}
        else:
            got = prc_reference(d, i)
            out.append((c["id"], all(got.get(k) == x for k, x in c["expect"].items()), got)); continue
        out.append((c["id"], got == c["expect"], got))
    return out
def prc_reference(d, i):
    # BR-PRC-01 to BR-PRC-03: samples of [at − windowDays, at) priced before VAT; lower median; Bp truncated toward zero;
    # HIGH or LOW compared as whole numbers
    st, df = d["settings"], d["defaults"]; at = dt(i.get("at", df["at"])); start = at - timedelta(days=st["windowDays"])
    rows = [{**{"approvedAt": df["approvedAt"], "priceIncludesVat": df["priceIncludesVat"]}, **x} for x in i["samples"]]
    win = [r for r in rows if start <= dt(r["approvedAt"]) < at]; used = [r for r in win if not r["priceIncludesVat"]]
    xs = sorted(sat(r["unitPrice"]) for r in used); med = xs[(len(xs) - 1) // 2] if xs else None
    last = max(used, key=lambda r: dt(r["approvedAt"])) if used else None
    got = {"count": len(used), "excludedVatIncluded": len(win) - len(used), "min": baht(xs[0]) if xs else None, "median": baht(med) if med is not None else None,
           "max": baht(xs[-1]) if xs else None, "last": baht(sat(last["unitPrice"])) if last else None, "status": "FEW_SAMPLES" if len(used) < st["minSamples"] else "OK"}
    p = sat(i["price"])
    if med is None or med == 0 or i.get("requestIncludesVat"): got.update(deviationBp=None, alert=None)
    else:
        diff = (p - med) * 10000; dev = abs(diff) // med * (1 if diff >= 0 else -1)
        got.update(deviationBp=dev, alert="HIGH" if diff > med * st["alertBp"] else "LOW" if -diff > med * st["alertBp"] else None)
    return got
def run_forms_s6(d):
    # BR-FORM-08: daysLeft by Thai calendar days; the smallest milestone not below them, once, never after the end.
    # BR-FORM-07: answers the current form still has; lines without the service end date, at the agreed price of the
    # request's supplier when there is one; no files, quotations or budget line
    out = []
    for c in d["cases"]:
        i = c["input"]; fn = c["fn"]
        if fn == "daysLeft":
            day = (dt(i["at"]) + timedelta(hours=7)).date()
            got = (datetime.fromisoformat(i["serviceEndDate"]).date() - day).days
        elif fn == "renewalMilestoneDue":
            due = [m for m in d["settings"]["milestoneDays"] if m >= i["daysLeft"]]
            got = None if i["daysLeft"] < 0 or not due or min(due) in i["sent"] else min(due)
        elif fn == "lintFormVersion":
            # BR-FORM-09: a removed field that a rule still present or a workflow rule reads is an error naming them all
            fx = d["formLint"]; errs = []
            for f in i["removeFields"]:
                by = [r for r in i.get("rules", []) if f in fx["rules"].get(r, [])] + [w for w in i.get("workflowRules", []) if f in fx["workflowRules"].get(w, [])]
                if by: errs.append({"code": "FORM_LINT_REFERENCED_FIELD", "field": f, "by": by})
            got = {"errors": errs}
        else:
            src = i["source"]; cur = set(i["currentFields"])
            lines = []
            for l in src["lines"]:
                ag = next((a for a in i.get("agreements", []) if l.get("item") and a["item"] == l["item"] and a["supplier"] == l.get("supplier")), None)
                lines.append({"qty": l["qty"], "unitPrice": ag["unitPrice"] if ag else l["unitPrice"], "serviceEndDate": None, "priceSource": "AGREEMENT" if ag else "SOURCE_REQUEST"})
            full = {"fields": {k: v for k, v in src["fields"].items() if k in cur}, "droppedFields": [k for k in src["fields"] if k not in cur], "lines": lines, "attachments": {}, "quotations": 0, "budgetLine": None}
            exp = c["expect"]
            got = {k: (full[k] if k != "lines" else [{kk: x[kk] for kk in e} for x, e in zip(full["lines"], exp["lines"])]) for k in exp}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_duplicates(d):
    # BR-DUP-01 to BR-DUP-04: line key = description NFC trimmed, spaces collapsed, lower case | uom; within windowDays
    # × 24 h of at, in a counting status; DUPLICATE = same requester and a line of the same key and quantity; SPLIT =
    # same department and (same supplier or a key in common) whose combined amount reaches another PURCHASE_REQUEST rule
    # than the largest alone (DOA version in effect at `at`)
    import unicodedata
    use_fixtures(d["fixtures"]); out = []; df = d["defaults"]; win = timedelta(days=d["policy"]["windowDays"])
    key = lambda l: f"{' '.join(unicodedata.normalize('NFC', l['d']).split()).lower()}|{l['uom']}"
    counting = {"PENDING_APPROVAL", "RETURNED", "APPROVED", "PARTIALLY_ORDERED", "ORDERED", "COMPLETED"}
    def rule(at, amt):
        vs = [v for v in versions() if dt(v["effectiveFrom"]) <= at and (v["_to"] is None or at < v["_to"])]
        cand = sorted([r for r in vs[-1]["rules"] if r["documentType"] == "PURCHASE_REQUEST" and matches(r, amt)], key=lambda r: (r["priority"], -len(r.get("when") or {})))
        return cand[0]["code"] if cand else None
    for c in d["cases"]:
        i = c["input"]; at = dt(i.get("at", df["at"])); cand = {**{k: df[k] for k in ("requester", "department", "supplier")}, **i["candidate"]}
        rec = sorted([{**{k: df[k] for k in ("requester", "department", "supplier")}, **r} for r in i["recent"] if r["status"] in counting and abs(dt(r["submittedAt"]) - at) <= win], key=lambda r: dt(r["submittedAt"]))
        kq = {(key(l), Decimal(l["qty"])) for l in cand["lines"]}; ks = {key(l) for l in cand["lines"]}
        flags = []
        dup = [r["ref"] for r in rec if r["requester"] == cand["requester"] and any((key(l), Decimal(l["qty"])) in kq for l in r["lines"])]
        if dup: flags.append({"kind": "DUPLICATE", "with": dup})
        sp = [r for r in rec if r["department"] == cand["department"] and (r["supplier"] == cand["supplier"] or any(key(l) in ks for l in r["lines"]))]
        if sp:
            amts = [sat(cand["amount"])] + [sat(r["amount"]) for r in sp]; comb = sum(amts)
            ir, cr = rule(at, max(amts)), rule(at, comb)
            if cr is not None and cr != ir: flags.append({"kind": "SPLIT", "with": [r["ref"] for r in sp], "combined": baht(comb), "individualRule": ir, "combinedRule": cr})
        got = {"flags": flags}
        out.append((c["id"], got == c["expect"], got))
    use_fixtures()
    return out
def run_retention(d):  # BR-RET-01 แบ่งงวด · BR-RET-03 เงินประกัน (largest remainder สองส่วน) · BR-WHT-05 ภาษีตอนจ่าย (S8-09)
    out = []
    for c in d["cases"]:
        i = c["input"]; fn = c["fn"]
        if fn == "splitMilestones":
            s = i["sharesBp"]
            if not (2 <= len(s) <= 12) or any(x <= 0 for x in s) or sum(s) != 10000:
                got = {"error": "VALIDATION_FAILED"}
            else:
                unit = sat(i["unitPrice"]); parts = lr_split(q4(i["qty"]), s)
                lines = [{"qty": q4s(p), "net": baht(line_net(q4s(p), unit))} for p in parts]
                total = sum(line_net(q4s(p), unit) for p in parts)
                got = {"lines": lines, "total": baht(total), "driftFromSingleLine": baht(total - line_net(i["qty"], unit))}
        elif fn == "invoicePayment":
            n = sat(i["net"]); v = rhu(n * i["vatRateBp"], 10000); r = lr_split(n, [i["retentionBp"], 10000 - i["retentionBp"]])[0]
            base = n - r; w = rhu(base * i["whtRateBp"], 10000)
            got = {"vat": baht(v), "gross": baht(n + v), "retention": baht(r), "payable": baht(n + v - r), "whtBase": baht(base), "wht": baht(w), "transfer": baht(n + v - r - w)}
        elif fn == "retentionRelease":
            r = sat(i["retention"]); w = rhu(r * i["whtRateBp"], 10000)
            got = {"payable": baht(r), "wht": baht(w), "transfer": baht(r - w)}
        else:
            got = {"error": f"fn {fn} ยังไม่มีตัวคำนวณอ้างอิง"}
        out.append((c["id"], got == c["expect"], got))
    return out
def po_change_totals(i):  # BR-POC-01 BR-POC-02 · ยอดใหม่ของ PO หนึ่งบรรทัดและยอดสำหรับ DOA
    l, ch, r = i["line"], i["change"], i["vatRateBp"]
    ordered, received, invoiced, left = q4(l["ordered"]), q4(l["received"]), q4(l["invoiced"]), q4(l["requestLeft"])
    qty = q4(ch["newQty"]) if "newQty" in ch else ordered
    # เฉพาะจำนวนที่เปลี่ยนถูกตรวจกับที่รับและแจ้งหนี้แล้ว (บรรทัดที่รับเกินในเกณฑ์ BR-GR-02 แล้วไม่แก้จำนวน คงอยู่ได้)
    if qty != ordered and qty < received: return {"error": "PO_CHANGE_BELOW_PROGRESS", "reason": "RECEIVED"}
    if qty != ordered and qty < invoiced: return {"error": "PO_CHANGE_BELOW_PROGRESS", "reason": "INVOICED"}
    if "newUnitPrice" in ch and invoiced > 0: return {"error": "PO_CHANGE_BELOW_PROGRESS", "reason": "LINE_INVOICED"}
    if qty > ordered + left: return {"error": "PO_CHANGE_EXCEEDS_REQUEST", "left": q4s(left)}
    net = line_net(q4s(qty), sat(ch.get("newUnitPrice", l.get("unitPrice", "0.00")))); vat = rhu(net * r, 10000)
    return {"net": baht(net), "vat": baht(vat), "gross": baht(net + vat), "doaAmount": {"net": baht(net), "vat": baht(vat)}}
def run_po_change(d):  # ADR-125 BR-POC-03 · ประกอบจาก submitPo approvePo rejectPo releaseHold reserve (ไม่แก้ run_budget)
    out = []
    for c in d["cases"]:
        if c.get("fn") == "changeTotals":
            got = po_change_totals(c["input"]); out.append((c["id"], got == c["expect"], got)); continue
        B = {"available": 0, "reserved": 0, "committed": 0, "actual": 0}; res, po, funded, ok, why = {}, {}, 0, True, ""
        def mv(a, b, amt):
            if amt < 0 or B[a] < amt: raise BudgetErr("BUDGET_INSUFFICIENT" if a == "available" else "INVARIANT")
            B[a] -= amt; B[b] += amt
        for n, s in enumerate(c["steps"], 1):
            snap = (dict(B), dict(res), {k: dict(v) for k, v in po.items()}); err = None
            try:
                op = s["op"]
                if op == "fund": B["available"] += sat(s["amount"]); funded += sat(s["amount"])
                elif op == "reserve": mv("available", "reserved", sat(s["amount"])); res[s["source"]] = res.get(s["source"], 0) + sat(s["amount"])
                elif op == "submitPo":
                    need = sat(s["need"]); rel = sum(sat(x["releasable"]) for x in s["sources"]); delta = max(need - rel, 0)
                    po[s["po"]] = {"need": need, "src": [(x["source"], sat(x["releasable"])) for x in s["sources"]], "delta": delta, "com": 0, "chg": None}
                    if delta: mv("available", "reserved", delta)
                elif op == "approvePo":
                    p = po[s["po"]]
                    for src, r in p["src"]: mv("reserved", "available", r); res[src] -= r
                    if p["delta"]: mv("reserved", "available", p["delta"]); p["delta"] = 0
                    mv("available", "committed", p["need"]); p["com"] = p["need"]
                elif op == "submitChange":  # จอง max(Δ − releasable ของจำนวนที่เพิ่ม, 0) ในนามบรรทัด PO
                    p = po[s["po"]]; dlt = sat(s["newNet"]) - p["com"]; add = sat(s["addedReleasable"])
                    rsv = max(dlt - add, 0) if dlt > 0 else 0
                    if rsv: mv("available", "reserved", rsv)
                    p["chg"] = {"delta": dlt, "rsv": rsv, "add": add, "src": p["src"][0][0]}
                elif op == "approveChange":
                    p = po[s["po"]]; ch = p["chg"]
                    # แต่ละข้อของ BR-POC-03 แยกกัน (เงินกับจำนวนของบรรทัดขยับสวนกันได้): คืนการจองของใบแก้ไขและ releasable
                    # ของจำนวนที่เพิ่ม แล้วถือ Δ (Δ < 0 คืนถือเท่าขนาด) · จำนวนที่ลดจัดการตาม disposition
                    if ch["add"]: mv("reserved", "available", ch["add"]); res[ch["src"]] -= ch["add"]
                    if ch["rsv"]: mv("reserved", "available", ch["rsv"])
                    if ch["delta"] > 0: mv("available", "committed", ch["delta"])
                    elif ch["delta"] < 0: mv("committed", "available", -ch["delta"])
                    p["com"] += ch["delta"]
                    if s.get("disposition") == "RETURN_TO_POOL":
                        back = sat(s["removedReleasable"]); mv("available", "reserved", back); res[ch["src"]] = res.get(ch["src"], 0) + back
                    p["chg"] = None
                elif op == "rejectChange":
                    p = po[s["po"]]; ch = p["chg"]
                    if ch["rsv"]: mv("reserved", "available", ch["rsv"])
                    p["chg"] = None
            except BudgetErr as e:
                err = str(e); B, res, po = snap[0], snap[1], snap[2]
            if err != s.get("expectError"): ok, why = False, f"step {n}: error คาด {s.get('expectError')} ได้ {err}"
            if "expect" in s:
                gotb = {k: baht(v) for k, v in B.items()}
                if gotb != s["expect"]: ok, why = False, f"step {n}: คาด {s['expect']} ได้ {gotb}"
            if sum(B.values()) != funded: ok, why = False, f"step {n}: INV-BUD-01 ผลรวม {baht(sum(B.values()))} ≠ {baht(funded)}"
            if not ok: break
        out.append((c["id"], ok, why or "ok"))
    return out
def run_ai_eval_score(d):
    from decimal import Decimal as D, InvalidOperation
    def norm(field, v):
        if v is None or str(v).strip() == "": return None
        t, last = str(v).strip(), field.split(".")[-1]
        try:
            if last == "taxId": return re.sub(r"[\s-]", "", t)
            if last == "docNo": return None if t == "ไม่มีเลขที่" else re.sub(r"\s+", "", t).upper()
            if last in ("net", "vat", "gross", "discountTotal", "unitPrice", "amount"):
                x = D(t.replace(",", ""))
                return None if x != x.quantize(D("0.01")) else str(int(x * 100))
            if last == "qty": return str(int(D(t.replace(",", "")) * 10000))
            return re.sub(r"\s+", " ", t)
        except InvalidOperation: return "\0bad"
    out = []
    for c in d["cases"]:
        i, fn = c["input"], c["fn"]
        if fn == "matchField":
            e, a = norm(i["field"], i["expected"]), norm(i["field"], i["actual"])
            got = {"match": e == a and e != "\0bad"}
        elif fn == "normalizeAnswer":
            kept, disc = 0, 0
            for l in i["lines"]:
                amt = D(str(l["qty"])) * D(str(l["unitPrice"]))
                if amt < 0: disc += -amt
                else: kept += 1
            got = {"lines": kept, "discountTotal": f"{disc:.2f}"}
        else:
            score = i["correct"] * 10000 // i["total"]
            got = {"scoreBp": score, "pass": score >= i["thresholdBp"] and not (i.get("critical") and i["missed"] > 0)}
        out.append((c["id"], all(got.get(k) == v for k, v in c["expect"].items()), got))
    return out
def _ai_sat(v):
    from decimal import Decimal as D
    return None if v is None or str(v).strip() == "" else int((D(str(v).replace(",", "")) * 100).to_integral_value())
def _ai_amt(x): return f"{'-' if x < 0 else ''}{abs(x) // 100}.{abs(x) % 100:02d}"
def _ai_div(n, d): return (2 * n + d) // (2 * d) if n >= 0 else -((2 * -n + d) // (2 * d))
def _ai_line(q, p):
    from decimal import Decimal as D
    qs = int(D(str(q)) * 10000); return _ai_div(qs * p, 10000)
def _ai_taxok(t):
    t = re.sub(r"[\s-]", "", t)
    if not re.fullmatch(r"\d{13}", t): return False
    return (11 - sum(int(t[i]) * (13 - i) for i in range(12)) % 11) % 10 == int(t[12])
def _ai_set(base, changes):
    import copy
    r = copy.deepcopy(base)
    for k, v in (changes or {}).items():
        parts, o = k.split("."), r
        for x in parts[:-1]: o = o[int(x)] if isinstance(o, list) else o.setdefault(x, {})
        if isinstance(o, list): o[int(parts[-1])] = v
        else: o[parts[-1]] = v
    return r
def _ai_verify(doc, fx, now):
    import datetime as dt
    fail, warn, skip, fl, comp = [], [], [], set(), {}
    def F(c, *p): fail.append(c); fl.update(p)
    def W(c, *p): warn.append(c); fl.update(p)
    inv = doc["docType"] == "TAX_INVOICE"
    if doc.get("currency", "THB") != "THB":
        return {"status": "FAIL", "fail": ["CURRENCY"], "warn": [], "skip": [], "flagged": ["*"]}
    sup = fx["suppliers"].get(doc["supplier"]) if doc.get("supplier") else None
    lines = doc["lines"]
    neg = [i for i, l in enumerate(lines) if l.get("amount") is not None and _ai_sat(l["amount"]) < 0]
    disc_read = _ai_sat(doc.get("discountTotal"))
    amb = bool(neg) and disc_read is not None
    norm = None
    if neg and not amb: norm = {"lines": len(lines) - len(neg), "discountTotal": _ai_amt(sum(-_ai_sat(lines[i]["amount"]) for i in neg))}
    priced = doc["docType"] != "DELIVERY_NOTE" and any(doc.get(k) is not None for k in ("net", "vat", "gross"))
    if not priced: skip += ["LINE_AMOUNT", "NET_TOTAL", "VAT_AMOUNT", "GROSS_TOTAL"]
    else:
        total = 0
        for i, l in enumerate(lines):
            c = _ai_line(l["qty"], _ai_sat(l["unitPrice"]))
            if c != _ai_sat(l["amount"]): F("LINE_AMOUNT", f"lines.{i}.amount")
            if i not in neg: total += c
        if amb:
            F("DISCOUNT_AMBIGUOUS", "discountTotal", *[f"lines.{i}.amount" for i in neg], "net", "vat", "gross"); skip += ["NET_TOTAL", "VAT_AMOUNT", "GROSS_TOTAL"]
        else:
            disc = (disc_read or 0) + sum(-_ai_sat(lines[i]["amount"]) for i in neg)
            base = total - disc
            net, vat, gross = _ai_sat(doc.get("net")), _ai_sat(doc.get("vat")), _ai_sat(doc.get("gross"))
            vatreg = sup["vatRegistered"] if sup else True
            d = doc.get("docDate")
            rate = next((r["rateBp"] for r in fx["rates"] if r["effectiveFrom"] <= d <= r["effectiveTo"]), None) if d else None
            vc = 0 if not vatreg else (None if rate is None else (_ai_div(base * rate, 10000 + rate) if doc.get("priceIncludesVat") else _ai_div(base * rate, 10000)))
            if doc.get("priceIncludesVat"):
                if gross != base: F("GROSS_TOTAL", "gross")
                if net != gross - vat: F("NET_TOTAL", "net")
                comp["gross"] = _ai_amt(base)
                if vc is not None: comp["vat"] = _ai_amt(vc); comp["net"] = _ai_amt(base - vc)
            else:
                if net != base: F("NET_TOTAL", "net")
                if gross != net + vat: F("GROSS_TOTAL", "gross")
                comp["net"] = _ai_amt(base)
                if vc is not None: comp["vat"] = _ai_amt(vc); comp["gross"] = _ai_amt(base + vc)
            if not vatreg:
                skip.append("VAT_AMOUNT")
                if vat != 0: F("NON_VAT_SELLER", "vat")
            elif rate is None:
                F("VAT_RATE_MISSING", "vat", "gross"); skip.append("VAT_AMOUNT")
            else:
                diff = abs(vat - vc); comp["_diff"] = _ai_amt(diff)
                if diff > 100: F("VAT_AMOUNT", "vat")
                elif diff > 0: W("VAT_AMOUNT", "vat")
    seller = doc.get("seller", {})
    if seller.get("taxId") and not _ai_taxok(seller["taxId"]): F("TAXID_CHECKSUM", "seller.taxId")
    if sup is None: skip += ["SELLER_MATCH", "SELLER_BRANCH"]
    else:
        if re.sub(r"[\s-]", "", seller.get("taxId") or "") != sup["taxId"]: F("SELLER_MATCH", "seller.taxId")
        if seller.get("branch") != sup["branch"]: (F if inv else W)("SELLER_BRANCH", "seller.branch")
    buyer = (doc.get("buyer") or {}).get("taxId")
    if buyer and re.sub(r"[\s-]", "", buyer) != fx["orgTaxId"]: (F if inv else W)("BUYER_MATCH", "buyer.taxId")
    today = (dt.datetime.fromisoformat(now.replace("Z", "+00:00")) + dt.timedelta(hours=7)).date()
    dd = doc.get("docDate")
    if dd:
        y, m, dday = map(int, dd.split("-"))
        try: age = (today - dt.date(y, m, dday)).days
        except ValueError: age = None
        if age is None or age < 0: F("DOC_DATE_FUTURE", "docDate")
        elif age > 365: W("DOC_DATE_OLD", "docDate")
    out = {"status": "FAIL" if fail else "WARN" if warn else "PASS", "fail": fail, "warn": warn, "skip": skip, "flagged": sorted(fl), "computed": {k: v for k, v in comp.items() if k != "_diff"}}
    if "_diff" in comp: out["vatDiff"] = comp["_diff"]
    if norm: out["normalized"] = norm
    return out
def _ai_cmp(got, exp):
    for k, v in exp.items():
        g = got.get(k)
        if k in ("fail", "warn", "skip", "flagged"):
            if sorted(g or []) != sorted(v): return False
        elif isinstance(v, dict):
            if not isinstance(g, dict) or any(g.get(a) != b for a, b in v.items()): return False
        elif g != v: return False
    return True
def run_ai_verify(d):
    fx, out = d["fixture"], []
    for c in d["cases"]:
        i = c["input"]
        doc = _ai_set(fx["bases"][i["base"]], i.get("set"))
        got = _ai_verify(doc, fx, i.get("now", fx["now"]))
        out.append((c["id"], _ai_cmp(got, c["expect"]), got))
    return out
def run_ai_confidence(d):
    fx, out = d["fixture"], []
    for c in d["cases"]:
        i = c["input"]
        cap = {"FAIL": 0, "WARN": 5000}.get(i["check"], 10000)
        bp = min(max(0, min(100, i["modelConfidence"])) * 100, cap)
        crit = re.sub(r"^lines\.\d+\.", "lines.*.", i["field"]) in fx["critical"]
        got = {"confidenceBp": bp, "mustConfirm": crit or bp < fx["minConfidenceBp"]}
        out.append((c["id"], _ai_cmp(got, c["expect"]), got))
    return out
def run_ai_quotation_map(d):
    fx, out = d["fixture"], []
    for c in d["cases"]:
        i = c["input"]
        r = _ai_set(fx["readings"][i["reading"]], i.get("set"))
        fails = (i.get("checks") or {}).get("fail", [])
        flags, inc = [], bool(r.get("priceIncludesVat"))
        reg = next((k for k, v in fx["registry"].items() if v["taxId"] == r["seller"]["taxId"] and v["branch"] == r["seller"].get("branch", "00000")), None)
        if reg is None: flags.append("SUPPLIER_NOT_REGISTERED")
        unver = any(x in fails for x in ("NET_TOTAL", "GROSS_TOTAL", "DISCOUNT_AMBIGUOUS"))
        if unver: flags.append("AMOUNT_UNVERIFIED")
        amt = None if unver else _ai_amt(_ai_sat(r["gross"] if inc else r["net"]))
        negs = [l for l in r["lines"] if _ai_sat(l.get("amount")) is not None and _ai_sat(l["amount"]) < 0]
        disc = "DISCOUNT_AMBIGUOUS" in fails or r.get("discountTotal") is not None or bool(negs)
        if disc: flags.append("DISCOUNT_NOT_MAPPABLE")
        qn = None if amt is None else (_ai_amt(_ai_sat(amt) - _ai_div(_ai_sat(amt) * fx["vatRateBp"], 10000 + fx["vatRateBp"])) if inc else amt)
        got = {"quotation": {"supplierId": reg, "supplierName": fx["registry"][reg]["nameTh"] if reg else r["seller"].get("name"), "amount": amt, "includesVat": inc, "fileId": fx["fileId"]},
               "quoteNet": qn, "priceIncludesVat": inc, "lines": None if disc else [{"qty": l["qty"], "uom": l["unit"], "unitPrice": l["unitPrice"]} for l in r["lines"]], "flags": flags}
        ok = _ai_cmp({k: v for k, v in got.items() if k != "lines"}, {k: v for k, v in c["expect"].items() if k != "lines"}) and ("lines" not in c["expect"] or c["expect"]["lines"] == got["lines"])
        out.append((c["id"], ok, got))
    return out
def run_ai_dn_map(d):
    from decimal import Decimal as D
    po, out = d["fixture"]["poLines"], []
    for c in d["cases"]:
        flags, use = [], []
        for i, l in enumerate(c["input"]["dnLines"]):
            p = next((x for x in po if x["lineNo"] == l["poLineNo"]), None)
            if p is None: flags.append({"code": "PO_LINE_UNKNOWN", "dnLine": i})
            elif p["uom"] != l["unit"]: flags.append({"code": "UOM_MISMATCH", "dnLine": i})
            else: use.append((p, l))
        pre, seen = [], set()
        for p, l in use:
            same = [u for u in use if u[0]["lineNo"] == p["lineNo"]]
            if len(same) > 1:
                if p["lineNo"] not in seen: flags.append({"code": "DUPLICATE_PO_LINE", "lineNo": p["lineNo"]}); seen.add(p["lineNo"])
                continue
            pre.append({"lineNo": p["lineNo"], "received": l["qty"]})
            if D(l["qty"]) > D(p["openQty"]): flags.append({"code": "OVER_OPEN", "lineNo": p["lineNo"]})
        got = {"prefill": pre, "flags": flags}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_ai_intake_channel(d):
    from decimal import Decimal as D
    fx, out = d["fixture"], []
    cat = {i["itemCode"]: i["agreements"] for i in fx["catalog"]}
    def inforce(a): return a["validFrom"] <= fx["asOf"] and (a.get("validTo") is None or fx["asOf"] < a["validTo"])
    for c in d["cases"]:
        codes = [l["itemCode"] for l in c["input"]["lines"]]
        known = bool(codes) and all(x is not None for x in codes)
        recent = [p for p in fx["pastRequests"] if p["daysAgo"] <= fx["reorderLookbackDays"]]
        if known and all(any(inforce(a) for a in cat.get(x, [])) for x in codes): got = {"channel": "CATALOG", "requiredRules": []}
        elif known and all(any(p["itemCode"] == x for p in recent) for x in codes):
            latest = sorted([p for p in recent if p["itemCode"] in codes], key=lambda p: p["daysAgo"])[0]
            got = {"channel": "REORDER", "reorderFrom": latest["number"], "requiredRules": []}
        else:
            g, req = D(c["input"]["amountGross"]), []
            for r in fx["rules"]:
                v, op = D(r["when"]["value"]), r["when"]["op"]
                if {"gt": g > v, "gte": g >= v, "lt": g < v, "lte": g <= v, "eq": g == v}[op]: req.append(r["id"])
            got = {"channel": "STANDARD", "requiredRules": req}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_ai_text(d):
    import re as _re
    fx, out = d["fixture"], []
    months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]
    def render(v):
        k, x = v["kind"], v["value"]
        if k == "money":
            s = _ai_amt(_ai_sat(str(x))); w, f = s.split(".")
            return f"{int(w):,}.{f}"
        if k == "bp":
            w, r = int(x) // 100, str(int(x) % 100).rjust(2, "0").rstrip("0")
            return f"{w}{'.' + r if r else ''}%"
        if k == "date":
            y, m, dd = (int(p) for p in str(x).split("-")); return f"{dd} {months[m - 1]} {y + 543}"
        return str(x)
    ph = _re.compile(r"\{\{v:([^}]+)\}\}")
    for c in d["cases"]:
        prof, vals, got = fx["profiles"][c["input"]["profile"]], fx["values"], None
        rendered = []
        for i, s in enumerate(c["input"]["sentences"]):
            keys = ph.findall(s)
            if any(k not in vals for k in keys): got = {"ok": False, "reason": "UNKNOWN_VALUE"}; break
            if _re.search(r"[0-9๐-๙]", ph.sub("", s)): got = {"ok": False, "reason": "DIGIT_OUTSIDE_PLACEHOLDER"}; break
            if any(w.lower() in s.lower() for w in fx["decisionAdvice"]): got = {"ok": False, "reason": "DECISION_ADVICE"}; break
            if i >= prof["maxSentences"]: got = {"ok": False, "reason": "TOO_MANY_SENTENCES"}; break
            t = ph.sub(lambda m: render(vals[m.group(1)]), s)
            if len(t) > prof["maxChars"]: got = {"ok": False, "reason": "SENTENCE_TOO_LONG"}; break
            rendered.append(t)
        if got is None: got = {"ok": True, "rendered": rendered}
        out.append((c["id"], all(got.get(k) == v for k, v in c["expect"].items()), got))
    return out
def run_payment_run(d):  # BR-PAY-02 ถึง BR-PAY-07 BR-PAY-12 · คำนวณอิสระด้วยจำนวนเต็มสตางค์ (S9-02)
    cal, pol, out = d["calendar"], d["policy"], []
    names = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
    day = lambda s: datetime.strptime(s, "%Y-%m-%d").date()
    iso = lambda x: x.isoformat()
    def workday(x): return names[x.weekday()] in cal["workdays"] and iso(x) not in cal["holidays"]
    def thai_today(at): return iso((datetime.strptime(at, "%Y-%m-%dT%H:%M:%SZ") + timedelta(hours=7)).date())
    def item(docs):
        payable = sum(sat(x["payable"]) for x in docs); groups = {}
        for x in docs:
            for l in x.get("whtLines", []):
                k = (l["incomeType"], l["rateBp"]); groups[k] = groups.get(k, 0) + sat(l["base"])
        lines = [{"incomeType": k[0], "rateBp": k[1], "base": baht(b), "wht": baht(rhu(b * k[1], 10000))} for k, b in groups.items()]
        wht = sum(rhu(b * k[1], 10000) for k, b in groups.items()); transfer = payable - wht
        if transfer <= 0: return {"error": "PAYMENT_ITEM_NOT_POSITIVE", "transfer": baht(transfer)}
        return {"payable": baht(payable), "whtLines": lines, "wht": baht(wht), "transfer": baht(transfer)}
    def next_run(today):
        t = day(today); x = t
        while True:
            if names[x.weekday()] in pol["runWeekdays"]:
                c = x
                while not workday(c): c += timedelta(days=-1 if pol["holidayShift"] == "PREVIOUS" else 1)
                if c >= t: return iso(c)
            x += timedelta(days=1)
    order = ["REGISTRY_CHANGED", "SUPPLIER_INACTIVE", "RISK_OVERRIDE_EXPIRED", "PREVIOUSLY_EXPORTED", "BANK_ACCOUNT_RECENTLY_CHANGED", "BANK_CHANGE_PENDING", "SHARED_BANK_ACCOUNT"]
    for c in d["cases"]:
        fn, i = c["fn"], c["input"]
        if fn == "buildItem": got = item(i["docs"])
        elif fn == "buildRun":
            items = []
            for n, s in enumerate(sorted(i["suppliers"], key=lambda s: s["code"]), 1):
                r = item(s["docs"]); items.append({"seq": n, "code": s["code"], "payable": r["payable"], "wht": r["wht"], "transfer": r["transfer"]})
            tot = lambda f: baht(sum(sat(x[f]) for x in items))
            got = {"items": items, "totals": {"payable": tot("payable"), "wht": tot("wht"), "transfer": tot("transfer"), "itemCount": len(items), "documentCount": sum(len(s["docs"]) for s in i["suppliers"])}}
        elif fn == "nextRunDate": got = next_run(i["today"])
        elif fn == "checkPayDate":
            today = thai_today(i["at"])
            got = {"error": "PAYMENT_DATE_INVALID", "reason": "NOT_BUSINESS_DAY"} if not workday(day(i["payDate"])) else ({"error": "PAYMENT_DATE_INVALID", "reason": "PAST"} if i["payDate"] < today else {"ok": True})
        elif fn == "proposeDocuments": got = {"proposed": [x["id"] for x in i["docs"] if x["kind"] == "RETENTION" or x["dueDate"] <= i["payDate"]]}
        elif fn == "checkPaidOn":
            today = thai_today(i["at"])
            got = {"error": "VALIDATION_FAILED", "reason": "PAID_ON_BEFORE_PAY_DATE"} if i["paidOn"] < i["payDate"] else ({"error": "VALIDATION_FAILED", "reason": "PAID_ON_FUTURE"} if i["paidOn"] > today else {"ok": True})
        elif fn == "itemFlags":
            s, a, f = i["supplier"], i["account"], set()
            if s["registryFlag"] != "NONE": f.add("REGISTRY_CHANGED")
            if s["status"] != "ACTIVE": f.add("SUPPLIER_INACTIVE")
            if any(o["expiresOn"] < i["payDate"] for o in i.get("riskOverrides", [])): f.add("RISK_OVERRIDE_EXPIRED")
            if i.get("previouslyExported"): f.add("PREVIOUSLY_EXPORTED")
            if not a["fromSeed"] and a["activatedOn"] >= iso(day(i["payDate"]) - timedelta(days=pol["recentBankChangeDays"])): f.add("BANK_ACCOUNT_RECENTLY_CHANGED")
            if i.get("pendingChange"): f.add("BANK_CHANGE_PENDING")
            if any(t is None or s["taxId"] is None or t != s["taxId"] for t in i.get("sameAccountTaxIds", [])): f.add("SHARED_BANK_ACCOUNT")
            flags = [x for x in order if x in f]
            got = {"flags": flags, "requiresReason": any(x in order[:4] for x in flags)}
        elif fn == "flagsKey":
            got = ";".join(f'{x["code"]}:{"+".join(y for y in order if y in x["flags"])}' for x in sorted(i["items"], key=lambda x: x["code"]) if x["flags"])
        else: got = {"error": f"fn {fn} ยังไม่มีตัวคำนวณอ้างอิง"}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_bank_account(d):  # BR-SUP-07 · S9-03: ตัวเลขล้วน 10–12 หลัก รหัสธนาคารในรายการ ชื่อไม่มีอักขระควบคุม
    import unicodedata
    banks, out = set(d["banks"]), []
    def bad(reason): return {"error": "VALIDATION_FAILED", "reason": reason}
    for c in d["cases"]:
        i = c["input"]; digits = re.sub(r"[- ]", "", i["accountNo"])
        if re.search(r"[^0-9]", digits): got = bad("ACCOUNT_NO_FORMAT")  # ขีดหรือเว้นวรรคล้วนคือเลข 0 หลัก
        elif not 10 <= len(digits) <= 12: got = bad("ACCOUNT_NO_LENGTH")
        elif i["bankCode"] not in banks: got = bad("BANK_CODE_UNKNOWN")
        elif any(unicodedata.category(ch) == "Cc" for ch in i.get("accountName", "")): got = bad("ACCOUNT_NAME_FORMAT")
        else: got = {"accountNo": digits, "masked": "•" * (len(digits) - 4) + digits[-4:]}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_bank_precheck(d):  # BR-BANK-06 · S9-03: ระดับรอบก่อน แล้วรายการตาม seq · ทุกข้อที่ไม่ผ่าน
    out = []
    for c in d["cases"]:
        x = copy.deepcopy(d["base"])
        for path, v in c["change"].items():
            node, keys = x, path.split(".")
            for k in keys[:-1]: node = node[int(k)] if isinstance(node, list) else node[k]
            node[int(keys[-1]) if isinstance(node, list) else keys[-1]] = v
        run, f, sups, docs = x["run"], [], set(), set()
        items = sorted(x["items"], key=lambda i: i["seq"])
        if run["payerStatus"] != "ACTIVE" or run["payerTemplate"] != run["runTemplate"]: f.append({"check": "PAYER_ACCOUNT_INVALID"})
        total = sum(sat(i["transfer"]) for i in items)
        if total != sat(run["totalTransfer"]): f.append({"check": "TOTAL_MISMATCH", "expected": baht(sat(run["totalTransfer"])), "actual": baht(total)})
        if len(items) != run["itemCount"]: f.append({"check": "COUNT_MISMATCH", "expected": run["itemCount"], "actual": len(items)})
        for i in items:
            reg, s = i.get("register"), i["seq"]
            if not reg or reg["status"] != "ACTIVE": f.append({"seq": s, "check": "ACCOUNT_NOT_ACTIVE"})
            else: f += [{"seq": s, "check": "ACCOUNT_MISMATCH", "field": k} for k in ("bankCode", "accountNo", "accountName") if i["snapshot"][k] != reg[k]]
            if i["supplier"] in sups: f.append({"seq": s, "check": "DUPLICATE_SUPPLIER"})
            sups.add(i["supplier"])
            named = []  # เอกสารที่ซ้ำในรายการเดียวรายงานครั้งเดียวต่อข้อ
            for doc in i["documents"]:
                if doc["id"] in docs and ("DUP", doc["id"]) not in named: named.append(("DUP", doc["id"])); f.append({"seq": s, "check": "DUPLICATE_DOCUMENT_IN_RUN", "document": doc["id"]})
                docs.add(doc["id"])
            for doc in i["documents"]:
                if doc["link"] != "HELD_BY_THIS_RUN" and ("NOT_HELD", doc["id"]) not in named: named.append(("NOT_HELD", doc["id"])); f.append({"seq": s, "check": "DOCUMENT_NOT_HELD", "document": doc["id"]})
        got = {"ok": not f, "failures": f}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_bankfile_neutral(d):  # BR-BANK-04 BR-BANK-05 · S9-03: เทียบ bytes และ sha256 ด้วย hashlib
    import hashlib
    out, by_id = [], {c["id"]: c for c in d["cases"]}
    def q(v): v = str(v); return '"' + v.replace('"', '""') + '"' if any(ch in v for ch in ',"\r\n') else v
    def row(*fields): return ",".join(q(v) for v in fields)
    def inp(c):
        i = c["input"]
        if "sameAs" not in i: return i
        b = inp(by_id[i["sameAs"]]); return {"run": {**b["run"], **i["run"]}, "items": b["items"]}
    for c in d["cases"]:
        i = inp(c); r = i["run"]; items = sorted(i["items"], key=lambda x: x["seq"]); tot = baht(sum(sat(x["amount"]) for x in items))
        lines = [row("H", d["template"], "NOT-A-BANK-FORMAT", r["number"], r["fileVersion"], r["valueDate"], r["payer"]["bankCode"], r["payer"]["accountNo"], len(items), tot)]
        lines += [row("D", x["seq"], x["bankCode"], x["accountNo"], x["accountName"], baht(sat(x["amount"])), x["supplierCode"], f'{r["number"]}-{x["seq"]:03d}') for x in items]
        lines.append(row("T", len(items), tot))
        data = b"\xef\xbb\xbf" + "".join(l + "\r\n" for l in lines).encode("utf-8")
        got = {"fileName": f'{d["template"]}_NOT-A-BANK-FORMAT_{r["number"]}_v{r["fileVersion"]}.csv', "lines": lines, "itemCount": len(items), "total": tot, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        out.append((c["id"], got == c["expect"], got))
    return out
def run_budget_change(d):
    # BR-BUD-09 to BR-BUD-11 (S6-15): a transfer or a decrease reserves its source at submit (all or BUDGET_INSUFFICIENT);
    # approved, the reservation leaves the source (AVAILABLE → OUTSIDE, funded down) and enters the destination
    # (OUTSIDE → AVAILABLE, funded up); rejected, it comes back. The DOA input: net = the amount, vat 0, the department of
    # the source (TRANSFER DECREASE) or the destination (INCREASE), the sender as the conflict.
    # BR-BUD-12 to BR-BUD-15, BR-BUD-18 (S6-16): an approved overrun funds X = M − available and earmarks it; sending the
    # request uses needed = max(0, M − available) of it (more → BUDGET_INSUFFICIENT) and the rest leaves; a lapse returns
    # X; after use, what one command gives back of the request (its lines and the PO lines from them, net) leaves the line
    # up to what is still outstanding (used − returned after use), to the overrun used last first
    out = []
    for c in d["cases"]:
        if c.get("fn") == "transferDoaInput":
            i = c["input"]; dept = (i["to"] if i["kind"] == "INCREASE" else i["from"])["department"]
            got = {"documentType": "BUDGET_TRANSFER", "net": i["amount"], "vat": "0.00", "department": dept, "conflict": [i["submitter"]]}
            out.append((c["id"], got == c["expect"], got)); continue
        if c.get("fn") == "budgetBurn":
            # BR-BUD-17 (S6-18): fiscal year of 365 days · thresholds [8000, 10000] · forecast from 30 days (the suite header)
            i = c["input"]; funded = sat(i["funded"]); used = sat(i["committed"]) + sat(i["actual"]); days = i["elapsedDays"]
            if funded <= 0: got = {"usedBp": None, "forecastBp": None, "alerts": []}
            else:
                used_bp = used * 10000 // funded
                forecast = used * 365 * 10000 // (funded * days) if days >= 30 else None
                alerts = [f"USED_{t}" for t in (8000, 10000) if used_bp >= t] + (["FORECAST_OVER"] if forecast is not None and forecast > 10000 else [])
                got = {"usedBp": used_bp, "forecastBp": forecast, "alerts": alerts}
            out.append((c["id"], got == c["expect"], got)); continue
        if c.get("fn") == "splitLine":
            # BR-BUD-16 (S6-17): each part's quantity × the unit price, rounded once (BR-MONEY-02 (1))
            i = c["input"]; price = sat(i["unitPrice"])
            line = lambda q: int((Decimal(q) * price).to_integral_value(rounding=ROUND_HALF_UP))
            nets = [line(p) for p in i["parts"]]
            got = {"nets": [baht(n) for n in nets], "total": baht(sum(nets)), "original": baht(line(sum(Decimal(p) for p in i["parts"])))}
            out.append((c["id"], got == c["expect"], got)); continue
        if c.get("fn") == "chargedDepartmentOf":
            # BR-BUD-16: the department with the most before VAT; a tie goes to the department of the lowest lineNo
            tot = {}
            for l in c["input"]["lines"]:
                t = tot.setdefault(l["department"], [0, l["lineNo"]]); t[0] += sat(l["net"]); t[1] = min(t[1], l["lineNo"])
            got = {"department": sorted(tot.items(), key=lambda kv: (-kv[1][0], kv[1][1]))[0][0]}
            out.append((c["id"], got == c["expect"], got)); continue
        if c.get("fn") == "overrunDoaInput":
            i = c["input"]; x = sat(i["requestNet"]) - sat(i["line"]["available"])
            got = ({"error": "VALIDATION_FAILED", "reason": "NOT_OVER_BUDGET"} if x <= 0 else
                   {"documentType": "OVER_BUDGET", "net": baht(x), "vat": "0.00", "department": i["line"]["department"], "conflict": [i["requester"]]})
            out.append((c["id"], got == c["expect"], got)); continue
        lines = {k: {"available": 0, "reserved": 0, "committed": 0, "actual": 0, "funded": 0} for k in ("A", "B")}
        held = {}; transfers = {}; alloc = {}; overruns = {}; po_request = {}; used_order = [0]; ok = True; trace = []

        def after_use(ln, req, given):  # BR-BUD-18: what the command gave back of `req` on line `ln`, net
            L = lines[ln]; left = min(max(given, 0), L["available"])
            for o in sorted((o for o in overruns.values() if o["request"] == req and o["line"] == ln and o["status"] == "CONSUMED"), key=lambda o: -o["seq"]):
                s_ = min(o["used"] - o["rau"], left)
                if s_ > 0: L["available"] -= s_; L["funded"] -= s_; o["rau"] += s_; left -= s_

        for st in c["steps"]:
            op = st["op"]; err = None; ov = None
            if op == "fund":
                L = lines[st["line"]]; a = sat(st["amount"]); L["available"] += a; L["funded"] += a
            elif op == "reserve":
                L = lines[st["line"]]; a = sat(st["amount"])
                if a > L["available"]: err = ("BUDGET_INSUFFICIENT", a - L["available"])
                else: L["available"] -= a; L["reserved"] += a; alloc["REQ:" + st["source"]] = alloc.get("REQ:" + st["source"], 0) + a
            elif op == "release":
                L = lines[st["line"]]; a = alloc.get("REQ:" + st["source"], 0)
                alloc["REQ:" + st["source"]] = 0; L["reserved"] -= a; L["available"] += a
                after_use(st["line"], st["source"], a)
            elif op == "approveOverrun":
                ln = st.get("line", "A"); L = lines[ln]; x = sat(st["need"]) - L["available"]
                if "expectShortfall" in st and baht(x) != st["expectShortfall"]: ok = False; trace.append(f"shortfall={baht(x)}")
                L["funded"] += x; L["reserved"] += x; alloc["OB:" + st["id"]] = x
                overruns[st["id"]] = ov = {"request": st["request"], "line": ln, "x": x, "status": "APPROVED", "used": 0, "returned": 0, "rau": 0, "seq": 0}
            elif op == "consumeOverrun":
                ov = overruns[st["id"]]; L = lines[ov["line"]]; m = sat(st["need"]); x = alloc["OB:" + st["id"]]
                needed = max(0, m - L["available"])
                if needed > x: err = ("BUDGET_INSUFFICIENT", needed - x)
                else:
                    alloc["OB:" + st["id"]] = 0; L["reserved"] -= x; L["available"] += x
                    L["available"] -= x - needed; L["funded"] -= x - needed
                    L["available"] -= m; L["reserved"] += m; alloc["REQ:" + ov["request"]] = alloc.get("REQ:" + ov["request"], 0) + m
                    used_order[0] += 1; ov.update(status="CONSUMED", used=needed, returned=x - needed, seq=used_order[0])
            elif op == "lapseOverrun":
                ov = overruns[st["id"]]; L = lines[ov["line"]]; x = alloc["OB:" + st["id"]]
                alloc["OB:" + st["id"]] = 0; L["reserved"] -= x; L["funded"] -= x
                ov.update(status="LAPSED", used=0, returned=x)
            elif op == "approvePo":
                L = lines[st["line"]]; req = st["request"]; rel = sat(st["release"]); hold = sat(st["hold"])
                alloc["REQ:" + req] -= rel; L["reserved"] -= rel; L["available"] += rel
                if hold > L["available"]: err = ("BUDGET_INSUFFICIENT", hold - L["available"])
                else:
                    L["available"] -= hold; L["committed"] += hold; alloc["PO:" + st["po"]] = hold; po_request[st["po"]] = req
                    after_use(st["line"], req, rel - hold)
            elif op == "closePo":
                L = lines[st["line"]]; key = "PO:" + st["po"]; act = sat(st["actual"])
                L["committed"] -= act; L["actual"] += act; back = alloc[key] - act
                alloc[key] = 0; L["committed"] -= back; L["available"] += back
                after_use(st["line"], po_request[st["po"]], back)
            elif op == "submitTransfer":
                kind = st.get("kind", "TRANSFER"); a = sat(st["amount"]); transfers[st["id"]] = {"kind": kind, "from": st.get("from"), "to": st.get("to"), "amount": a}
                if kind != "INCREASE":
                    L = lines[st["from"]]
                    if a > L["available"]: err = ("BUDGET_INSUFFICIENT", a - L["available"]); del transfers[st["id"]]
                    else: L["available"] -= a; L["reserved"] += a; held[st["id"]] = a
            elif op == "approveTransfer":
                t = transfers[st["id"]]
                if t["kind"] != "INCREASE":
                    L = lines[t["from"]]; h = held.pop(st["id"]); L["reserved"] -= h; L["funded"] -= h
                if t["kind"] != "DECREASE":
                    L = lines[t["to"]]; L["available"] += t["amount"]; L["funded"] += t["amount"]
            elif op == "rejectTransfer":
                t = transfers[st["id"]]
                if st["id"] in held:
                    L = lines[t["from"]]; h = held.pop(st["id"]); L["reserved"] -= h; L["available"] += h
            else: ok = False; trace.append(f"unknown op {op}")
            if "expectError" in st:
                ok = ok and err is not None and err[0] == st["expectError"] and ("shortfall" not in st or baht(err[1]) == st["shortfall"])
            elif err is not None: ok = False; trace.append(f"{op} {err}")
            for k, exp in (st.get("expect") or {}).items():
                if k in lines:
                    for b, v in exp.items():
                        if baht(lines[k][b]) != v: ok = False; trace.append(f"{op} {k}.{b}={baht(lines[k][b])}")
                elif k in ("used", "returned"):
                    if ov is None or baht(ov[k]) != exp: ok = False; trace.append(f"{op} {k}={ov and baht(ov[k])}")
                elif k == "returnedAfterUse":
                    got = baht(sum(o["rau"] for o in overruns.values()))
                    if got != exp: ok = False; trace.append(f"{op} returnedAfterUse={got}")
                else: ok = False; trace.append(f"unknown expect {k}")
            # INV-BUD-01 · INV-BUD-07: the buckets add up to what the line holds · INV-BUD-02: nothing below zero
            for L in lines.values():
                if L["available"] + L["reserved"] + L["committed"] + L["actual"] != L["funded"]: ok = False; trace.append("INV-BUD-01")
                if min(L.values()) < 0: ok = False; trace.append("INV-BUD-02")
            # INV-BUD-09: a used or lapsed overrun earmarks nothing, used + returned = X, returned after use ≤ used
            for oid, o in overruns.items():
                if o["status"] in ("CONSUMED", "LAPSED") and (alloc["OB:" + oid] or o["used"] + o["returned"] != o["x"] or o["rau"] > o["used"]): ok = False; trace.append("INV-BUD-09")
        out.append((c["id"], ok, trace or "ok"))
    return out
def run_notification_route(d):
    # BR-NOTI-05 to BR-NOTI-07 (S17-10, OQ-165): a template LINE takes (src/server/notifications/line-templates.ts, not the
    # daily summary, not task.escalated to ADMIN) goes by push first when bcsGo, appPush and a device in use; LINE when
    # linked, active and reachable; e-mail always last; DIGEST waits. The push title is push.<template>.title of
    # messages/src/<locale>/push.json (else push.fallback.title), the body the document number only, the path the template's
    # link (task.* → /tasks/<taskId>). Each device's answer: revoke and try the next, alert and go on, or try again.
    import json as _json
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = open(os.path.join(base, "src/server/notifications/line-templates.ts"), encoding="utf-8").read()
    line_templates = set(re.findall(r"'([a-z_]+\.[a-z_]+)'", src[src.index("new Set(["):]))
    titles = {loc: _json.load(open(os.path.join(base, f"messages/src/{loc}/push.json"), encoding="utf-8")) for loc in ("th", "en")}
    def title_of(template, loc):
        node = titles[loc]
        for part in template.split(".") + ["title"]:
            if not isinstance(node, dict) or part not in node: return titles[loc]["fallback"]["title"]
            node = node[part]
        return node if isinstance(node, str) and node else titles[loc]["fallback"]["title"]
    by_line = lambda t, data: t in line_templates and not (t == "task.escalated" and data.get("role") == "ADMIN")
    actions = {"SENT": "DONE", "UNREGISTERED": "REVOKE_DEVICE_TRY_NEXT", "INVALID_TOKEN": "REVOKE_DEVICE_TRY_NEXT", "AUTH_401": "ALERT_NEXT_CHANNEL",
               "AUTH_403": "ALERT_NEXT_CHANNEL", "QUOTA_429": "RETRY", "SERVER_503": "RETRY", "NETWORK": "RETRY"}
    out = []
    for c in d["cases"]:
        i = c["input"]; e = c["expect"]; data = i.get("data", {})
        if "answers" in i:
            got = {"actions": [actions[a] for a in i["answers"]]}; good = got == e
        elif "locale" in i:
            t = i["template"]
            number = data.get("number") if isinstance(data.get("number"), str) and re.fullmatch(r"[^\W_][\w/.-]{0,63}", data.get("number")) else None
            path = f"/tasks/{data['taskId']}" if t.startswith("task.") and "taskId" in data else None
            push = {"title": title_of(t, i["locale"]), "body": number}
            if "data" in e["push"]: push["data"] = {"path": path}
            text = _json.dumps({**push, "data": {"path": path}}, ensure_ascii=False)
            got = {"push": push}; good = push == e["push"] and not any(w in text for w in e.get("absent", []))
        else:
            if i["urgency"] == "DIGEST": got = {"channels": [], "digest": True}
            else:
                ch = []
                if t_push := (i["template"] != "digest.daily" and by_line(i["template"], data) and i.get("bcsGo", True) and i.get("appPush", False) and i.get("activeDevices", 0) > 0): ch.append("PUSH")
                if by_line(i["template"], data) and i.get("lineActive", True) and i.get("lineLinked", False) and i.get("lineReachable", True): ch.append("LINE")
                ch.append("EMAIL"); got = {"channels": ch}
            good = all(got.get(k) == v for k, v in e.items())
        out.append((c["id"], good, got))
    return out
def run_offline_queue(d):
    # BR-APP-05 to BR-APP-10, BR-APP-14 (S17-11): the receiving queue on the phone. outcomes: 2xx SENT · no answer, 5xx,
    # RATE_LIMITED RETRY · 401/UNAUTHENTICATED WAIT_LOGIN · IDEMPOTENCY_CONFLICT CHECK_SERVER · anything else
    # NEEDS_ATTENTION. Wait min(15·2^(n−1), 300) s. Next = the oldest capture (then key) of the member signed in that is
    # due (QUEUED, UPLOADING, RETRY at or past nextTryAt) with no earlier unsettled item of its PO; others' items held;
    # never-sent or refused items older than 7 days expired. POST once every photo has a file, frozen the first time.
    def ts(s): return dt(s).timestamp()
    def isot(t): return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    unsettled = {"QUEUED", "UPLOADING", "SENDING", "RETRY", "WAIT_LOGIN", "NEEDS_ATTENTION", "CHECK_SERVER"}
    def norm(r):
        return {"key": r["key"], "po": r.get("po", "PO-" + r["key"]), "by": r.get("by", "store_p07"), "capturedAt": r.get("capturedAt", "2026-11-02T00:00:00Z"),
                "status": r["status"], "attempts": r.get("attempts", 0), "nextTryAt": r.get("nextTryAt"), "frozen": r.get("frozen"),
                "photos": ([{"fileId": f"f{n + 1}"} for n in range(r["photos"])] if isinstance(r.get("photos"), int) else r.get("photos", [])),
                "code": r.get("code"), "copyPreparedAt": r.get("copyPreparedAt"), "failedAt": r.get("failedAt")}
    def outcome(r):
        if r.get("network"): return "SENT" if False else "RETRY"
        h, code = r["http"], r.get("code")
        if 200 <= h < 300: return "SENT"
        if h >= 500 or code == "RATE_LIMITED": return "RETRY"
        if code == "UNAUTHENTICATED" or h == 401: return "WAIT_LOGIN"
        if code == "IDEMPOTENCY_CONFLICT": return "CHECK_SERVER"
        return "NEEDS_ATTENTION"
    never_sent = lambda i: i["attempts"] == 0 and i["status"] not in ("SENDING", "CHECK_SERVER", "NEEDS_ATTENTION")
    def expired(i, now): return (never_sent(i) or i["status"] == "NEEDS_ATTENTION") and ts(now) - ts(i["capturedAt"]) > 7 * 86400
    def next_step(now, online, session, items, known):
        exp = [i["key"] for i in items if i["status"] == "EXPIRED" or expired(i, now)]
        live = [i for i in items if i["key"] not in exp]
        res = {"next": None, "key": None, "expectedPoVersion": None, "step": None, "waiting": {}, "held": {}, "waitLogin": session is None, "expired": exp}
        if session is None: return res
        res["held"] = {i["key"]: "OTHER_MEMBER" for i in live if i["by"] != session}
        mine = sorted([i for i in live if i["by"] == session], key=lambda i: (ts(i["capturedAt"]), i["key"]))
        cands = []
        for n, it in enumerate(mine):
            earlier = next((o for o in mine[:n] if o["po"] == it["po"] and o["status"] in unsettled), None)
            if earlier: res["waiting"][it["key"]] = "PREVIOUS_NEEDS_ATTENTION" if earlier["status"] == "NEEDS_ATTENTION" else "PREVIOUS_PENDING"; continue
            if it["status"] in ("QUEUED", "UPLOADING") or (it["status"] == "RETRY" and (not it["nextTryAt"] or ts(it["nextTryAt"]) <= ts(now))): cands.append(it)
        if not online or not cands: return res
        ch = cands[0]
        ev = ch["frozen"]["expectedPoVersion"] if ch["frozen"] else known.get(ch["po"])
        ready = all("fileId" in p for p in ch["photos"])
        res.update({"next": ch["key"], "key": ch["key"], "expectedPoVersion": ev, "step": "POST" if ch["frozen"] or ready else "UPLOAD"})
        if res["step"] == "POST":
            fr = ch["frozen"] or {"expectedPoVersion": known[ch["po"]], "photoFileIds": [p["fileId"] for p in ch["photos"]]}
            res.update({"status": "SENDING", "attempts": ch["attempts"] + 1, "frozen": fr})
        return res
    def shown(i):
        o = {"key": i["key"], "status": i["status"]}
        if i["attempts"]: o["attempts"] = i["attempts"]
        if i.get("nextTryAt"): o["nextTryAt"] = i["nextTryAt"]
        if i.get("frozen"): o["frozen"] = i["frozen"]
        return o
    out = []
    for c in d["cases"]:
        i = c["input"]; e = c["expect"]
        items = [norm(r) for r in i.get("items", [])]; known = dict(i.get("knownVersion", {}))
        if "results" in i: got = {"outcomes": [outcome(r) for r in i["results"]]}
        elif "failuresSoFar" in i: got = {"waitSeconds": [min(15 * 2 ** (max(1, n) - 1), 300) for n in i["failuresSoFar"]]}
        elif "photos" in i and "items" not in i:
            now = ts(i["now"])
            got = {"steps": ["DONE" if "fileId" in p else "COMPLETE_SAME_TICKET" if p.get("putDone") and p.get("ticketIssuedAt") and now - ts(p["ticketIssuedAt"]) < 14 * 60 else "REQUEST_NEW_TICKET" for p in i["photos"]]}
        elif "restartAt" in i:
            got = {"items": [shown({**x, "status": "RETRY", "nextTryAt": i["restartAt"]} if x["status"] in ("SENDING", "UPLOADING") else x) for x in items]}
        elif "answer" in i:
            x = items[0]
            if outcome(i["answer"]) == "SENT":
                rest = items[1:]; known = {**known, x["po"]: i["answer"]["poVersion"]} if "poVersion" in i["answer"] else known
                got = {"items": [shown(r) for r in rest], "photosLeft": sum(len(r["photos"]) for r in rest), "knownVersion": known}
            else: got = {"items": "not sent"}
        elif "lookup" in i:
            sent, rest = [], []
            for x in items:
                f = i["lookup"].get(x["key"]) if x["status"] == "CHECK_SERVER" else None
                if not f: rest.append({"key": x["key"], "status": x["status"]})
                elif f["recorded"] and f["ok"]: sent.append(x["key"]); known[x["po"]] = f["poVersion"]
                elif f["recorded"]: rest.append({"key": x["key"], "status": "NEEDS_ATTENTION", "code": f["code"]})
                else: rest.append({"key": x["key"], "status": "NEEDS_ATTENTION", "reason": "NOT_RECORDED"})
            got = {"sent": sent, "items": rest, "knownVersion": known}
        elif "now" not in i and i.get("online") is False:
            warn = {}
            for x in items: warn[x["key"]] = "NOT_SENT" if never_sent(x) or x["status"] == "EXPIRED" else "REJECTED" if x["status"] == "NEEDS_ATTENTION" else "MAY_BE_RECORDED"
            got = {"sendFirst": [], "warn": warn, "deleteOnConfirm": [x["key"] for x in items]}
        elif "now" not in i:
            def edit(x):
                if never_sent(x): return "EDIT_IN_PLACE"
                if x["status"] != "NEEDS_ATTENTION": return "LOCKED"
                if x["code"] == "CONFLICT_VERSION" and not (x["copyPreparedAt"] and x["failedAt"] and ts(x["copyPreparedAt"]) >= ts(x["failedAt"])): return "REFRESH_COPY_FIRST"
                return "RESUBMIT_NEW_KEY"
            got = {"edit": {x["key"]: edit(x) for x in items}, "discard": {x["key"]: "ALLOWED" if never_sent(x) or x["status"] in ("NEEDS_ATTENTION", "EXPIRED") else "LOCKED" for x in items}}
        else:
            session = i.get("session", "store_p07") if "session" in i else "store_p07"
            if i.get("serverAnswers") == "ALL_OK_VERSION_PLUS_1":
                order = []
                while True:
                    s = next_step(i["now"], i.get("online", True), session, items, known)
                    if not s["next"]: break
                    order.append({"key": s["next"], "expectedPoVersion": s["expectedPoVersion"]})
                    po = next(x["po"] for x in items if x["key"] == s["next"])
                    items = [x for x in items if x["key"] != s["next"]]; known[po] = s["expectedPoVersion"] + 1
                got = {"sendOrder": order}
            else: got = next_step(i["now"], i.get("online", True), session, items, known)
        good = {k: got.get(k) for k in e} == e
        out.append((c["id"], good, {k: got.get(k) for k in e}))
    return out
def run_offline_receiving(d):
    # BR-APP-08, BR-APP-10, BR-APP-14 (S17-12, OQ-170): an offline receipt is gr.post as it is. In order: the sender is
    # the one who captured it (FORBIDDEN) → the PO takes goods (INVALID_STATE_TRANSITION) → the PO is at the version of
    # the copy (CONFLICT_VERSION) → captured not before the PO was sent, at most 5 min after now, not older than 7 days
    # (VALIDATION_FAILED CAPTURED_AT) → receiving as ever (GC-GR-05): accepted up to ordered × (1 + tolerance), beyond it
    # an excess disposition is required (EXCESS_DISPOSITION_REQUIRED) and RETURN_EXCESS keeps the tolerance only (a
    # variance OVER of the rest, no approval); the excess within the tolerance is held on the budget, rounded half up once
    # (BUDGET_INSUFFICIENT when short). Each GR moves the PO's version one up. A send whose answer was lost and is sent
    # again with the same key gives the same GR; a photo completed again with the same ticket is the same file.
    now = dt("2026-11-02T03:00:00Z").timestamp(); out = []
    for c in d["cases"]:
        i = c["input"]; e = c["expect"]; p = i["po"]; tol = Decimal(i["tolerancePct"])
        ordered, unit = Decimal(p["ordered"]), Decimal(p["unitPrice"])
        cap = ordered * (1 + tol / 100)
        state = {"version": p["version"], "accepted": Decimal(0), "status": "SENT", "held": Decimal(0), "grs": 0, "variances": []}
        budget = Decimal(i["budgetAvailable"]) if "budgetAvailable" in i else Decimal("1000000")
        for b in i.get("before", []):
            if b.get("onlineGrBy"):
                state["accepted"] += Decimal(b["received"]); state["version"] += 1; state["grs"] += 1
                state["status"] = "RECEIVED" if state["accepted"] >= ordered else "PARTIALLY_RECEIVED"
            if b.get("cancelPo"): state["status"] = "CANCELLED"
        def post(item, st, sent_at):
            if item.get("by", "store_p07") != i.get("actor", "store_p07"): return {"outcome": "NEEDS_ATTENTION", "code": "FORBIDDEN"}
            if st["status"] not in ("SENT", "PARTIALLY_RECEIVED"): return {"outcome": "NEEDS_ATTENTION", "code": "INVALID_STATE_TRANSITION"}
            if item.get("expectedPoVersion", st["version"]) != st["version"]: return {"outcome": "NEEDS_ATTENTION", "code": "CONFLICT_VERSION"}
            at = dt(item["capturedAt"]).timestamp()
            if at < sent_at or at > now + 300 or at < now - 7 * 86400: return {"outcome": "NEEDS_ATTENTION", "code": "VALIDATION_FAILED", "reason": "CAPTURED_AT"}
            total = st["accepted"] + Decimal(item["received"]); variance = None
            if total > cap:
                if not item.get("excessDisposition"): return {"outcome": "NEEDS_ATTENTION", "code": "VALIDATION_FAILED", "reason": "EXCESS_DISPOSITION_REQUIRED"}
                over = total - cap; total = cap
                variance = {"type": "OVER", "quantity": format(over.normalize(), "f"), "amount": str((over * unit).quantize(Decimal("0.01"), ROUND_HALF_UP)), "needsApproval": item["excessDisposition"] == "ACCEPT_EXCESS"}
            held_after = (max(total - ordered, Decimal(0)) * unit).quantize(Decimal("0.01"), ROUND_HALF_UP)
            if held_after - st["held"] > budget: return {"outcome": "NEEDS_ATTENTION", "code": "BUDGET_INSUFFICIENT"}
            st["held"] = held_after; st["accepted"] = total; st["version"] += 1; st["grs"] += 1
            if variance: st["variances"].append(variance)
            st["status"] = "RECEIVED" if total >= ordered else "PARTIALLY_RECEIVED"
            return {"outcome": "SENT", "poVersion": st["version"], "receivedAt": isot(min(at, now)), "offlineCapturedAt": item["capturedAt"], "postedAt": isot(now)}
        def isot(t): return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        got = {}
        if i.get("separatePos"):
            res = []
            for item in i["items"]:
                st = {"version": p["version"], "accepted": Decimal(0), "status": "SENT", "held": Decimal(0), "grs": 0, "variances": []}
                r = post(item, st, dt(item["poSentAt"]).timestamp())
                res.append({"key": item["key"], **({k: r[k] for k in ("outcome", "receivedAt", "offlineCapturedAt", "postedAt")} if r["outcome"] == "SENT" else r)})
            got["results"] = res
        else:
            sent_at = dt("2026-10-30T02:00:00Z").timestamp()
            if i.get("steps"):
                sr, done = [], {}
                for s in i["steps"]:
                    if s.get("upload"):
                        n = next(x for x in i["items"] if x["key"] == s["upload"]).get("photos", 0)
                        sr.append({"photosStored": n, "sameFileIdAfterRetry": True}); got["fileObjects"] = n; continue
                    item = next(x for x in i["items"] if x["key"] == s["send"])
                    r = done.get(item["key"]) or post(item, state, sent_at); first = item["key"] not in done; done[item["key"]] = r
                    if s.get("dropResponse"): sr.append({"outcome": "RETRY", "committedOnServer": r["outcome"] == "SENT"})
                    else: sr.append({"outcome": r["outcome"], "poVersion": r.get("poVersion"), **({"sameGrAsCommitted": True} if not first else {})})
                got["stepResults"] = sr
                got["photoLinks"] = got.get("fileObjects", 0) if state["grs"] else 0
            else:
                got["results"] = [{k: v for k, v in post(item, state, sent_at).items() if k in ("outcome", "poVersion", "code", "reason")} for item in i["items"]]
            got.update({"grCount": state["grs"], "grPostedEvents": state["grs"], "accepted": format(state["accepted"].normalize(), "f"),
                        "commitDelta": str(state["held"].quantize(Decimal("0.01"))), "variances": state["variances"], "poStatus": state["status"]})
        good = {k: got.get(k) for k in e} == e
        out.append((c["id"], good, {k: got.get(k) for k in e}))
    return out
def run_workflow_reports(d):
    # BR-RPT-03 to BR-RPT-06 (S6-20): business minutes of the suite's calendar (as run_sla counts them), the decision
    # time without the INFO_REQUESTED pauses, the lower median, bottlenecks by overdue then median, the Thai weekday and
    # hour of an instant, and the decisions whose decider (or the one they acted for) is not among the expected
    cal = d["calendar"]; wd = {"MON": 0, "TUE": 1, "WED": 2, "THU": 3, "FRI": 4, "SAT": 5, "SUN": 6}
    work = {wd[x] for x in cal["workdays"]}; hol = set(cal["holidays"])
    s0, e0 = dtime.fromisoformat(cal["start"]), dtime.fromisoformat(cal["end"])
    def between(x, y):
        x, y, tot, day = x.astimezone(BKK), y.astimezone(BKK), 0.0, x.astimezone(BKK).date()
        while day <= y.date():
            if day.weekday() in work and day.isoformat() not in hol:
                lo, hi = max(datetime.combine(day, s0, BKK), x), min(datetime.combine(day, e0, BKK), y)
                if hi > lo: tot += (hi - lo).total_seconds() / 60
            day += timedelta(days=1)
        return int(tot)
    names = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
    out = []
    for c in d["cases"]:
        f, i = c["fn"], c["input"]
        if f == "cycleMinutes": got = between(dt(i["from"]), dt(i["to"]))
        elif f == "decisionMinutes":
            a, b = dt(i["assignedAt"]), dt(i["decidedAt"])
            got = between(a, b) - sum(between(max(a, dt(p["from"])), min(b, dt(p["to"]))) for p in i["pauses"] if min(b, dt(p["to"])) > max(a, dt(p["from"])))
        elif f == "lowerMedian": s = sorted(i); got = s[(len(s) - 1) // 2] if s else None
        elif f == "bottlenecks": got = [r["at"] for r in sorted(i, key=lambda r: (-r["overdue"], -(r["median"] if r["median"] is not None else -1)))]
        elif f == "heatCell": t = dt(i["at"]).astimezone(BKK); got = {"weekday": names[t.weekday()], "hour": t.hour}
        elif f == "wrongDoa": got = [x["ref"] for x in i["decisions"] if x["decider"] not in x["expected"] and not (x.get("onBehalfOf") and x["onBehalfOf"] in x["expected"])]
        else: raise ValueError(f)
        out.append((c["id"], got == c["expect"], got))
    return out
# One suite per line, sorted by name: each lane adds its own line, so git merges the additions (P1-07)
RUNNERS = {
    "ai-confidence": run_ai_confidence,
    "ai-credits": run_ai_credits,
    "ai-dn-map": run_ai_dn_map,
    "ai-eval-score": run_ai_eval_score,
    "ai-intake-channel": run_ai_intake_channel,
    "ai-quotation-map": run_ai_quotation_map,
    "ai-text": run_ai_text,
    "ai-verify": run_ai_verify,
    "ap": run_ap,
    "bank-account": run_bank_account,
    "bank-precheck": run_bank_precheck,
    "bankfile-neutral": run_bankfile_neutral,
    "budget": run_budget,
    "budget-change": run_budget_change,
    "consolidation": run_cons,
    "dates": run_dates,
    "delegation": run_delegation,
    "doa": run_doa,
    "doa-lint": run_doa_lint,
    "duplicates": run_duplicates,
    "forms": run_forms,
    "forms-s6": run_forms_s6,
    "grni": run_grni,
    "invoice-confirmation": run_ivc,
    "invoice-vat": run_invoice_vat,
    "matching": run_matching,
    "money": run_money,
    "notification-route": run_notification_route,
    "numbering": run_numbering,
    "offline-queue": run_offline_queue,
    "offline-receiving": run_offline_receiving,
    "payment-run": run_payment_run,
    "po-change": run_po_change,
    "price-reference": run_price_reference,
    "quotations": run_quotes,
    "receiving": run_gr,
    "retention": run_retention,
    "sla": run_sla,
    "sod": run_sod,
    "taxid": run_taxid,
    "thai": run_thai,
    "vat-rate": run_vat,
    "wht": run_wht,
    "workflow": run_workflow,
    "workflow-reports": run_workflow_reports,
}
n_suites = n_cases = 0
for path, (data, ln) in sorted(golden.items()):
    if "/fixtures/" in path: continue
    suite = data.get("suite"); fn = RUNNERS.get(suite)
    if not fn:
        report("FAIL", f"golden:{suite}", f"ไม่มีตัวคำนวณอ้างอิงสำหรับ {path}", "เคสในไฟล์นี้ไม่ถูกตรวจ", "เพิ่ม runner ใน spec_check.py"); continue
    try: res = fn(data)
    except Exception as ex:
        report("FAIL", f"golden:{suite}", f"{path} (บรรทัด {ln}) รันไม่ได้: {type(ex).__name__}: {ex}",
               "ไฟล์ golden มีโครงสร้างที่ test runner จะอ่านไม่ได้", "แก้โครงสร้าง YAML ให้ตรงกับรูปแบบใน §7"); continue
    n_suites += 1; n_cases += len(res); bad = [(cid, g) for cid, ok, g in res if not ok]
    if VERBOSE:
        for cid, ok, g in res: print(f"   {'PASS' if ok else 'FAIL'}  {cid}  {g}")
    if not bad: report("PASS", f"golden:{suite}", f"{len(res)}/{len(res)} เคส ตรงกับการคำนวณอ้างอิง")
    for cid, g in bad:
        report("FAIL", f"golden:{suite} {cid}", f"คำนวณได้ {g}",
               "agent จะเขียน engine ให้ตรงกับค่าที่ผิดใน spec แล้วคำนวณเงินหรือเส้นทางอนุมัติผิดตอนใช้งานจริง",
               f"ตรวจกฎใน §7 แล้วแก้ expect ของ {cid} (บล็อกเริ่มบรรทัด {ln}) หรือแก้กฎถ้ากฎผิด")
m = re.search(r"golden\s+(\d+) ไฟล์ · (\d+) เคส", TEXT)
report("PASS" if m and (int(m.group(1)), int(m.group(2))) == (n_suites, n_cases) else "FAIL", "ตัวเลขตัวอย่างใน §15.5",
       f"นับได้ {n_suites} ไฟล์ · {n_cases} เคส" + ("" if not m else f" (ในเอกสาร {m.group(1)} · {m.group(2)})"),
       "ตัวอย่างผลลัพธ์ขัดกับจำนวนจริง ทำให้คนตรวจเข้าใจผิด", f"แก้เป็น '{n_suites} ไฟล์ · {n_cases} เคส'")

# ---------- DOA fixture lint (BR-DOA-08 ชุดเต็ม) ----------
# doa-versions.yaml with no module on · doa-versions-p1.yaml with PAY on (BR-DOA-23)
for fx, modules in ((DEFAULT_FIXTURES, ()), (["fixtures/org-p1.yaml", "fixtures/doa-versions-p1.yaml"], ("PAY",))):
    use_fixtures(fx); issues = []
    for v in DOAV.get("versions", []):
        res = lint_version(v, modules=modules)
        if res["errors"]: issues.append(f"ฉบับ {v['version']}: {res['errors']}")
    report("PASS" if DOAV and not issues else "FAIL", f"DOA fixture ผ่าน lint ชุดเต็ม (BR-DOA-08) {fx[1]}",
           f"{len(DOAV.get('versions', []))} ฉบับ ไม่มี error" + (f" เมื่อเปิด {', '.join(modules)}" if modules else "") + ": ครอบคลุม (0, ∞) ไม่มีช่องว่าง ไม่ทับกัน และมีข้อของชนิดที่บังคับซึ่งหาผู้อนุมัติได้" if not issues else "; ".join(issues),
           "DOA ตั้งต้นมีช่วงวงเงินที่ไม่มีผู้อนุมัติ หรือลูกค้าล็อกตัวเองออกจากการแก้ DOA", f"แก้ข้อที่ระบุใน tests/golden/{fx[1]}")
use_fixtures()

# ---------- seed tax IDs ----------
appA = TEXT[TEXT.find("## ภาคผนวก A"):TEXT.find("## ภาคผนวก B")]
ids = re.findall(r"(?<!\d)\d{13}(?!\d)", appA); badid = [x for x in ids if not taxid_ok(x)]
report("PASS" if ids and not badid else "FAIL", "เลขผู้เสียภาษีใน seed ผ่าน mod-11",
       f"{len(ids)} เลข ผ่านทั้งหมด" if not badid else f"ไม่ผ่าน: {badid}",
       "seed จะถูกปฏิเสธโดยการตรวจเลขผู้เสียภาษีของระบบเอง", "คำนวณ check digit ใหม่ตาม BR-TAXID-01")

# ---------- LibreOffice oracle for bahtText ----------
thai = golden.get("tests/golden/thai.yaml", ({}, 0))[0]
soffice = shutil.which("soffice") or shutil.which("libreoffice")
if not thai: report("FAIL", "BAHTTEXT oracle", "ไม่พบ tests/golden/thai.yaml")
elif not soffice: report("SKIP", "BAHTTEXT oracle (LibreOffice)", "ไม่พบ LibreOffice ในเครื่องนี้ จึงตรวจได้เฉพาะ implementation อ้างอิง")
else:
    tmp = tempfile.mkdtemp(); rows = "".join(
        f'<table:table-row><table:table-cell office:value-type="float" office:value="{c["input"]}"><text:p>{c["input"]}</text:p></table:table-cell>'
        f'<table:table-cell table:formula="of:=COM.MICROSOFT.BAHTTEXT([.A{k}])"/></table:table-row>' for k, c in enumerate(thai["cases"], 1))
    open(os.path.join(tmp, "bt.fods"), "w", encoding="utf-8").write(
        '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
        'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">'
        f'<office:body><office:spreadsheet><table:table table:name="S">{rows}</table:table></office:spreadsheet></office:body></office:document>')
    try:
        subprocess.run([soffice, "--headless", "--convert-to", 'csv:Text - txt - csv (StarCalc):44,34,76,1', os.path.join(tmp, "bt.fods"), "--outdir", tmp],
                       capture_output=True, timeout=180)
        got = [r[1] for r in csv.reader(open(os.path.join(tmp, "bt.csv"), encoding="utf-8"))]
        diff = [(c["id"], c["expect"], g) for c, g in zip(thai["cases"], got) if c["expect"] != g]
        ver = subprocess.run([soffice, "--version"], capture_output=True, text=True).stdout.split(" (")[0].strip()
        report("PASS" if not diff and len(got) == len(thai["cases"]) else "FAIL", "BAHTTEXT oracle (LibreOffice)",
               f"{len(got)} เคสตรงกับ {ver}" if not diff else f"ต่าง: {diff}",
               "คำอ่านจำนวนเงินบน PR/PO จะไม่ตรงกับที่ฝ่ายบัญชีเทียบในสเปรดชีต", "แก้ expect ใน thai.yaml ตามผลของ LibreOffice หรือเปิด OQ-28")
    except Exception as ex:
        report("SKIP", "BAHTTEXT oracle (LibreOffice)", f"รัน LibreOffice ไม่สำเร็จ: {ex}")

# ---------- print ----------
counts = {"PASS": 0, "FAIL": 0, "SKIP": 0}
print(f"spec_check — {PATH} ({len(LINES)} บรรทัด)")
for st, name, detail, impact, fix in RESULTS:
    counts[st] += 1; print(f"{st:5} {name} — {detail}")
    if st == "FAIL":
        if impact: print(f"      ผลกระทบ: {impact}")
        if fix: print(f"      วิธีแก้: {fix}")
print(f"สรุป: {counts['PASS']} PASS · {counts['FAIL']} FAIL · {counts['SKIP']} SKIP")
sys.exit(1 if counts["FAIL"] else 0)
