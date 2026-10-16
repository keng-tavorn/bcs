-- S9-01 review (spec §6.3, docs/sub-specs/S9.md "Entity และ migration"): guards the S9 tables did not have yet.

-- INV-PAY-03: a bank file is never removed. The row trigger does not fire on TRUNCATE, so the app role loses DELETE
-- and TRUNCATE (it keeps UPDATE for the two changes the trigger lets through)
REVOKE DELETE, TRUNCATE ON "PaymentFile" FROM bcs_app;

-- The snapshot of the payee's name goes into the bank file: no control character, at most 200 characters
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT payment_run_item_payee_name CHECK (
  "payeeAccountName" IS NULL OR (length("payeeAccountName") BETWEEN 1 AND 200 AND "payeeAccountName" !~ '[[:cntrl:]]'));

-- BR-PAY-01: a run is paid from an account of the organization, never from a supplier's
CREATE OR REPLACE FUNCTION bcs_payment_run_payer() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "BankAccount" WHERE "id" = NEW."payerBankAccountId" AND "organizationId" = NEW."organizationId" AND "ownerKind" = 'ORGANIZATION') THEN
    RAISE EXCEPTION 'a payment run is paid from an account of the organization (BR-PAY-01)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "PaymentRun_payer_is_organization" BEFORE INSERT OR UPDATE OF "payerBankAccountId" ON "PaymentRun"
  FOR EACH ROW EXECUTE FUNCTION bcs_payment_run_payer();

-- INV-PAY-02: a document is linked to an item of the same run, and it is a document of that item's supplier
CREATE OR REPLACE FUNCTION bcs_payment_document_item() RETURNS trigger AS $$
DECLARE
  item_run uuid;
  item_supplier uuid;
  doc_supplier uuid;
BEGIN
  SELECT "paymentRunId", "supplierId" INTO item_run, item_supplier FROM "PaymentRunItem" WHERE "id" = NEW."paymentRunItemId" AND "organizationId" = NEW."organizationId";
  IF item_run IS DISTINCT FROM NEW."paymentRunId" THEN
    RAISE EXCEPTION 'a document is linked to an item of its own run (INV-PAY-02)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT "supplierId" INTO doc_supplier FROM "Invoice" WHERE "id" = NEW."invoiceId" AND "organizationId" = NEW."organizationId";
  ELSE
    SELECT "supplierId" INTO doc_supplier FROM "Retention" WHERE "id" = NEW."retentionId" AND "organizationId" = NEW."organizationId";
  END IF;
  IF doc_supplier IS DISTINCT FROM item_supplier THEN
    RAISE EXCEPTION 'a document is paid to its own supplier (BR-PAY-04)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "PaymentRunDocument_item" BEFORE INSERT OR UPDATE OF "paymentRunId", "paymentRunItemId", "invoiceId", "retentionId" ON "PaymentRunDocument"
  FOR EACH ROW EXECUTE FUNCTION bcs_payment_document_item();
