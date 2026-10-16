import { upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { CONFIG_PACKAGE_SCHEMA_VERSION, configPackageFile } from '@/server/services/config-packages'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/uat-config.spec.ts against the e2e database only (S6-21 · FR-PLT-101). Nothing of the DEMO
// organization changes here:
//   rows <run>                  → a package with a valid checksum whose rows cannot resolve in DEMO: a workflow rule whose
//                                 reviewer is a position and an employee code DEMO does not have, and a catalogue item of
//                                 a supplier DEMO does not have (codes carry the run id, so nothing of DEMO matches)
//   packages                    → how many configuration packages DEMO exported and imported
//   member <sandbox code> <run> → a member of the sandbox the spec made on screen, without a role (so a password signs
//                                 in, no TOTP), as the customer's admin would invite one; prints the e-mail
// Prints JSON on the last line.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the UAT scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
if (!password) throw new Error('SEED_DEV_PASSWORD is needed')

const [mode = '', arg = '', run = ''] = process.argv.slice(2)
const demo = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })

if (mode === 'rows') {
  const id = arg.toUpperCase()
  const file = configPackageFile({
    kind: 'BCS_CONFIG_PACKAGE',
    schemaVersion: CONFIG_PACKAGE_SCHEMA_VERSION,
    organizationCode: 'DEMO-UAT',
    exportedAt: new Date().toISOString(),
    workflows: [
      {
        code: `WF-E2E-${id}`,
        rules: [
          {
            code: 'R1',
            requestTypeCodes: ['BUY_GOODS'],
            when: { all: [] },
            reviewers: [
              { kind: 'POSITION_AT', position: `NOPOS-${id}`, department: 'CON' },
              { kind: 'MEMBER', employeeCode: `nobody-${id}` },
            ],
            fallback: null,
            mode: 'ALL',
            quorumCount: null,
            slaMinutes: 480,
            descriptionTh: null,
          },
        ],
      },
    ],
    catalog: [
      {
        code: `CAT-E2E-${id}`,
        nameTh: 'รายการทดสอบ',
        nameEn: null,
        uom: 'EA',
        categoryCode: 'GENERAL',
        isService: false,
        whtIncomeType: null,
        refUnitPrice: '100.00',
        agreements: [{ supplierCode: `NOSUP-${id}`, unitPrice: '90.00', validFrom: '2026-01-01', validTo: '2027-12-31' }],
      },
    ],
  })
  console.log(JSON.stringify({ file, workflow: `WF-E2E-${id}`, position: `NOPOS-${id}@CON`, member: `nobody-${id}`, catalog: `CAT-E2E-${id}`, supplier: `NOSUP-${id}` }))
} else if (mode === 'packages') {
  const [exports, imports] = await Promise.all([
    prisma.configPackage.count({ where: { organizationId: demo.id, direction: 'EXPORT' } }),
    prisma.configPackage.count({ where: { organizationId: demo.id, direction: 'IMPORT' } }),
  ])
  console.log(JSON.stringify({ exports, imports }))
} else if (mode === 'member') {
  const sandbox = await prisma.organization.findFirstOrThrow({ where: { code: arg, kind: 'SANDBOX' }, select: { id: true } })
  const email = `uat-${run.toLowerCase()}@demo-uat.bcs.local`
  const name = 'ผู้ทดลอง ระบบทดลอง'
  const userId = await upsertUserWithPassword({ email, name, password })
  await prisma.member.create({ data: { organizationId: sandbox.id, userId, email, displayNameTh: name, status: 'ACTIVE' } })
  console.log(JSON.stringify({ email }))
} else {
  throw new Error(`unknown mode ${mode}`)
}
await prisma.$disconnect()
