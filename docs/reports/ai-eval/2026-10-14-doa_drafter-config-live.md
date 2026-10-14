# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: DOA_DRAFT claude-opus-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@2 · DOA_DRAFT@2

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOA_DRAFTER | DOA_DRAFT | REG-A | rules | 22/22 | 0 | 100.00% | 100.00% | ผ่าน |
| DOA_DRAFTER | DOA_DRAFT | REG-A | lint | 1/1 | 0 | 100.00% | 100.00% | ผ่าน |
| DOA_DRAFTER | DOA_DRAFT | REG-B | rules | 22/22 | 0 | 100.00% | 100.00% | ผ่าน |
| DOA_DRAFTER | DOA_DRAFT | REG-B | lint | 1/1 | 0 | 100.00% | 100.00% | ผ่าน |


| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOA_DRAFT | 2 | 11450 | 8579 | 924 | 924 | 223 | 111.5 | 30.5 |
