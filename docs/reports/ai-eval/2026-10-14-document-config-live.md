# ผลชุดประเมิน AI ชั้น demo (live)

รุ่นโมเดล: QUOTATION_READ claude-sonnet-5-5 · DELIVERY_NOTE_READ claude-sonnet-5-5 · INVOICE_READ claude-opus-5-5
รุ่น prompt: QUOTATION_READ@2 · DELIVERY_NOTE_READ@2 · INVOICE_READ@2 · INTAKE@2 · BRIEF@2 · QUESTION@2 · DOA_DRAFT@2

| agent | purpose | กลุ่ม | ฟิลด์ | ถูก/ทั้งหมด | หลุด | ความแม่น | เกณฑ์ | ผล |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DOCUMENT | QUOTATION_READ | QUOTATION | docNo | 29/29 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | docDate | 29/29 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | seller.taxId | 29/29 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | seller.branch | 29/29 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | buyer.taxId | 28/29 | 1 | 96.55% | 90.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | discountTotal | 29/29 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | net | 29/29 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | vat | 29/29 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | gross | 29/29 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | lines.*.description | 30/31 | 0 | 96.77% | 90.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | lines.*.qty | 31/31 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | lines.*.unit | 31/31 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | lines.*.unitPrice | 31/31 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | QUOTATION_READ | QUOTATION | lines.*.amount | 31/31 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | DELIVERY_NOTE_READ | DELIVERY_NOTE | docNo | 16/16 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | DELIVERY_NOTE_READ | DELIVERY_NOTE | docDate | 16/16 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | DELIVERY_NOTE_READ | DELIVERY_NOTE | seller.taxId | 16/16 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | DELIVERY_NOTE_READ | DELIVERY_NOTE | seller.branch | 16/16 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | DELIVERY_NOTE_READ | DELIVERY_NOTE | buyer.taxId | 16/16 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | DELIVERY_NOTE_READ | DELIVERY_NOTE | lines.*.description | 19/19 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | DELIVERY_NOTE_READ | DELIVERY_NOTE | lines.*.qty | 19/19 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | DELIVERY_NOTE_READ | DELIVERY_NOTE | lines.*.unit | 18/19 | 0 | 94.73% | 90.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | docNo | 23/23 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | docDate | 23/23 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | seller.taxId | 23/23 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | seller.branch | 23/23 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | buyer.taxId | 23/23 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | discountTotal | 23/23 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | net | 23/23 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | vat | 23/23 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | gross | 23/23 | 0 | 100.00% | 98.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | lines.*.description | 30/30 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | lines.*.qty | 30/30 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | lines.*.unit | 30/30 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | lines.*.unitPrice | 30/30 | 0 | 100.00% | 90.00% | ผ่าน |
| DOCUMENT | INVOICE_READ | TAX_INVOICE | lines.*.amount | 30/30 | 0 | 100.00% | 90.00% | ผ่าน |

- QUOTATION: เอกสารที่คนต้องแก้ 2/29
- DELIVERY_NOTE: เอกสารที่คนต้องแก้ 1/16
- TAX_INVOICE: เอกสารที่คนต้องแก้ 0/23

| purpose | การเรียก | input | output | cache อ่าน | cache เขียน | credits รวม | credits ต่อการเรียก | วินาทีต่อการเรียก |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QUOTATION_READ | 29 | 44351 | 23903 | 57064 | 2038 | 359 | 12.4 | 5.9 |
| DELIVERY_NOTE_READ | 16 | 22960 | 14721 | 30495 | 2033 | 213 | 13.3 | 7.3 |
| INVOICE_READ | 23 | 35010 | 18918 | 44880 | 2040 | 548 | 23.8 | 7.5 |
