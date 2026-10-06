import { TZDate } from '@date-fns/tz'
import { format } from 'date-fns'
import { parse as parseYaml, stringify } from 'yaml'
import { z } from 'zod'
import { DOA_DOCUMENT_TYPES, type ApproverSpec, type DoaRuleSnapshot } from '@/core/doa'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { versionSnapshotFromRows, type DoaRuleRow, type DoaVersionRow } from './snapshot'

// DOA as YAML (spec §7.4, FR-DOA-001 AC2): the same shape as tests/golden/fixtures/doa-versions.yaml, so a customer's
// DOA can be imported and exported, and an import exported again gives the same data (round trip). Money is a baht
// string with 2 decimals (§7.0 item 3); times carry an offset; a MEMBER approver is written with the member's code
// (employeeCode) and becomes its id on import. Parsing lives outside src/core: the engine only sees snapshots.

const MINUTES_PER_HOUR = 60
const THAI_TIME = 'Asia/Bangkok'

const Baht = z.string().regex(/^\d{1,13}\.\d{2}$/, 'baht as a string with 2 decimals, e.g. "20000.00"')
const Instant = z.iso.datetime({ offset: true })
const Code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/)

const RuleYaml = z.strictObject({
  code: Code,
  documentType: z.enum(DOA_DOCUMENT_TYPES),
  priority: z.number().int(),
  when: z.strictObject({ amount: z.strictObject({ gt: Baht.optional(), gte: Baht.optional(), lte: Baht.optional() }).optional() }),
  approver: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('POSITION_OF_DEPARTMENT'), position: Code }),
    z.strictObject({ kind: z.literal('POSITION_OF_ORG'), position: Code }),
    z.strictObject({ kind: z.literal('MEMBER'), member: z.string().min(1) }),
  ]),
  slaBusinessHours: z.number().int().positive(),
})

const VersionYaml = z.strictObject({
  code: Code,
  version: z.number().int().positive(),
  effectiveFrom: Instant,
  amountBasis: z.enum(['GROSS', 'NET']),
  selfApprovalPolicy: z.enum(['ESCALATE_NEXT_BAND', 'BLOCK']),
  collapseDuplicateApprovers: z.boolean(),
  stepUpThreshold: Baht.nullable().optional(),
  sodPolicy: z.strictObject({ approverMayReceive: z.boolean(), requesterMayReceive: z.boolean() }),
  rules: z.array(RuleYaml).min(1),
})

const DoaYamlFile = z.strictObject({ versions: z.array(VersionYaml).min(1) })

/** One DOA version as data: the fields of a DoaVersion row and its rules as engine snapshots. */
export interface DoaVersionData {
  readonly code: string
  readonly versionNo: number
  readonly effectiveFrom: Date
  readonly amountBasis: 'GROSS' | 'NET'
  readonly selfApprovalPolicy: 'ESCALATE_NEXT_BAND' | 'BLOCK'
  readonly collapseDuplicateApprovers: boolean
  readonly stepUpThresholdSatang: bigint | null
  readonly sodPolicy: { readonly approverMayReceive: boolean; readonly requesterMayReceive: boolean }
  readonly rules: readonly DoaRuleSnapshot[]
}

/** What kind of problem: NOT_YAML, UNKNOWN_MEMBER, DUPLICATE_RULE, MISSING (a required key), or the Zod issue code */
export type YamlIssue = 'NOT_YAML' | 'UNKNOWN_MEMBER' | 'DUPLICATE_RULE' | 'MISSING' | (string & {})

export interface YamlProblem {
  /** Where in the file, e.g. versions.0.rules.2.approver.member */
  readonly path: string
  readonly message: string
  /** Lets a screen say what to fix in the reader's language; `message` stays a developer text */
  readonly issue: YamlIssue
  /** Keys that do not belong at `path` (issue unrecognized_keys) */
  readonly keys?: readonly string[]
}

/**
 * Reads a DOA YAML file. `memberIds` maps member codes to member ids of the organization; an unknown member code, a
 * rule code used twice in a version or any shape error is a VALIDATION_FAILED listing every problem with its path.
 */
