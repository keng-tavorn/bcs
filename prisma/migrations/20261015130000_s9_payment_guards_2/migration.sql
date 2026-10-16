-- S9 review of the lane (origin/main...HEAD, 2026-10-15): the accounts a run pays from and into, and the change that
-- makes an account of the organization.

-- BR-PAY-01: a run is paid from an ACTIVE account of the organization (when it is created or its payer changes; the
-- pre-check of the file, BR-BANK-06, looks again before each file)
CREATE OR REPLACE FUNCTION bcs_payment_run_payer() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "BankAccount"
    WHERE "id" = NEW."payerBankAccountId" AND "organizationId" = NEW."organizationId" AND "ownerKind" = 'ORGANIZATION' AND "status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'a payment run is paid from an ACTIVE account of the organization (BR-PAY-01)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- BR-PAY-05 (ADR-133): an item is paid into an account of its own supplier, never another supplier's or the organization's
CREATE OR REPLACE FUNCTION bcs_payment_item_account() RETURNS trigger AS $$
BEGIN
  IF NEW."bankAccountId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "BankAccount"
    WHERE "id" = NEW."bankAccountId" AND "organizationId" = NEW."organizationId" AND "ownerKind" = 'SUPPLIER' AND "supplierId" = NEW."supplierId"
  ) THEN
    RAISE EXCEPTION 'an item is paid into an account of its own supplier (BR-PAY-05)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "PaymentRunItem_account_of_supplier" BEFORE INSERT OR UPDATE OF "bankAccountId", "supplierId" ON "PaymentRunItem"
  FOR EACH ROW EXECUTE FUNCTION bcs_payment_item_account();

-- An account of the organization needs its type (the sub-spec: บังคับเมื่อ ORGANIZATION); its code (CB-01) is the
-- organization's label, given when the account comes into force, so it is no longer required by the database
ALTER TABLE "BankAccount" DROP CONSTRAINT bank_account_owner;
ALTER TABLE "BankAccount" ADD CONSTRAINT bank_account_owner CHECK (
  ("ownerKind" = 'SUPPLIER') = ("supplierId" IS NOT NULL)
  AND ("ownerKind" = 'SUPPLIER' OR "accountType" IS NOT NULL)
  AND ("ownerKind" = 'ORGANIZATION' OR ("fileTemplateCode" IS NULL AND "fileParams" IS NULL)));

-- So a change that adds or replaces an account of the organization says its type, and approving it never fails on the
-- account's own CHECK (BR-SUP-06)
ALTER TABLE "BankAccountChange" ADD CONSTRAINT bank_account_change_org_type CHECK (
  "ownerKind" = 'SUPPLIER' OR "kind" = 'CLOSE' OR "accountType" IS NOT NULL);
