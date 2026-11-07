import { emptyAdapter } from './empty'

// The SUPPLIER_APPLICATION approval subject (BR-DOA-26 · ADR-182): a supplier application sent under DOA
// SUPPLIER_APPROVAL. S7-02 registers the subject with the empty adapter (deciding refused VALIDATION_FAILED reason
// SUBJECT, the task stays open); S7-05 writes the real one (facts, SoD of BR-SOD ข้อ 11, approval creates the supplier).

export const supplierApplicationSubject = emptyAdapter('SUPPLIER_APPLICATION')
