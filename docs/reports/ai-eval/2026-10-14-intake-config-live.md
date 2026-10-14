# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: INTAKE claude-haiku-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@2 · DOA_DRAFT@2

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INTAKE | INTAKE | TEXT | requestType | 60/60 | 0 | 100.00% | 95.00% | ผ่าน |
| INTAKE | INTAKE | TEXT | lines | 60/60 | 0 | 100.00% | 90.00% | ผ่าน |
| INTAKE | INTAKE | WITH_QUOTATION | requestType | 10/10 | 0 | 100.00% | 95.00% | ผ่าน |
| INTAKE | INTAKE | WITH_QUOTATION | lines | 10/10 | 0 | 100.00% | 90.00% | ผ่าน |


| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INTAKE | 70 | 412372 | 23321 | 88734 | 1286 | 78 | 1.1 | 2.4 |
