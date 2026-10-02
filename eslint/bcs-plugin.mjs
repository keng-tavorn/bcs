// Project ESLint rules for BCS (spec §3 P-2/P-7, §4.10, §17.3).
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

function relFile(context) {
  return path.relative(ROOT, context.filename ?? context.getFilename()).split(path.sep).join('/')
}

function matchesAny(file, patterns = []) {
  return patterns.some((p) => path.matchesGlob(file, p))
}

// Money-shaped strings: "20,000" "20,000.00" "20000.00" "20000"
const THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/
const DECIMAL_MONEY = /^-?\d+\.\d{2}$/
const PLAIN_INT = /^-?\d{4,9}$/

function moneyLikeString(value) {
  const s = value.trim()
  if (THOUSANDS.test(s)) return true
  if (DECIMAL_MONEY.test(s) && Math.abs(Number(s)) >= 1000) return true
  if (PLAIN_INT.test(s) && Math.abs(Number(s)) >= 1000) return true
  return false
}

const noMoneyLiteral = {
  meta: {
    type: 'problem',
    docs: { description: 'ห้ามฝังตัวเลขวงเงิน (literal ≥ 1000 หรือสตริงรูปแบบจำนวนเงิน) ในโค้ด (P-2)' },
    schema: [{ type: 'object', properties: { allowFiles: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      number: 'bcs/no-money-literal: {{raw}} — วงเงินต้องมาจาก DoaVersion หรือการตั้งค่า (P-2) · ค่าคงที่ทางเทคนิคให้ย้ายไปไฟล์ค่าคงที่ที่ยกเว้นไว้',
      string: 'bcs/no-money-literal: "{{raw}}" — สตริงรูปแบบจำนวนเงินห้ามฝังในโค้ด (P-2)',
    },
  },
  create(context) {
    const file = relFile(context)
    if (matchesAny(file, context.options[0]?.allowFiles)) return {}
    return {
      Literal(node) {
        if (typeof node.value === 'number' && Math.abs(node.value) >= 1000) {
          context.report({ node, messageId: 'number', data: { raw: node.raw } })
        } else if (typeof node.value === 'bigint' && (node.value >= 1000n || node.value <= -1000n)) {
          context.report({ node, messageId: 'number', data: { raw: node.raw } })
        } else if (typeof node.value === 'string' && moneyLikeString(node.value)) {
          context.report({ node, messageId: 'string', data: { raw: node.value } })
        }
      },
      TemplateElement(node) {
        if (moneyLikeString(node.value.cooked ?? '')) {
          context.report({ node, messageId: 'string', data: { raw: node.value.cooked } })
        }
      },
    }
  },
}

const ORG_CODE_TEXT = /lk[-_ ]?rich/i
const ORG_CODE_NAME = /^(org|organi[sz]ation)(Code|Slug|Name)$/

function isOrgCodeExpression(node) {
  if (!node) return false
  if (node.type === 'Identifier') return ORG_CODE_NAME.test(node.name)
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const prop = node.property.name
    if (ORG_CODE_NAME.test(prop)) return true
    if (prop === 'code' || prop === 'slug') {
      const obj = node.object
      const objName = obj.type === 'Identifier' ? obj.name : obj.type === 'MemberExpression' && obj.property.type === 'Identifier' ? obj.property.name : ''
      return /^(org|organi[sz]ation|tenant)$/i.test(objName)
    }
  }
  return false
}

const noOrgCode = {
  meta: {
    type: 'problem',
    docs: { description: 'ห้ามเขียนเงื่อนไขหรือรหัสเฉพาะองค์กร (NG-7, P-7)' },
    schema: [],
    messages: {
      literal: 'bcs/no-org-code: พบรหัสองค์กรในโค้ด — พฤติกรรมเฉพาะองค์กรต้องอยู่ใน Organization.settings (P-7)',
      compare: 'bcs/no-org-code: ห้ามเทียบรหัสองค์กรกับค่าคงที่ — ใช้การตั้งค่าขององค์กรแทน (NG-7)',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string' && ORG_CODE_TEXT.test(node.value)) context.report({ node, messageId: 'literal' })
      },
      TemplateElement(node) {
        if (ORG_CODE_TEXT.test(node.value.cooked ?? '')) context.report({ node, messageId: 'literal' })
      },
      BinaryExpression(node) {
        if (!['===', '==', '!==', '!='].includes(node.operator)) return
        const [a, b] = [node.left, node.right]
        const lit = (n) => (n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral'
        if ((isOrgCodeExpression(a) && lit(b)) || (isOrgCodeExpression(b) && lit(a))) context.report({ node, messageId: 'compare' })
      },
      SwitchStatement(node) {
        if (isOrgCodeExpression(node.discriminant)) context.report({ node, messageId: 'compare' })
      },
    }
  },
}

const CORE_ALLOWED = [/^zod(\/.*)?$/, /^decimal\.js$/, /^date-fns(\/.*)?$/, /^@date-fns\/tz$/]

const coreImports = {
  meta: {
    type: 'problem',
    docs: { description: 'src/core import ได้เฉพาะ core และ zod decimal.js date-fns @date-fns/tz (§4.10)' },
    schema: [],
    messages: {
      denied: 'bcs/core-imports: src/core ห้าม import "{{source}}" — core ต้องไม่มี I/O และใช้ได้เฉพาะ core กับ zod decimal.js date-fns @date-fns/tz (§4.10)',
    },
  },
  create(context) {
    const file = relFile(context)
    const fileDir = path.posix.dirname(file)
    function check(node, source) {
      if (typeof source !== 'string') return
      if (CORE_ALLOWED.some((re) => re.test(source))) return
      let target = null
      if (source.startsWith('@/')) target = `src/${source.slice(2)}`
      else if (source.startsWith('.')) target = path.posix.normalize(path.posix.join(fileDir, source))
      if (target && (target === 'src/core' || target.startsWith('src/core/'))) return
      context.report({ node, messageId: 'denied', data: { source } })
    }
    return {
      ImportDeclaration(node) { check(node, node.source.value) },
      ExportNamedDeclaration(node) { if (node.source) check(node, node.source.value) },
      ExportAllDeclaration(node) { check(node, node.source.value) },
      ImportExpression(node) { if (node.source.type === 'Literal') check(node, node.source.value) },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal') check(node, node.arguments[0].value)
      },
    }
  },
}

const THAI = /[฀-๿]/

const noThaiLiteral = {
  meta: {
    type: 'problem',
    docs: { description: 'ข้อความหน้าจอต้องมาจาก next-intl (messages/) ไม่ฝังในโค้ด (NFR-I18N-01, FR-PLT-002)' },
    schema: [],
    messages: { thai: 'bcs/no-thai-literal: ข้อความภาษาไทยในโค้ดหน้าจอ — ย้ายไป messages/src/{th,en}/ แล้วใช้ useTranslations/getTranslations' },
  },
  create(context) {
    const report = (node, text) => { if (THAI.test(text)) context.report({ node, messageId: 'thai' }) }
    return {
      JSXText(node) { report(node, node.value) },
      Literal(node) { if (typeof node.value === 'string') report(node, node.value) },
      TemplateElement(node) { report(node, node.value.cooked ?? '') },
    }
  },
}

const plugin = {
  meta: { name: 'eslint-plugin-bcs', version: '1.0.0' },
  rules: {
    'no-money-literal': noMoneyLiteral,
    'no-org-code': noOrgCode,
    'core-imports': coreImports,
    'no-thai-literal': noThaiLiteral,
  },
}

export default plugin