export function parseDoaYaml(text: string, memberIds: ReadonlyMap<string, string>): Result<DoaVersionData[]> {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    return err('VALIDATION_FAILED', 'not a YAML file', { problems: [{ path: '', message: (error as Error).message.split('\n')[0], issue: 'NOT_YAML' }] })
  }
  const parsed = DoaYamlFile.safeParse(raw)
  if (!parsed.success) {
    const problems: YamlProblem[] = parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      // A required key that is not there is said as such; any other issue keeps Zod's code
      issue: i.code === 'invalid_type' && /received undefined$/.test(i.message) ? 'MISSING' : i.code,
      ...(i.code === 'unrecognized_keys' ? { keys: i.keys } : {}),
    }))
    return err('VALIDATION_FAILED', 'the DOA file does not have the expected shape', { problems })
  }
  const problems: YamlProblem[] = []
  const versions = parsed.data.versions.map((v, vi): DoaVersionData => {
    const codes = new Set<string>()
    const rules = v.rules.map((r, ri): DoaRuleSnapshot => {
      if (codes.has(r.code)) problems.push({ path: `versions.${vi}.rules.${ri}.code`, message: `rule code ${r.code} is used twice`, issue: 'DUPLICATE_RULE' })
      codes.add(r.code)
      let approver: ApproverSpec
      if (r.approver.kind === 'MEMBER') {
        const memberId = memberIds.get(r.approver.member)
        if (!memberId) problems.push({ path: `versions.${vi}.rules.${ri}.approver.member`, message: `no member with code ${r.approver.member}`, issue: 'UNKNOWN_MEMBER' })
        approver = { kind: 'MEMBER', memberId: memberId ?? '' }
      } else {
        approver = { kind: r.approver.kind, position: r.approver.position }
      }
      const amount = r.when.amount
      return {
        code: r.code,
        documentType: r.documentType,
        priority: r.priority,
        when: amount
          ? {
              amount: {
                ...(amount.gt !== undefined ? { gt: amountToSatang(amount.gt) } : {}),
                ...(amount.gte !== undefined ? { gte: amountToSatang(amount.gte) } : {}),
                ...(amount.lte !== undefined ? { lte: amountToSatang(amount.lte) } : {}),
              },
            }
          : {},
        steps: [{ approver, slaBusinessMinutes: r.slaBusinessHours * MINUTES_PER_HOUR, mode: 'SEQUENTIAL' }],
      }
    })
    return {
      code: v.code,
      versionNo: v.version,
      effectiveFrom: new Date(v.effectiveFrom),
      amountBasis: v.amountBasis,
      selfApprovalPolicy: v.selfApprovalPolicy,
      collapseDuplicateApprovers: v.collapseDuplicateApprovers,
      stepUpThresholdSatang: v.stepUpThreshold ? amountToSatang(v.stepUpThreshold) : null,
      sodPolicy: { ...v.sodPolicy },
      rules,
    }
  })
  return problems.length ? err('VALIDATION_FAILED', 'the DOA file refers to things that do not exist', { problems }) : ok(versions)
}

/**
 * Writes DOA versions as YAML in the fixture's shape. `memberCodes` maps member ids back to their codes. Rules with
 * more than one step are not expressible in this shape (tier 1 has one approver per rule) and are refused.
 */
export function doaYaml(versions: readonly DoaVersionData[], memberCodes: ReadonlyMap<string, string>): string {
  const doc = {
    versions: versions.map((v) => ({
      code: v.code,
      version: v.versionNo,
      effectiveFrom: format(new TZDate(v.effectiveFrom.getTime(), THAI_TIME), "yyyy-MM-dd'T'HH:mm:ssxxx"),
      amountBasis: v.amountBasis,
      selfApprovalPolicy: v.selfApprovalPolicy,
      collapseDuplicateApprovers: v.collapseDuplicateApprovers,
      stepUpThreshold: v.stepUpThresholdSatang === null ? null : satangToAmount(v.stepUpThresholdSatang),
      sodPolicy: { approverMayReceive: v.sodPolicy.approverMayReceive, requesterMayReceive: v.sodPolicy.requesterMayReceive },
      rules: v.rules.map((r) => {
        if (r.steps.length !== 1) throw new RangeError(`rule ${r.code} has ${r.steps.length} steps; the YAML shape holds one approver per rule`)
        const step = r.steps[0]!
        const amount = r.when.amount
        return {
          code: r.code,
          documentType: r.documentType,
          priority: r.priority,
          when: amount
            ? {
                amount: {
                  ...(amount.gt !== undefined ? { gt: satangToAmount(amount.gt) } : {}),
                  ...(amount.gte !== undefined ? { gte: satangToAmount(amount.gte) } : {}),
                  ...(amount.lte !== undefined ? { lte: satangToAmount(amount.lte) } : {}),
                },
              }
            : {},
          approver:
            step.approver.kind === 'MEMBER'
              ? { kind: 'MEMBER', member: memberCodes.get(step.approver.memberId) ?? step.approver.memberId }
              : { kind: step.approver.kind, position: step.approver.position },
          slaBusinessHours: step.slaBusinessMinutes / MINUTES_PER_HOUR,
        }
      }),
    })),
  }
  return stringify(doc, { lineWidth: 0 })
}

const StoredSodPolicy = z.object({ approverMayReceive: z.boolean(), requesterMayReceive: z.boolean() })

/** A stored version (DoaVersion row with its policy columns, and its DoaRule rows) as YAML data, for export. */
export function doaVersionDataFromRows(
  version: DoaVersionRow & { readonly stepUpThresholdSatang: bigint | null; readonly sodPolicy: unknown },
  rules: readonly DoaRuleRow[],
): DoaVersionData {
  const snapshot = versionSnapshotFromRows(version, rules)
  const sod = StoredSodPolicy.parse(version.sodPolicy)
  return {
    code: snapshot.code,
    versionNo: snapshot.versionNo,
    effectiveFrom: snapshot.effectiveFrom,
    amountBasis: snapshot.amountBasis,
    selfApprovalPolicy: snapshot.selfApprovalPolicy,
    collapseDuplicateApprovers: snapshot.collapseDuplicateApprovers,
    stepUpThresholdSatang: version.stepUpThresholdSatang,
    sodPolicy: { approverMayReceive: sod.approverMayReceive, requesterMayReceive: sod.requesterMayReceive },
    rules: snapshot.rules,
  }
}
