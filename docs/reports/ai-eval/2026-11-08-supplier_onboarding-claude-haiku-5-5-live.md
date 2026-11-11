# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: SUPPLIER_DOC_READ claude-haiku-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@3 · DOA_DRAFT@2 · SAVINGS_NOTE@3 · SUPPLIER_DOC_READ@3

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | COMPANY_CERT | taxId | 6/7 | 0 | 85.71% | 98.00% | ไม่ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | COMPANY_CERT | branchCode | 7/7 | 0 | 100.00% | 98.00% | ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | COMPANY_CERT | nameTh | 7/7 | 0 | 100.00% | 95.00% | ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | COMPANY_CERT | issuedOn | 7/7 | 0 | 100.00% | 95.00% | ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | COMPANY_CERT | registeredAddress | 7/7 | 0 | 100.00% | 90.00% | ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | VAT_CERT | taxId | 5/5 | 0 | 100.00% | 98.00% | ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | VAT_CERT | branchCode | 5/5 | 0 | 100.00% | 98.00% | ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | VAT_CERT | nameTh | 5/5 | 0 | 100.00% | 95.00% | ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | VAT_CERT | issuedOn | 5/5 | 0 | 100.00% | 95.00% | ผ่าน |
| SUPPLIER_ONBOARDING | SUPPLIER_DOC_READ | VAT_CERT | registeredAddress | 5/5 | 0 | 100.00% | 90.00% | ผ่าน |

- COMPANY_CERT: เอกสารที่คนต้องแก้ 1/7
- VAT_CERT: เอกสารที่คนต้องแก้ 0/5

| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SUPPLIER_DOC_READ | 12 | 18572 | 14030 | 19217 | 1747 | 13 | 1.1 | 5.1 |
