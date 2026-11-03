# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: SAVINGS_NOTE claude-sonnet-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@3 · DOA_DRAFT@2 · SAVINGS_NOTE@3

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INSIGHT | SAVINGS_NOTE | SAVING | amount | 24/24 | 0 | 100.00% | 95.00% | ผ่าน |
| INSIGHT | SAVINGS_NOTE | SAVING | noDecisionAdvice | 24/24 | 0 | 100.00% | 100.00% | ผ่าน |
| INSIGHT | SAVINGS_NOTE | SAVING | text | 23/24 | 0 | 95.83% | 95.00% | ผ่าน |


| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SAVINGS_NOTE | 24 | 4127 | 5150 | 16307 | 709 | 77 | 3.2 | 3.1 |
