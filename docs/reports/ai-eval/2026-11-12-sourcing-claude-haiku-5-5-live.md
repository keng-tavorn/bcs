# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: RFX_DRAFT claude-haiku-5-5 · BID_SUMMARY claude-haiku-5-5 · NEGOTIATION_POINTS claude-haiku-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@3 · DOA_DRAFT@2 · SAVINGS_NOTE@3 · SUPPLIER_DOC_READ@3 · RFX_DRAFT@2 · BID_SUMMARY@1 · NEGOTIATION_POINTS@2

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SOURCING | RFX_DRAFT | RFX | kind | 10/10 | 0 | 100.00% | 90.00% | ผ่าน |
| SOURCING | RFX_DRAFT | RFX | head | 10/10 | 0 | 100.00% | 90.00% | ผ่าน |
| SOURCING | RFX_DRAFT | RFX | noInventedNumber | 10/10 | 0 | 100.00% | 100.00% | ผ่าน |
| SOURCING | RFX_DRAFT | RFX | descriptionEn | 26/26 | 0 | 100.00% | 90.00% | ผ่าน |
| SOURCING | RFX_DRAFT | RFX | uomEn | 26/26 | 0 | 100.00% | 90.00% | ผ่าน |
| SOURCING | BID_SUMMARY | RFX | text | 10/10 | 0 | 100.00% | 100.00% | ผ่าน |
| SOURCING | BID_SUMMARY | RFX | noDecisionAdvice | 10/10 | 0 | 100.00% | 100.00% | ผ่าน |
| SOURCING | BID_SUMMARY | RFX | flags | 10/10 | 0 | 100.00% | 95.00% | ผ่าน |
| SOURCING | NEGOTIATION_POINTS | RFX | text | 10/10 | 0 | 100.00% | 100.00% | ผ่าน |
| SOURCING | NEGOTIATION_POINTS | RFX | noDecisionAdvice | 10/10 | 0 | 100.00% | 100.00% | ผ่าน |


| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RFX_DRAFT | 10 | 1676 | 10558 | 10910 | 0 | 10 | 1.0 | 4.7 |
| BID_SUMMARY | 10 | 4602 | 27158 | 6430 | 0 | 17 | 1.7 | 10.7 |
| NEGOTIATION_POINTS | 10 | 4602 | 14605 | 7110 | 0 | 11 | 1.1 | 6.3 |
