# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: RISK_ANSWER_DRAFT claude-haiku-5-5 · RISK_FILE_SUMMARY claude-haiku-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@3 · DOA_DRAFT@2 · SAVINGS_NOTE@3 · SUPPLIER_DOC_READ@3 · RFX_DRAFT@2 · BID_SUMMARY@1 · NEGOTIATION_POINTS@2 · RISK_ANSWER_DRAFT@2 · RISK_FILE_SUMMARY@2

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RISK | RISK_ANSWER_DRAFT | RISK | optionCode | 17/17 | 0 | 100.00% | 90.00% | ผ่าน |
| RISK | RISK_ANSWER_DRAFT | RISK | noFalsePositive | 103/103 | 0 | 100.00% | 95.00% | ผ่าน |
| RISK | RISK_FILE_SUMMARY | RISK | text | 7/8 | 0 | 87.50% | 100.00% | ไม่ผ่าน |
| RISK | RISK_FILE_SUMMARY | RISK | noDecisionAdvice | 8/8 | 0 | 100.00% | 100.00% | ผ่าน |
| RISK | RISK_FILE_SUMMARY | RISK | inconsistent | 46/46 | 0 | 100.00% | 90.00% | ผ่าน |


| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RISK_ANSWER_DRAFT | 10 | 25458 | 8562 | 11090 | 0 | 10 | 1.0 | 4.6 |
| RISK_FILE_SUMMARY | 8 | 18389 | 15156 | 7176 | 0 | 16 | 2.0 | 8.3 |
