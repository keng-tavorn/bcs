# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: BRIEF claude-haiku-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@2 · DOA_DRAFT@2

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| APPROVAL_BRIEF | BRIEF | TASK | flags | 29/30 | 0 | 96.66% | 95.00% | ผ่าน |
| APPROVAL_BRIEF | BRIEF | TASK | noDecisionAdvice | 30/30 | 0 | 100.00% | 100.00% | ผ่าน |
| APPROVAL_BRIEF | BRIEF | TASK | text | 30/30 | 0 | 100.00% | 95.00% | ผ่าน |


| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BRIEF | 30 | 4223 | 5654 | 15631 | 539 | 30 | 1.0 | 2.1 |
