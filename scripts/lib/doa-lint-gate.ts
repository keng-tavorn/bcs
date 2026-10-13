// pnpm verify, db gate (spec §15.5 item 5, BR-DOA-08): every DOA version that was seeded or published is linted with
// the full rule set of the engine (src/core/doa). A version in effect is linted now; a superseded one at the moment it
// took effect, against the organization structure of that moment. A published version is linted with the modules the
// organization has on now (BR-DOA-23, FR-DOA-002 AC7); a superseded one without modules, as it was right when it was
// in effect (INV-DOA-03), so switching PAY on later never fails an old version. Errors fail the gate; warnings (a
// vacant position, a named member as approver) are listed by the admin screen, not here.
import pg from 'pg'
import { lintDoaVersion, type LintIssue } from '../../src/core/doa'
import { orgSnapshotFromRows, versionSnapshotFromRows, type DoaRuleRow, type DoaVersionRow, type OrgRows } from '../../src/server/doa/snapshot'

const LINTED_STATUSES = ['PUBLISHED', 'SUPERSEDED']

const baht = (satang: bigint) => `${satang / 100n}.${String(satang % 100n).padStart(2, '0')}`

function describeIssue(issue: LintIssue): string {
  const band = issue.gt !== undefined ? ` ช่วง (${baht(issue.gt)}, ${issue.lte === null || issue.lte === undefined ? '∞' : baht(issue.lte)}]` : ''
  return [issue.code, issue.documentType, issue.rule ? `ข้อ ${issue.rule}` : undefined].filter(Boolean).join(' ') + band
}

async function orgRows(client: pg.Client, organizationId: string): Promise<OrgRows> {
  const departments = await client.query<{ id: string; code: string; nameTh: string; parentId: string | null }>(
    'select "id", "code", "nameTh", "parentId" from "Department" where "organizationId" = $1',
    [organizationId],
  )
  const holders = await client.query<{ positionCode: string; departmentId: string; memberId: string; validFrom: Date; validTo: Date | null }>(
    `select p."code" as "positionCode", a."departmentId", a."memberId", a."validFrom", a."validTo"
       from "PositionAssignment" a join "Position" p on p."id" = a."positionId" and p."organizationId" = a."organizationId"
      where a."organizationId" = $1`,
    [organizationId],
  )
  const members = await client.query<{ id: string; displayNameTh: string; status: string }>(
    'select "id", "displayNameTh", "status"::text as "status" from "Member" where "organizationId" = $1',
    [organizationId],
  )
  return { departments: departments.rows, holders: holders.rows, members: members.rows }
}

/** The modules each organization has switched on (CORE is implied and makes nothing required). */
async function enabledModulesByOrg(client: pg.Client): Promise<Map<string, string[]>> {
  const rows = await client.query<{ organizationId: string; module: string }>('select "organizationId", "module"::text as "module" from "OrgModule" where "enabled"')
  const byOrg = new Map<string, string[]>()
  for (const r of rows.rows) byOrg.set(r.organizationId, [...(byOrg.get(r.organizationId) ?? []), r.module])
  return byOrg
}

/** Lints every seeded or published DOA version in the database behind `verifyDatabaseUrl`. */
export async function lintSeededAndPublishedDoa(opts: { verifyDatabaseUrl: string; now?: Date }): Promise<{ checked: number; problems: string[] }> {
  const now = opts.now ?? new Date()
  const client = new pg.Client({ connectionString: opts.verifyDatabaseUrl })
  await client.connect()
  try {
    const versions = await client.query<DoaVersionRow & { organizationId: string; orgCode: string }>(
      `select v."id", v."organizationId", o."code" as "orgCode", v."code", v."versionNo", v."status"::text as "status", v."effectiveFrom",
              v."effectiveTo", v."amountBasis"::text as "amountBasis", v."selfApprovalPolicy"::text as "selfApprovalPolicy",
              v."collapseDuplicateApprovers"
         from "DoaVersion" v join "Organization" o on o."id" = v."organizationId"
        where v."status"::text = any($1) order by o."code", v."code", v."versionNo"`,
      [LINTED_STATUSES],
    )
    const problems: string[] = []
    const orgs = new Map<string, OrgRows>()
    const modules = await enabledModulesByOrg(client)
    for (const v of versions.rows) {
      const where = `DOA ${v.code} ฉบับ ${v.versionNo} ขององค์กร ${v.orgCode}`
      const rules = await client.query<DoaRuleRow>(
        `select "code", "documentType"::text as "documentType", "priority", "when", "steps", "descriptionTh"
           from "DoaRule" where "organizationId" = $1 and "doaVersionId" = $2 order by "code"`,
        [v.organizationId, v.id],
      )
      if (!orgs.has(v.organizationId)) orgs.set(v.organizationId, await orgRows(client, v.organizationId))
      try {
        const snapshot = versionSnapshotFromRows(v, rules.rows)
        const at = v.status === 'PUBLISHED' && v.effectiveFrom < now ? now : v.effectiveFrom
        const options = v.status === 'PUBLISHED' ? { modules: modules.get(v.organizationId) ?? [] } : {}
        const { errors } = lintDoaVersion(snapshot, orgSnapshotFromRows(orgs.get(v.organizationId)!), at, options)
        for (const issue of errors) problems.push(`${where}: ${describeIssue(issue)}`)
      } catch (error) {
        problems.push(`${where}: อ่านข้อกำหนดไม่ได้ (${(error as Error).message})`)
      }
    }
    return { checked: versions.rows.length, problems }
  } finally {
    await client.end()
  }
}
