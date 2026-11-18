# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: RISK_FILE_SUMMARY claude-sonnet-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@3 · DOA_DRAFT@2 · SAVINGS_NOTE@3 · SUPPLIER_DOC_READ@3 · RFX_DRAFT@2 · BID_SUMMARY@1 · NEGOTIATION_POINTS@2 · RISK_ANSWER_DRAFT@2 · RISK_FILE_SUMMARY@2

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RISK | RISK_FILE_SUMMARY | RISK | text | 8/8 | 0 | 100.00% | 100.00% | ผ่าน |
| RISK | RISK_FILE_SUMMARY | RISK | noDecisionAdvice | 8/8 | 0 | 100.00% | 100.00% | ผ่าน |
| RISK | RISK_FILE_SUMMARY | RISK | inconsistent | 45/46 | 0 | 97.82% | 90.00% | ผ่าน |


| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RISK_FILE_SUMMARY | 8 | 18389 | 3424 | 7176 | 0 | 76 | 9.5 | 4.5 |
