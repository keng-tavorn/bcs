-- DropForeignKey
ALTER TABLE "Organization" DROP CONSTRAINT "Organization_id_contractSignatoryMemberId_fkey";

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_contractSignatoryMemberId_fkey" FOREIGN KEY ("contractSignatoryMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ===== Hand-written =====
-- The contract signatory (BR-DOA-19) must be a member of the same organization. A composite foreign key would make
-- Organization.id part of a relation, which stops Prisma from generating new organization ids, so a trigger checks it.
CREATE OR REPLACE FUNCTION bcs_signatory_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."contractSignatoryMemberId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Member" m WHERE m."id" = NEW."contractSignatoryMemberId" AND m."organizationId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'contract signatory must be a member of the same organization' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Organization_signatory_same_org" BEFORE INSERT OR UPDATE OF "contractSignatoryMemberId" ON "Organization"
  FOR EACH ROW EXECUTE FUNCTION bcs_signatory_same_org();
