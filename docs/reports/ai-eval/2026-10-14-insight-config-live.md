# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: QUESTION claude-sonnet-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@2 · DOA_DRAFT@2

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INSIGHT | QUESTION | QUESTION | tools | 29/30 | 0 | 96.66% | 90.00% | ผ่าน |
| INSIGHT | QUESTION | ACCESS | tools | 11/12 | 0 | 91.66% | 90.00% | ผ่าน |


| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QUESTION | 42 | 2590 | 6580 | 40221 | 981 | 102 | 2.4 | 2.3 |
