# ภาพอ้างอิงจาก Zip (เก็บบนเครื่องเท่านั้น)

โฟลเดอร์ `frames/` เก็บภาพที่ตัดจากวิดีโอแนะนำผลิตภัณฑ์ของ Zip ไว้ดูเป็นแนวทางเรื่องโครงหน้าและวิธีใช้ใน procure to pay

- **ภาพเหล่านี้เป็นลิขสิทธิ์ของ Zip และ repo นี้เป็น public** จึงอยู่ใน `.gitignore` ห้าม commit และห้ามนำไปใส่ในเอกสารขายหรือในผลิตภัณฑ์
- ยืมได้เฉพาะโครงหน้าและวิธีใช้ ห้ามลอกโลโก้ สี ชื่อ ภาพหน้าจอ หรือข้อความ (spec §9.9)
- สิ่งที่เรียนรู้และจะทำอะไรต่ออยู่ใน `docs/reports/zip-gap-p1.md` ซึ่งเขียนด้วยคำของเราเอง

## ตัดภาพใหม่

ไฟล์ต้นทางอยู่บนเครื่องของผู้ใช้ที่ `D:\`: วิดีโอ A = `AI Procurement Software Explainer Video _ Product DEMO Video.mp4` · B = `Procure-to-Pay automation with AI _ Zip product overview.mp4` · C = `Zip AI Automation for Procure-to-Pay- Fix the Close.mp4` · D = `Zip Superagents- Building governed AI collaborators  - The Next Build Ep. 3.mp4`

```bash
ffmpeg -ss 91 -i "D:/Zip AI Automation for Procure-to-Pay- Fix the Close.mp4" -frames:v 1 docs/reference/zip/frames/16-flow-box-approve.png
```

| ไฟล์ใน `frames/` | วิดีโอ · วินาที | เห็นอะไร |
| --- | --- | --- |
| `00-your-screenshot-canvas.png` | ภาพจากผู้ใช้ | ผังกล่องแยก 3 สาย ปุ่มอนุมัติบนกล่อง |
| `01-intake-suggested-workflows.png` | B · 27 | พิมพ์สิ่งที่อยากได้แล้วแนะนำประเภทคำขอ |
| `02-flow-fan-out.png` | B · 33 | ผังที่แยกสายแล้วมารวมกัน |
| `03-ap-inbox-from-email.png` | B · 40 | ใบแจ้งหนี้เข้ากล่องจากอีเมล |
| `04-ap-agent-what-it-did.png` | B · 47 | รายการว่า AI ทำอะไรให้ |
| `05-po-match-bar.png` | B · 50 | แถบยอดตัดกับ PO |
| `06-differs-from-usual-coding.png` | B · 56 | เตือนว่าต่างจากที่ทีมเคยลงรหัส |
| `07-bills-risk-detected.png` | B · 62 | รายการจ่ายเงินพร้อมสถานะความเสี่ยงต่อแถว |
| `08-approved-summary.png` | B · 83 | หน้าคำขอหลังอนุมัติ |
| `09-box-agent-working.png` | A · 34 | กล่องบอกว่า AI กำลังทำงาน |
| `10-agent-asks-a-choice.png` | A · 29 | AI ถามตัวเลือกก่อนทำต่อ |
| `11-agent-bulk-followups.png` | A · 47 | สั่ง AI ติดตามงานค้างทีละหลายรายการ |
| `12-action-items.png` | A · 59 | รายการงานพร้อมจำนวนที่ AI ทำให้ |
| `13-home-intake.png` | C · 81 | หน้าแรกมีช่องพิมพ์และทางลัด |
| `14-home-file-drop.png` | C · 84 | ลากไฟล์มาเริ่มคำขอ |
| `15-intake-parsed.png` | C · 87 | AI อ่านไฟล์แล้วพาไปฟอร์ม |
| `16-flow-box-approve.png` | C · 91 | ปุ่มอนุมัติบนกล่อง และลิงก์ผล AI ใต้กล่อง |
| `17-approved-next-steps.png` | C · 96 | แถบขั้นถัดไปหลังอนุมัติ |
| `18-ap-inbox-list.png` | C · 99 | รายการใบแจ้งหนี้ |
| `19-email-ai-reply.png` | C · 105 | AI ร่างคำตอบอีเมลผู้ขาย |
| `20-ap-inbox-peek.png` | C · 114 | แผงดูเร็วเมื่อกดแถว |
| `21-invoice-split-view.png` | C · 117 | ไฟล์ซ้าย ข้อมูลขวา |
| `superagents/governed-1.png` ถึง `governed-3.png` | D · ทุก 5 วินาที (16 ภาพต่อแผ่น) | งานเจรจาเป็นกล่องในผังพร้อมรายการขั้นของผู้ช่วย หน้ากลยุทธ์และทางต่อรอง ร่างอีเมลพร้อมปุ่มอนุมัติก่อนส่ง |
| `superagents/sheet-1.png` `sheet-2.png` | A · ทุก 2 วินาที (16 ภาพต่อแผ่น) | ภาพรวมวิดีโอ Superagents: แผงผู้ช่วยด้านข้าง แก้สัญญาตามคู่มือ สั่งตามงานด้วย @ รายการทักษะที่จำไว้ · ข้อเสนอของเราอยู่ใน `docs/reports/bcs-assistants.md` |
| `22-tax-check-panel.png` | C · 126 | แผงผลตรวจภาษี |
| `23-inbox-alert-peek.png` | C · 129 | แถวที่มีแจ้งเตือน |
| `24-risk-alerts.png` | C · 141 | แจ้งเตือนความเสี่ยงรวมที่เดียว |
