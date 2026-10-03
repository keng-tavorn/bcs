// Project ESLint rules for BCS (spec §3 P-2/P-7, §4.2, §4.8, §4.10, §17.3).
// Every rule here is a custom rule with its own id, so flat-config blocks never replace each other's options.
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

function relFile(context) {
  return path.relative(ROOT, context.filename ?? context.getFilename()).split(path.sep).join('/')
}

function matchesAny(file, patterns = []) {
  return patterns.some((p) => path.posix.matchesGlob(file, p))
}

const WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
  'ChainExpression',
])

function unwrap(node) {
  let n = node
  while (n && WRAPPERS.has(n.type)) n = n.expression
  return n
}

/** Value of a string literal or of a template literal without expressions, else null. */
function staticString(node) {
  const n = unwrap(node)
  if (!n) return null
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value.cooked ?? null
  return null
}

/** Static property name of a MemberExpression (`a.b`, `a['b']`), else null. */
function propertyName(member) {
  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null
  return staticString(member.property)
}

function resolveVariable(context, identifier) {
  let scope = context.sourceCode.getScope(identifier)
  while (scope) {
    const variable = scope.set.get(identifier.name)
    if (variable) return variable
    scope = scope.upper
  }
  return null
}

/** True when the identifier refers to a global (not declared anywhere in the file). */
function isGlobal(context, identifier) {
  const variable = resolveVariable(context, identifier)
  return !variable || variable.defs.length === 0
}

/** Calls `visit(n)` for `node` and every node under it; when `visit` returns false the children of `n` are skipped. */
function walk(sourceCode, node, visit) {
  const stack = [node]
  while (stack.length) {
    const n = stack.pop()
    if (!n || typeof n.type !== 'string' || visit(n) === false) continue
    for (const key of sourceCode.visitorKeys[n.type] ?? []) {
      const child = n[key]
      if (Array.isArray(child)) stack.push(...child)
      else if (child) stack.push(child)
    }
  }
}

/** The `const` variable an identifier names, when it has a single declaration with an initializer; else null. */
function constVariable(context, identifier) {
  const variable = resolveVariable(context, identifier)
  const def = variable?.defs.length === 1 ? variable.defs[0] : null
  if (def?.type !== 'Variable' || def.parent?.kind !== 'const' || def.node.id.type !== 'Identifier' || !def.node.init) return null
  return variable
}

/**
 * Value of a string the code builds only from literals: templates and `+` of such strings, `.concat()`, `[…].join()`,
 * and `const` names bound to them. Null when any part is computed at run time.
 */
function constString(context, node, depth = 0) {
  const n = unwrap(node)
  if (!n || depth > 8) return null
  if (n.type === 'Literal') return typeof n.value === 'string' ? n.value : null
  if (n.type === 'TemplateLiteral') {
    let s = n.quasis[0]?.value.cooked ?? ''
    for (let i = 0; i < n.expressions.length; i++) {
      const part = constString(context, n.expressions[i], depth + 1)
      if (part === null) return null
      s += part + (n.quasis[i + 1]?.value.cooked ?? '')
    }
    return s
  }
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const a = constString(context, n.left, depth + 1)
    const b = a === null ? null : constString(context, n.right, depth + 1)
    return b === null ? null : a + b
  }
  if (n.type === 'Identifier') {
    const variable = constVariable(context, n)
    return variable ? constString(context, variable.defs[0].node.init, depth + 1) : null
  }
  if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression') {
    const method = propertyName(n.callee)
    if (method === 'concat') {
      const parts = [n.callee.object, ...n.arguments].map((a) => constString(context, a, depth + 1))
      return parts.includes(null) ? null : parts.join('')
    }
    const list = unwrap(n.callee.object)
    if (method === 'join' && list?.type === 'ArrayExpression') {
      const parts = list.elements.map((e) => (e ? constString(context, e, depth + 1) : null))
      const separator = n.arguments.length ? constString(context, n.arguments[0], depth + 1) : ','
      return parts.includes(null) || separator === null ? null : parts.join(separator)
    }
  }
  return null
}

/** Name of a member (`a.b`, `a['b']`, `a[k]` with `const k = 'b'`, `a['x' + 'y']`), else null. */
function memberName(context, member) {
  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null
  return constString(context, member.property)
}

/** Key of a destructuring or object property (`{ a }`, `{ 'a': x }`, `{ [k]: x }` with a constant k), else null. */
function keyName(context, property) {
  if (!property.computed && property.key.type === 'Identifier') return property.key.name
  return constString(context, property.key)
}

/** The identifier at the root of a member chain (`globalThis` in `globalThis.a.b`), through calls too when `throughCalls`. */
function rootIdentifier(node, throughCalls = false) {
  let n = unwrap(node)
  while (n && (n.type === 'MemberExpression' || (throughCalls && n.type === 'CallExpression'))) n = unwrap(n.type === 'MemberExpression' ? n.object : n.callee)
  return n?.type === 'Identifier' ? n : null
}

/** Repo-relative target of a relative or `@/` import, without extension or trailing /index; null for packages. */
function resolveImport(fileRel, source) {
  let target = null
  if (source.startsWith('@/')) target = `src/${source.slice(2)}`
  else if (source === '.' || source === '..' || source.startsWith('./') || source.startsWith('../')) {
    target = path.posix.join(path.posix.dirname(fileRel), source)
  }
  if (target === null) return null
  return path.posix.normalize(target).replace(/\.(d\.)?[cm]?[jt]sx?$/, '').replace(/\/index$/, '')
}

/** `require(x)` or CommonJS `module.require(x)`. */
function isRequireCall(context, node) {
  const callee = unwrap(node.callee)
  if (callee?.type === 'Identifier') return callee.name === 'require'
  return callee?.type === 'MemberExpression' && propertyName(callee) === 'require' && callee.object.type === 'Identifier' && callee.object.name === 'module' && isGlobal(context, callee.object)
}

/**
 * Calls `check(node, source)` for every module reference whose name is a constant (also `import(name)` with
 * `const name = '…'`), and `onDynamic(node, sourceNode)` for import()/require() of a name computed at run time.
 */
function moduleVisitors(context, check, onDynamic) {
  const reference = (node, sourceNode) => {
    const source = constString(context, sourceNode)
    if (source !== null) check(node, source)
    else onDynamic?.(node, sourceNode)
  }
  return {
    ImportDeclaration(node) {
      check(node, node.source.value)
    },
    ExportNamedDeclaration(node) {
      if (node.source) check(node, node.source.value)
    },
    ExportAllDeclaration(node) {
      check(node, node.source.value)
    },
    TSImportEqualsDeclaration(node) {
      const ref = node.moduleReference
      if (ref.type === 'TSExternalModuleReference') reference(node, ref.expression)
    },
    ImportExpression(node) {
      reference(node, node.source)
    },
    CallExpression(node) {
      if (isRequireCall(context, node)) reference(node, node.arguments[0])
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// bcs/no-money-literal — approval limits and money amounts never live in code (P-2)
// ---------------------------------------------------------------------------------------------------------------

const THOUSANDS = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/
const DECIMAL_MONEY = /^[-+]?\d+\.\d{2}$/
const PLAIN_INT = /^[-+]?\d{4,15}$/
const CURRENCY_PREFIX = /^(?:฿|THB|USD|\$)\s*/i
const CURRENCY_SUFFIX = /\s*(?:฿|บาท|THB|USD)$/i
const EMBEDDED_THOUSANDS = /(^|[^\d.,])\d{1,3}(,\d{3})+(\.\d+)?(?![\d,])/
const CURRENCY_BEFORE = /(?:฿|\bTHB|\bUSD|\$)\s*(\d[\d,]*(?:\.\d+)?)/gi
const CURRENCY_AFTER = /(\d[\d,]*(?:\.\d+)?)\s*(?:฿|บาท|THB\b|USD\b)/gi

const atLeastThousand = (digits) => Math.abs(Number(digits.replace(/,/g, ''))) >= 1000

function bareMoney(s) {
  if (THOUSANDS.test(s)) return true
  if (DECIMAL_MONEY.test(s) && atLeastThousand(s)) return true
  if (PLAIN_INT.test(s) && atLeastThousand(s)) return true
  return false
}

export function moneyLikeString(value) {
  const s = value.trim()
  if (!s) return false
  if (bareMoney(s.replace(CURRENCY_PREFIX, '').replace(CURRENCY_SUFFIX, '').trim())) return true
  if (EMBEDDED_THOUSANDS.test(s)) return true
  for (const re of [CURRENCY_BEFORE, CURRENCY_AFTER]) {
    for (const m of s.matchAll(re)) if (atLeastThousand(m[1])) return true
  }
  return false
}

const FOLDABLE = new Set(['+', '-', '*', '/', '%', '**', '<<'])

function numericLeaf(node) {
  const n = unwrap(node)
  if (!n) return null
  if (n.type === 'Literal' && (typeof n.value === 'number' || typeof n.value === 'bigint')) return n.value
  if (n.type === 'UnaryExpression' && n.operator === '-') {
    const v = numericLeaf(n.argument)
    return v === null ? null : -v
  }
  return null
}

/** Constant value of an arithmetic expression made only of numeric literals (`2n * 10n ** 4n`), else null. */
function foldNumeric(node) {
  const leaf = numericLeaf(node)
  if (leaf !== null) return leaf
  node = unwrap(node)
  if (node?.type !== 'BinaryExpression' || !FOLDABLE.has(node.operator)) return null
  const a = foldNumeric(node.left)
  const b = foldNumeric(node.right)
  if (a === null || b === null || typeof a !== typeof b) return null
  try {
    switch (node.operator) {
      case '+': return a + b
      case '-': return a - b
      case '*': return a * b
      case '/': return a / b
      case '%': return a % b
      case '**': return a ** b
      case '<<': return a << b
    }
  } catch {
    return null
  }
  return null
}

const bigEnough = (v) => (typeof v === 'bigint' ? v >= 1000n || v <= -1000n : Number.isFinite(v) && Math.abs(v) >= 1000)

const noMoneyLiteral = {
  meta: {
    type: 'problem',
    docs: { description: 'ห้ามฝังตัวเลขวงเงิน (literal ≥ 1000 หรือสตริงรูปแบบจำนวนเงิน) ในโค้ด (P-2)' },
    schema: [{ type: 'object', properties: { allowFiles: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      number:
        'bcs/no-money-literal: {{raw}} — วงเงินต้องมาจาก DoaVersion หรือการตั้งค่า (P-2) · ค่าคงที่ทางเทคนิคให้ย้ายไป src/lib/constants.ts (โค้ดใน src/core ใช้ src/core/money/constants.ts)',
      string: 'bcs/no-money-literal: "{{raw}}" — สตริงรูปแบบจำนวนเงินห้ามฝังในโค้ด (P-2)',
    },
  },
  create(context) {
    if (matchesAny(relFile(context), context.options[0]?.allowFiles)) return {}
    const reportString = (node, text) => {
      if (moneyLikeString(text)) context.report({ node, messageId: 'string', data: { raw: text.trim().slice(0, 40) } })
    }
    return {
      Literal(node) {
        if (bigEnough(typeof node.value === 'number' || typeof node.value === 'bigint' ? node.value : 0)) {
          context.report({ node, messageId: 'number', data: { raw: node.raw } })
        } else if (typeof node.value === 'string') reportString(node, node.value)
      },
      TemplateElement(node) {
        reportString(node, node.value.cooked ?? '')
      },
      JSXText(node) {
        reportString(node, node.value)
      },
      BinaryExpression(node) {
        // Report only the outermost foldable expression, once
        let parent = node.parent
        while (parent && WRAPPERS.has(parent.type)) parent = parent.parent
        if (parent?.type === 'BinaryExpression' && foldNumeric(parent) !== null) return
        const leaves = []
        const collect = (n) => {
          const u = unwrap(n)
          if (u?.type === 'BinaryExpression') {
            collect(u.left)
            collect(u.right)
          } else leaves.push(numericLeaf(u))
        }
        collect(node)
        if (leaves.some((v) => v !== null && bigEnough(v))) return
        const value = foldNumeric(node)
        if (value !== null && bigEnough(value)) {
          context.report({ node, messageId: 'number', data: { raw: context.sourceCode.getText(node) } })
        }
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------------------------
// bcs/no-org-code — no organization-specific branches or lookup tables (NG-7, P-7)
// ---------------------------------------------------------------------------------------------------------------

const ORG_CODE_TEXT = /lk[-_ ]?rich/i
const ORG_ID_NAME = /^(org|organi[sz]ation|tenant)(Code|Slug|Name|Id|Key)$/
const ORG_OBJECT = /^(org|organi[sz]ation|tenant)$/i
const ORG_FIELDS = new Set(['code', 'slug', 'id', 'name', 'key'])
const LOOKUP_METHODS = new Set(['includes', 'indexOf', 'lastIndexOf', 'has', 'get'])
const STRING_METHODS = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'search', 'localeCompare'])

/** `orgCode`, `ctx.organizationId`, `org.code`, `member.organization.id` … */
function isOrgIdentity(node) {
  const n = unwrap(node)
  if (!n) return false
  if (n.type === 'Identifier') return ORG_ID_NAME.test(n.name)
  if (n.type !== 'MemberExpression') return false
  const prop = propertyName(n)
  if (!prop) return false
  if (ORG_ID_NAME.test(prop)) return true
  if (!ORG_FIELDS.has(prop)) return false
  const obj = unwrap(n.object)
  const objName = obj?.type === 'Identifier' ? obj.name : obj?.type === 'MemberExpression' ? propertyName(obj) : null
  return objName !== null && ORG_OBJECT.test(objName)
}

const isConstantText = (node) => {
  const n = unwrap(node)
  if (n?.type === 'TemplateLiteral') return true
  if (n?.type === 'Literal' && n.regex) return true
  const s = staticString(n)
  return s !== null && s !== ''
}

const NAMES_TEXT = /[\p{L}\p{N}]/u

/**
 * True when a regular expression spells out text — letters or digits outside character classes, escapes, counts and
 * group names, as in /^ACME/ — rather than describing a format such as /^[A-Z0-9-]{2,20}$/.
 */
export function regexNamesText(pattern) {
  const literal = pattern
    .replace(/\[(?:\\.|[^\]\\])*\]/g, '')
    .replace(/\(\?<[A-Za-z_$][\w$]*>/g, '(')
    .replace(/\\k<[^>]*>/g, '')
    .replace(/\\[pP]\{[^}]*\}/g, '')
    .replace(/\\u\{[0-9A-Fa-f]+\}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|\\c[A-Za-z]/g, '')
    .replace(/\\./g, '')
    .replace(/\{\d*,?\d*\}/g, '')
  return NAMES_TEXT.test(literal)
}

/** Pattern of a regular expression written in code: /…/, new RegExp('…') or a const bound to one; else null. */
function regexPattern(context, node, depth = 0) {
  const n = unwrap(node)
  if (!n || depth > 4) return null
  if (n.type === 'Literal' && n.regex) return n.regex.pattern
  if ((n.type === 'NewExpression' || n.type === 'CallExpression') && n.callee.type === 'Identifier' && n.callee.name === 'RegExp' && isGlobal(context, n.callee)) {
    return n.arguments.length ? constString(context, n.arguments[0]) : null
  }
  if (n.type === 'Identifier') {
    const variable = constVariable(context, n)
    return variable ? regexPattern(context, variable.defs[0].node.init, depth + 1) : null
  }
  return null
}

/** An argument of a string or regex test that names specific text (an organization), not a format: 'ACME', /^ACME/ … */
function namesText(context, node) {
  const pattern = regexPattern(context, node)
  if (pattern !== null) return regexNamesText(pattern)
  const n = unwrap(node)
  if (n?.type === 'TemplateLiteral' && n.expressions.length) return true
  const s = constString(context, n)
  return s !== null && NAMES_TEXT.test(s)
}

/** An inline or `const` collection of literals: ['A', 'B'], new Set([...]), new Map([['A', x]]), { A: … }. */
function isStaticCollection(context, node, depth = 0) {
  const n = unwrap(node)
  if (!n || depth > 4) return false
  if (n.type === 'ArrayExpression') {
    return n.elements.some((e) => {
      const el = unwrap(e)
      return staticString(el) !== null || (el?.type === 'ArrayExpression' && staticString(el.elements[0]) !== null)
    })
  }
  if (n.type === 'ObjectExpression') return n.properties.length > 0
  if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && ['Set', 'Map'].includes(n.callee.name)) {
    return n.arguments.length > 0 && isStaticCollection(context, n.arguments[0], depth + 1)
  }
  if (n.type === 'Identifier') {
    const def = resolveVariable(context, n)?.defs.at(-1)
    if (def?.type === 'Variable' && def.node.init) return isStaticCollection(context, def.node.init, depth + 1)
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
      compare: 'bcs/no-org-code: ห้ามเทียบรหัสหรือ id ขององค์กรกับค่าคงที่ — ใช้การตั้งค่าขององค์กรแทน (NG-7)',
      lookup: 'bcs/no-org-code: ห้ามเลือกพฤติกรรมจากรายการองค์กรที่เขียนในโค้ด — ใช้ Organization.settings แทน (NG-7)',
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
        const [a, b] = [node.left, node.right]
        if (['===', '==', '!==', '!='].includes(node.operator)) {
          if ((isOrgIdentity(a) && isConstantText(b)) || (isOrgIdentity(b) && isConstantText(a))) context.report({ node, messageId: 'compare' })
        } else if (node.operator === 'in' && isOrgIdentity(a) && isStaticCollection(context, b)) {
          context.report({ node, messageId: 'lookup' })
        }
      },
      SwitchStatement(node) {
        if (isOrgIdentity(node.discriminant)) context.report({ node, messageId: 'compare' })
      },
      CallExpression(node) {
        const callee = unwrap(node.callee)
        if (callee?.type !== 'MemberExpression') return
        const method = propertyName(callee)
        const object = unwrap(callee.object)
        const args = node.arguments
        if (LOOKUP_METHODS.has(method) && args.some(isOrgIdentity) && isStaticCollection(context, object)) {
          context.report({ node, messageId: 'lookup' })
        } else if (STRING_METHODS.has(method) && isOrgIdentity(object) && args.some((a) => namesText(context, a))) {
          // A format check (orgCode.includes('-'), orgCode.match(/^[A-Z]+$/)) names no organization
          context.report({ node, messageId: 'compare' })
        } else if (['test', 'exec'].includes(method) && args.some(isOrgIdentity) && regexNamesText(regexPattern(context, object) ?? '')) {
          context.report({ node, messageId: 'compare' })
        } else if (
          (method === 'hasOwn' || method === 'has') &&
          object?.type === 'Identifier' &&
          ['Object', 'Reflect'].includes(object.name) &&
          isStaticCollection(context, args[0]) &&
          isOrgIdentity(args[1])
        ) {
          context.report({ node, messageId: 'lookup' })
        } else if (method === 'hasOwnProperty' && args.some(isOrgIdentity) && isStaticCollection(context, object)) {
          context.report({ node, messageId: 'lookup' })
        }
      },
      MemberExpression(node) {
        if (node.computed && isOrgIdentity(node.property) && isStaticCollection(context, node.object)) {
          context.report({ node, messageId: 'lookup' })
        }
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------------------------
// bcs/core-imports and bcs/core-purity — the functional core has no I/O, clock, randomness or environment (§4.2)
// ---------------------------------------------------------------------------------------------------------------

const CORE_ALLOWED = [/^zod(\/.*)?$/, /^decimal\.js$/, /^date-fns(\/.*)?$/, /^@date-fns\/tz$/]

const coreImports = {
  meta: {
    type: 'problem',
    docs: { description: 'src/core import ได้เฉพาะ core และ zod decimal.js date-fns @date-fns/tz (§4.10)' },
    schema: [],
    messages: {
      denied: 'bcs/core-imports: src/core ห้าม import "{{source}}" — core ต้องไม่มี I/O และใช้ได้เฉพาะ core กับ zod decimal.js date-fns @date-fns/tz (§4.10)',
      dynamic: 'bcs/core-imports: src/core ห้าม import() แบบ dynamic และ require() ที่ชื่อโมดูลไม่ใช่สตริงคงที่ — ใช้ import แบบ static (§4.10)',
    },
  },
  create(context) {
    const file = relFile(context)
    const allowed = (source) => {
      if (CORE_ALLOWED.some((re) => re.test(source))) return true
      const target = resolveImport(file, source)
      return target !== null && (target === 'src/core' || target.startsWith('src/core/'))
    }
    function check(node, source) {
      if (typeof source === 'string' && !allowed(source)) context.report({ node, messageId: 'denied', data: { source } })
    }
    return {
      ...moduleVisitors(context, check, (node) => context.report({ node, messageId: 'dynamic' })),
      // Core is synchronous and pure; import() loads code at run time and reaches every export of a library
      ImportExpression(node) {
        const source = staticString(node.source)
        if (source !== null && !allowed(source)) context.report({ node, messageId: 'denied', data: { source } })
        else context.report({ node, messageId: 'dynamic' })
      },
      // `typeof import('node:fs')` gives core a type-level dependency on a forbidden module
      TSImportType(node) {
        const source = staticString(node.argument?.type === 'TSLiteralType' ? node.argument.literal : node.source ?? node.argument)
        if (source !== null) check(node, source)
      },
    }
  },
}

// Functions marked `@pure false` in date-fns: they read the clock or global defaults.
const DATE_FNS_IMPURE = new Set([
  'constructNow',
  'endOfToday',
  'endOfTomorrow',
  'endOfYesterday',
  'formatDistanceToNow',
  'formatDistanceToNowStrict',
  'getDefaultOptions',
  'isFuture',
  'isPast',
  'isThisHour',
  'isThisISOWeek',
  'isThisMinute',
  'isThisMonth',
  'isThisQuarter',
  'isThisSecond',
  'isThisWeek',
  'isThisYear',
  'isToday',
  'isTomorrow',
  'isYesterday',
  'setDefaultOptions',
  'startOfToday',
  'startOfTomorrow',
  'startOfYesterday',
])
const DATE_FNS_SOURCE = /^date-fns(\/fp)?(?:\/(\w+)(?:\.[cm]?js)?)?$/
const TZ_CLASSES = new Set(['TZDate', 'TZDateMini'])
// Globals that give core access to time, randomness, the environment or I/O.
const FORBIDDEN_GLOBALS = new Set([
  'process',
  'performance',
  'crypto',
  'globalThis',
  'global',
  'window',
  'self',
  'navigator',
  'document',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  // Code built from strings escapes every check above
  'eval',
  'Function',
])
// Clock and randomness globals: core may use them only in the member forms checked below (Date.UTC, Math.max …),
// so `const D = Date; D.now()` or `const { random } = Math` cannot hide the clock or randomness.
const MEMBER_ONLY_GLOBALS = new Set(['Date', 'Math', 'Temporal'])

const corePurity = {
  meta: {
    type: 'problem',
    docs: { description: 'src/core ห้ามอ่านเวลา สุ่ม อ่าน environment หรือแตะ I/O (§4.2, §17.3)' },
    schema: [],
    messages: {
      clock: 'bcs/core-purity: {{what}} อ่านเวลาปัจจุบัน — core รับเวลา now เป็นพารามิเตอร์ (§17.3)',
      random: 'bcs/core-purity: {{what}} สุ่มค่า — core ต้อง deterministic (§4.2)',
      global: 'bcs/core-purity: ห้ามใช้ {{what}} ใน src/core — ไม่มี I/O เวลา สุ่ม หรือ environment ใน core (§4.2)',
      dateFns: 'bcs/core-purity: date-fns {{what}} อ่านเวลาหรือค่าตั้งต้นของเครื่อง — ส่งเวลา now เข้ามาแล้วใช้ฟังก์ชันที่รับวันที่อ้างอิง (§17.3)',
      indirect: 'bcs/core-purity: ใช้ {{what}} ทางอ้อม (เก็บใส่ตัวแปร ส่งต่อ หรือแตกค่า) ซ่อนการอ่านเวลาหรือการสุ่มได้ — เรียกเป็น {{what}}.<ชื่อ> ตรง ๆ (§4.2)',
    },
  },
  create(context) {
    const tzClassNames = new Set()
    const tzNamespaces = new Set()
    const dateFnsNamespaces = new Set()
    const isTzClass = (node) => {
      const n = unwrap(node)
      if (n?.type === 'Identifier') return tzClassNames.has(n.name)
      return n?.type === 'MemberExpression' && n.object.type === 'Identifier' && tzNamespaces.has(n.object.name) && TZ_CLASSES.has(propertyName(n))
    }
    const isGlobalNamed = (node, name) => node?.type === 'Identifier' && node.name === name && isGlobal(context, node)
    const checkGlobalRef = (identifier) => {
      if (FORBIDDEN_GLOBALS.has(identifier.name)) {
        context.report({ node: identifier, messageId: 'global', data: { what: identifier.name } })
        return
      }
      if (!MEMBER_ONLY_GLOBALS.has(identifier.name)) return
      let child = identifier
      let parent = identifier.parent
      while (parent && WRAPPERS.has(parent.type)) {
        child = parent
        parent = parent.parent
      }
      // Direct forms (Date.now, new Date(), Date(), Math.random) are judged by the visitors below
      if (parent?.type === 'MemberExpression' && parent.object === child && propertyName(parent) !== null) return
      if ((parent?.type === 'NewExpression' || parent?.type === 'CallExpression') && parent.callee === child && identifier.name === 'Date') return
      if (parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && parent.right === child) return
      if (parent?.type === 'TSTypeQuery' || parent?.type === 'TSQualifiedName') return
      context.report({ node: identifier, messageId: 'indirect', data: { what: identifier.name } })
    }
    const tzClassSpecifiers = []
    const specifierName = (s) => s.imported?.name ?? s.imported?.value ?? s.local?.name
    return {
      Program(program) {
        for (const statement of program.body) {
          const isImport = statement.type === 'ImportDeclaration'
          const isReexport = (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') && statement.source
          if (!isImport && !isReexport) continue
          const source = statement.source.value
          if (isImport && source === '@date-fns/tz') {
            for (const s of statement.specifiers) {
              if (s.type === 'ImportNamespaceSpecifier') tzNamespaces.add(s.local.name)
              else if (s.type === 'ImportSpecifier' && TZ_CLASSES.has(specifierName(s))) {
                tzClassNames.add(s.local.name)
                tzClassSpecifiers.push(s)
              }
            }
          }
          const m = DATE_FNS_SOURCE.exec(source)
          if (!m) continue
          if (m[2] && DATE_FNS_IMPURE.has(m[2])) {
            context.report({ node: statement, messageId: 'dateFns', data: { what: m[2] } })
            continue
          }
          // `export * from 'date-fns'` hands every impure function on to the rest of core
          if (statement.type === 'ExportAllDeclaration') {
            context.report({ node: statement, messageId: 'dateFns', data: { what: 'export *' } })
            continue
          }
          for (const s of statement.specifiers) {
            if (s.type === 'ImportNamespaceSpecifier') dateFnsNamespaces.add(s.local.name)
            else if ((s.type === 'ImportSpecifier' || s.type === 'ExportSpecifier') && DATE_FNS_IMPURE.has(isImport ? specifierName(s) : s.local.name ?? s.local.value)) {
              context.report({ node: s, messageId: 'dateFns', data: { what: isImport ? specifierName(s) : s.local.name ?? s.local.value } })
            }
          }
        }
      },
      'Program:exit'(program) {
        const globalScope = context.sourceCode.getScope(program)
        const refs = new Set(globalScope.through)
        for (const variable of globalScope.variables) {
          if (variable.defs.length === 0) for (const ref of variable.references) refs.add(ref)
        }
        for (const ref of refs) if (ref.isValueReference !== false) checkGlobalRef(ref.identifier)
        // The imported TZDate class: only `new TZDate(value, tz)`, `TZDate.tz(tz, value)`, types and instanceof
        for (const specifier of tzClassSpecifiers) {
          for (const variable of context.sourceCode.getDeclaredVariables(specifier)) {
            for (const ref of variable.references) {
              if (ref.isValueReference === false) continue
              let child = ref.identifier
              let parent = child.parent
              while (parent && WRAPPERS.has(parent.type)) {
                child = parent
                parent = parent.parent
              }
              if (parent?.type === 'NewExpression' && parent.callee === child) continue
              if (parent?.type === 'MemberExpression' && parent.object === child && propertyName(parent) !== null) continue
              if (parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && parent.right === child) continue
              if (parent?.type === 'TSTypeQuery' || parent?.type === 'TSQualifiedName') continue
              context.report({ node: ref.identifier, messageId: 'indirect', data: { what: ref.identifier.name } })
            }
          }
        }
      },
      MemberExpression(node) {
        const prop = propertyName(node)
        if (prop === 'now' && isGlobalNamed(node.object, 'Date')) context.report({ node, messageId: 'clock', data: { what: 'Date.now' } })
        else if (prop === 'random' && isGlobalNamed(node.object, 'Math')) context.report({ node, messageId: 'random', data: { what: 'Math.random' } })
        else if (prop === 'Now' && isGlobalNamed(node.object, 'Temporal')) context.report({ node, messageId: 'clock', data: { what: 'Temporal.Now' } })
        else if (node.object.type === 'Identifier' && dateFnsNamespaces.has(node.object.name) && DATE_FNS_IMPURE.has(prop)) {
          context.report({ node, messageId: 'dateFns', data: { what: prop } })
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee)
        if (isGlobalNamed(callee, 'Date')) context.report({ node, messageId: 'clock', data: { what: 'Date()' } })
        else if (callee?.type === 'MemberExpression' && propertyName(callee) === 'tz' && isTzClass(callee.object) && node.arguments.length < 2) {
          context.report({ node, messageId: 'clock', data: { what: 'TZDate.tz(timeZone)' } })
        }
      },
      NewExpression(node) {
        // `new Date(...args)` may receive no argument at run time
        if (node.arguments.length > 0 && node.arguments[0].type !== 'SpreadElement') return
        if (isGlobalNamed(unwrap(node.callee), 'Date')) context.report({ node, messageId: 'clock', data: { what: 'new Date()' } })
        else if (isTzClass(node.callee)) context.report({ node, messageId: 'clock', data: { what: 'new TZDate()' } })
      },
      MetaProperty(node) {
        if (node.meta.name === 'import') context.report({ node, messageId: 'global', data: { what: 'import.meta' } })
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------------------------
// bcs/no-raw-sql — $queryRawUnsafe/$executeRawUnsafe nowhere; other raw SQL only in src/server/db/sql (§4.8)
// ---------------------------------------------------------------------------------------------------------------

const RAW_SQL = /^\$(query|execute)Raw\w*$/

const noRawSql = {
  meta: {
    type: 'problem',
    docs: { description: 'raw SQL อยู่ได้เฉพาะ src/server/db/sql และห้ามรูปแบบ Unsafe ทุกที่ (§4.8)' },
    schema: [{ type: 'object', properties: { allowFiles: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      unsafe: 'bcs/no-raw-sql: ห้าม {{name}} ทุกที่ — ใช้ tagged template $queryRaw ใน src/server/db/sql (§4.8)',
      outside: 'bcs/no-raw-sql: {{name}} อยู่ได้เฉพาะ src/server/db/sql/*.ts ที่รับ organizationId ชัดเจน (§4.8)',
    },
  },
  create(context) {
    const allowed = matchesAny(relFile(context), context.options[0]?.allowFiles)
    function check(node, name) {
      if (typeof name !== 'string' || !RAW_SQL.test(name)) return
      if (name.endsWith('Unsafe')) context.report({ node, messageId: 'unsafe', data: { name } })
      else if (!allowed) context.report({ node, messageId: 'outside', data: { name } })
    }
    // A string that names the method but can never reach a client: a type (Pick<PrismaClient, '$queryRaw'>), one side
    // of a comparison or switch case, a key, an import/export name, or an entry of a list only used for membership tests
    function harmless(node) {
      const parent = node.parent
      if (parent.type === 'TSLiteralType' || ((parent.type === 'TSPropertySignature' || parent.type === 'TSMethodSignature') && parent.key === node)) return true
      if (parent.type === 'MemberExpression' && parent.property === node) return true
      if ((parent.type === 'Property' || parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') && parent.key === node && !parent.computed) return true
      if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier' || parent.type === 'ImportAttribute') return true
      if (parent.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) return true
      if (parent.type === 'SwitchCase' && parent.test === node) return true
      return parent.type === 'ArrayExpression' && isMembershipList(context, parent)
    }
    return {
      MemberExpression(node) {
        check(node.property, memberName(context, node))
      },
      Property(node) {
        if (node.parent.type === 'ObjectPattern') check(node.key, keyName(context, node))
      },
      // A method name kept in a string (`const names = ['$queryRaw']; db[names[0]]`) is reported where it is written
      Literal(node) {
        if (typeof node.value === 'string' && !harmless(node)) check(node, node.value)
      },
      TemplateLiteral(node) {
        if (node.parent.type === 'TaggedTemplateExpression' || harmless(node)) return
        const value = staticString(node)
        if (value !== null) check(node, value)
      },
    }
  },
}

/** An array of strings (or `new Set([...])` of one) bound to a const that is only ever asked `.includes/.has/.indexOf(x)`. */
function isMembershipList(context, array) {
  let holder = array.parent
  if (holder.type === 'NewExpression' && holder.arguments[0] === array && holder.callee.type === 'Identifier' && holder.callee.name === 'Set') holder = holder.parent
  while (WRAPPERS.has(holder.type)) holder = holder.parent
  if (holder.type !== 'VariableDeclarator' || holder.id.type !== 'Identifier' || holder.parent.kind !== 'const') return false
  // Another module could index a client with an exported list
  if (holder.parent.parent?.type === 'ExportNamedDeclaration') return false
  const [variable] = context.sourceCode.getDeclaredVariables(holder)
  const reads = variable?.references.filter((r) => !r.init) ?? []
  return reads.every((r) => {
    let child = r.identifier
    while (WRAPPERS.has(child.parent.type)) child = child.parent
    const member = child.parent
    return (
      member.type === 'MemberExpression' &&
      member.object === child &&
      ['includes', 'has', 'indexOf', 'lastIndexOf'].includes(propertyName(member)) &&
      member.parent.type === 'CallExpression' &&
      member.parent.callee === member
    )
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Database value flow — which values in a file may be a database client, hold one, or wrap one. bcs/query-read-only
// and bcs/service-tx-writes use it to find writes on a client; bcs/restricted-imports to find an unscoped client
// handed out of a file that may import it.
// ---------------------------------------------------------------------------------------------------------------

/** The value is a client or one of its model delegates (`db`, `db.member`). */
const CLIENT = 1
/** The value holds a client: an object or array with one inside, or a function that returns one. */
const HOLDER = 2
/** A function the rule cannot see into received a client, so its result may wrap it (`wrap(db)`). */
const MAYBE = 4
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const VALUE_ASSIGNMENT = new Set(['=', '||=', '&&=', '??='])
// Methods that store their arguments in the object they are called on
const STORING_METHODS = new Set(['push', 'unshift', 'splice', 'set', 'add', 'fill'])
// Client methods whose result is a client again
const CLIENT_RETURNING = new Set(['$extends', 'bind'])
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self', 'process'])
// Type names of a client or transaction parameter (`tx: TenantTx`, `db: Pick<PrismaClient, '$queryRaw'>`)
const DB_TYPES = new Set(['TenantTx', 'TenantDb', 'PrismaClient', 'TransactionClient', 'RawClient', 'DefaultPrismaClient'])

/** `Object.assign(t, …)`, `Object.defineProperty(t, …)`, `Reflect.set(t, …)` … store values in their first argument. */
function isObjectWriter(callee) {
  const c = unwrap(callee)
  if (c?.type !== 'MemberExpression' || c.object.type !== 'Identifier') return false
  const name = propertyName(c)
  if (c.object.name === 'Object') return ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(name)
  if (c.object.name === 'Reflect') return ['set', 'defineProperty', 'setPrototypeOf'].includes(name)
  return false
}

/** `{ source, imported }` of an import binding (`imported` is the exported name, 'default' or '*'); null for type-only imports. */
function importInfo(def) {
  if (def?.type !== 'ImportBinding') return null
  const node = def.node
  if (node.type === 'TSImportEqualsDeclaration') {
    if (node.importKind === 'type' || node.moduleReference.type !== 'TSExternalModuleReference') return null
    const source = staticString(node.moduleReference.expression)
    return source === null ? null : { source, imported: '*' }
  }
  const declaration = def.parent
  if (declaration?.type !== 'ImportDeclaration' || declaration.importKind === 'type' || node.importKind === 'type') return null
  if (node.type === 'ImportNamespaceSpecifier') return { source: declaration.source.value, imported: '*' }
  if (node.type === 'ImportDefaultSpecifier') return { source: declaration.source.value, imported: 'default' }
  return { source: declaration.source.value, imported: node.imported.name ?? node.imported.value }
}

const forTenantCall = (call) => {
  const callee = unwrap(call.callee)
  return (callee?.type === 'Identifier' && callee.name === 'forTenant') || (callee?.type === 'MemberExpression' && propertyName(callee) === 'forTenant')
}

function paramAnnotation(param) {
  if (param.type === 'AssignmentPattern') return param.left.typeAnnotation
  if (param.type === 'TSParameterProperty') return paramAnnotation(param.parameter)
  return param.typeAnnotation
}

/** True when a parameter's declared type names a client or transaction type. */
function hasDbType(sourceCode, param) {
  const annotation = paramAnnotation(param)
  let found = false
  if (annotation) {
    walk(sourceCode, annotation, (n) => {
      if (found) return false
      if (n.type === 'TSTypeReference') {
        const name = n.typeName.type === 'Identifier' ? n.typeName.name : n.typeName.type === 'TSQualifiedName' ? n.typeName.right.name : null
        if (DB_TYPES.has(name)) found = true
      }
      return true
    })
  }
  return found
}

const contains = (outer, inner) => outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1]

/**
 * Follows values through one file. Options:
 *   handout        — also follow a client into functions the rule cannot see (their result is MAYBE), into function
 *                    values that return it and into classes that keep it (bcs/restricted-imports)
 *   importMask     — mask of an import binding definition
 *   moduleMask     — mask of `import('x')` / `require('x')` with a constant name (null when computed)
 *   isSourceCall   — calls that create a client (forTenant(…))
 *   isClientParam  — parameters that receive a client by their declared type
 */
function createDbFlow(context, opts) {
  const { sourceCode } = context
  const handout = Boolean(opts.handout)
  const BUSY = -1
  const memos = { expr: new Map(), variable: new Map(), returns: new Map(), param: new Map() }

  function memo(map, key, compute) {
    const known = map.get(key)
    if (known !== undefined) return known === BUSY ? 0 : known
    map.set(key, BUSY)
    const value = compute()
    map.set(key, value)
    return value
  }

  // A member of a client is a model delegate (still a client); a member of a holder may be the client or another
  // holder; members and method results of a MAYBE are taken to be data.
  const memberOf = (mask) => (mask & CLIENT ? CLIENT : 0) | (mask & HOLDER ? CLIENT | HOLDER : 0)
  const container = (masks) => (masks.some((m) => m & (CLIENT | HOLDER)) ? HOLDER : masks.some((m) => m & MAYBE) ? MAYBE : 0)
  const anyArgument = (args) => args.reduce((m, a) => m | expr(a), 0)

  /** The function a name stands for: `function f() {}` or `const f = () => …`. */
  function functionOf(variable) {
    for (const def of variable?.defs ?? []) {
      if (def.type === 'FunctionName' && FUNCTIONS.has(def.node.type)) return def.node
      if (def.type === 'Variable' && def.parent?.kind === 'const' && def.node.id.type === 'Identifier') {
        const init = unwrap(def.node.init)
        if (init && FUNCTIONS.has(init.type)) return init
      }
    }
    return null
  }

  /** The variable that names a function, so its call sites can be followed. */
  function nameOf(fn) {
    if (fn.type === 'FunctionDeclaration' && fn.id) return sourceCode.getDeclaredVariables(fn).find((v) => v.defs[0]?.type === 'FunctionName') ?? null
    let parent = fn.parent
    while (parent && WRAPPERS.has(parent.type)) parent = parent.parent
    if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' && unwrap(parent.init) === fn) return sourceCode.getDeclaredVariables(parent)[0] ?? null
    return null
  }

  function expr(node) {
    const n = unwrap(node)
    return n ? memo(memos.expr, n, () => compute(n)) : 0
  }

  function compute(n) {
    switch (n.type) {
      case 'Identifier': {
        const v = resolveVariable(context, n)
        return v ? variable(v) : 0
      }
      case 'MemberExpression': {
        const o = expr(n.object)
        if (o & HOLDER) {
          const exact = literalMember(n)
          if (exact !== undefined) return exact
        }
        return memberOf(o)
      }
      case 'CallExpression':
        return call(n)
      case 'NewExpression':
        if (expr(n.callee) & (CLIENT | HOLDER)) return CLIENT
        return handout && anyArgument(n.arguments) ? MAYBE : 0
      case 'ImportExpression':
        return opts.moduleMask?.(constString(context, n.source)) ?? 0
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'SpreadElement':
        return n.argument ? expr(n.argument) : 0
      case 'ConditionalExpression':
        return expr(n.consequent) | expr(n.alternate)
      case 'LogicalExpression':
        return expr(n.left) | expr(n.right)
      case 'SequenceExpression':
        return expr(n.expressions.at(-1))
      case 'AssignmentExpression':
        return VALUE_ASSIGNMENT.has(n.operator) ? expr(n.right) | (n.operator === '=' ? 0 : expr(n.left)) : 0
      case 'ArrayExpression':
        return container(n.elements.map((e) => (e ? expr(e) : 0)))
      case 'ObjectExpression':
        return container(n.properties.map((p) => (p.type === 'SpreadElement' ? expr(p.argument) : propertyMask(p))))
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return handout && returns(n) ? HOLDER : 0
      case 'ClassExpression':
        return handout && classMask(n) ? HOLDER : 0
      case 'TaggedTemplateExpression': {
        const tag = unwrap(n.tag)
        if (tag?.type === 'MemberExpression' && expr(tag.object) & CLIENT) return 0
        return handout && anyArgument(n.quasi.expressions) ? MAYBE : 0
      }
      default:
        return 0
    }
  }

  /** What an object literal property holds: its value, or what its getter returns. */
  function propertyMask(p) {
    if (p.kind === 'get') return returns(p.value)
    if (p.kind === 'set') return 0
    if (p.method) return handout && returns(p.value) ? HOLDER : 0
    return expr(p.value)
  }

  /** `deps.cache` of `const deps = { db: forTenant(o), cache: new Map() }` — exact when the literal is never written into. */
  function literalMember(member) {
    const object = unwrap(member.object)
    if (object?.type !== 'Identifier') return undefined
    const v = constVariable(context, object)
    const init = v && unwrap(v.defs[0].node.init)
    if (init?.type !== 'ObjectExpression' || v.references.some((r) => storeOf(r) !== null)) return undefined
    const name = memberName(context, member)
    if (name === null) return undefined
    let found = null
    for (const p of init.properties) {
      if (p.type === 'SpreadElement') return undefined
      if (keyName(context, p) === name) found = p
    }
    return found ? propertyMask(found) : 0
  }

  function call(n) {
    if (opts.isSourceCall?.(n)) return CLIENT
    const callee = unwrap(n.callee)
    if (!callee) return 0
    if (isRequireCall(context, n)) return opts.moduleMask?.(constString(context, n.arguments[0])) ?? 0
    if (FUNCTIONS.has(callee.type)) return returns(callee)
    if (callee.type === 'Identifier') {
      const v = resolveVariable(context, callee)
      const fn = functionOf(v)
      if (fn) return returns(fn)
      // A function taken out of a holder may hand the client back
      if (v && variable(v) & (CLIENT | HOLDER)) return CLIENT | HOLDER
      return handout && anyArgument(n.arguments) ? MAYBE : 0
    }
    if (callee.type === 'MemberExpression') {
      const name = memberName(context, callee)
      const o = expr(callee.object)
      if (o & HOLDER) return CLIENT | HOLDER
      if (o & CLIENT) {
        if (CLIENT_RETURNING.has(name)) return CLIENT
        if (name === '$transaction') {
          const f = unwrap(n.arguments[0])
          return f && FUNCTIONS.has(f.type) ? returns(f) : 0
        }
        // findMany(), count(), $queryRaw … return data
        return 0
      }
      const object = unwrap(callee.object)
      if ((name === 'call' || name === 'apply') && object?.type === 'Identifier') {
        const fn = functionOf(resolveVariable(context, object))
        if (fn) return returns(fn)
      }
      if (name === 'get' && object?.type === 'Identifier' && object.name === 'Reflect') return memberOf(expr(n.arguments[0]))
      return handout && anyArgument(n.arguments) ? MAYBE : 0
    }
    return handout && anyArgument(n.arguments) ? MAYBE : 0
  }

  function variable(v) {
    return memo(memos.variable, v, () => {
      let m = 0
      for (const def of v.defs) m |= definition(def)
      for (const ref of v.references) {
        if (ref.isWrite() && ref.writeExpr) m |= written(ref)
        const stored = storeOf(ref)
        if (stored) m |= container([stored.mask])
      }
      return m
    })
  }

  function definition(def) {
    switch (def.type) {
      case 'ImportBinding':
        return opts.importMask?.(def) ?? 0
      case 'Parameter':
        return FUNCTIONS.has(def.node.type) ? parameter(def.node, def.name) : 0
      case 'FunctionName':
        return handout && FUNCTIONS.has(def.node.type) && returns(def.node) ? HOLDER : 0
      case 'ClassName':
        return handout && classMask(def.node) ? HOLDER : 0
      default:
        return 0
    }
  }

  /** What a write reference puts into its variable (a destructured or iterated name gets a member of the value). */
  function written(ref) {
    const id = ref.identifier
    const parent = id.parent
    if (parent.type === 'AssignmentExpression' && parent.left === id && !VALUE_ASSIGNMENT.has(parent.operator)) return 0
    const declarator = parent.type === 'VariableDeclarator' && parent.id === id
    const loop = declarator ? parent.parent.parent : parent
    if (loop?.type === 'ForInStatement' && (loop.left === id || loop.left === parent.parent)) return 0
    const mask = expr(ref.writeExpr)
    if (!mask) return 0
    if (loop?.type === 'ForOfStatement' && (loop.left === id || loop.left === parent.parent)) return memberOf(mask)
    const direct = declarator || (parent.type === 'AssignmentExpression' && parent.left === id) || (parent.type === 'AssignmentPattern' && parent.left === id && FUNCTIONS.has(parent.parent?.type))
    return direct ? mask : memberOf(mask)
  }

  /** When the reference is the object something is stored into (`v.x = …`, `v.push(…)`, `Object.assign(v, …)`). */
  function storeOf(ref) {
    if (ref.isWrite()) return null
    let child = ref.identifier
    let parent = child.parent
    while (parent && (WRAPPERS.has(parent.type) || (parent.type === 'MemberExpression' && parent.object === child))) {
      child = parent
      parent = parent.parent
    }
    if (parent?.type === 'AssignmentExpression' && parent.left === child && child !== ref.identifier) {
      return { mask: VALUE_ASSIGNMENT.has(parent.operator) ? expr(parent.right) : 0 }
    }
    if (parent?.type === 'CallExpression' && parent.arguments[0] === child && isObjectWriter(parent.callee)) return { mask: anyArgument(parent.arguments.slice(1)) }
    if (parent?.type === 'CallExpression' && parent.callee === child && child.type === 'MemberExpression' && STORING_METHODS.has(memberName(context, child))) {
      return { mask: anyArgument(parent.arguments) }
    }
    return null
  }

  /** Mask of a whole parameter: by declared type, as a transaction or iteration callback, or from the callers' arguments. */
  function parameterValue(fn, top) {
    return memo(memos.param, top, () => {
      const index = fn.params.indexOf(top)
      let m = opts.isClientParam?.(top, fn) ? CLIENT : 0
      let child = fn
      while (WRAPPERS.has(child.parent.type)) child = child.parent
      const call = child.parent
      if (call.type === 'CallExpression' && call.arguments.includes(child)) {
        const callee = unwrap(call.callee)
        if (callee?.type === 'MemberExpression') {
          const o = expr(callee.object)
          // <client>.$transaction(async (tx) => …): tx is the transaction's client
          if (memberName(context, callee) === '$transaction' && index === 0 && call.arguments[0] === child && o & CLIENT) m |= CLIENT
          // holder.forEach((db) => …): the elements of a holder
          else if (o & HOLDER) m |= memberOf(o)
        }
      }
      // A named local function receives what its callers pass
      for (const ref of nameOf(fn)?.references ?? []) {
        let callee = ref.identifier
        while (WRAPPERS.has(callee.parent.type)) callee = callee.parent
        const site = callee.parent
        if (site.type !== 'CallExpression' || site.callee !== callee) continue
        const spread = site.arguments.findIndex((a) => a.type === 'SpreadElement')
        if (spread >= 0 && spread <= index) m |= memberOf(expr(site.arguments[spread]))
        else if (site.arguments[index]) m |= expr(site.arguments[index])
      }
      return m
    })
  }

  function parameter(fn, id) {
    const top = fn.params.find((p) => contains(p, id))
    if (!top) return 0
    const direct = top === id || (top.type === 'AssignmentPattern' && top.left === id) || (top.type === 'TSParameterProperty' && (top.parameter === id || top.parameter.left === id))
    const mask = parameterValue(fn, top)
    return direct ? mask : memberOf(mask)
  }

  function returns(fn) {
    return memo(memos.returns, fn, () => {
      if (fn.body?.type !== 'BlockStatement') return fn.body ? expr(fn.body) : 0
      let m = 0
      walk(sourceCode, fn.body, (n) => {
        if (FUNCTIONS.has(n.type) || n.type === 'ClassBody') return false
        if ((n.type === 'ReturnStatement' || n.type === 'YieldExpression') && n.argument) m |= expr(n.argument)
        return true
      })
      return m
    })
  }

  /** A class keeps a client when a field, a getter or method result, or `this.x = …` in a method holds one. */
  function classMask(cls) {
    let m = 0
    for (const member of cls.body.body) {
      if (member.type === 'PropertyDefinition' && member.value) m |= expr(member.value)
      if (member.type !== 'MethodDefinition' || !member.value) continue
      m |= returns(member.value)
      walk(sourceCode, member.value.body, (n) => {
        if (n.type === 'AssignmentExpression' && unwrap(n.left)?.type === 'MemberExpression' && rootOfThis(n.left)) m |= expr(n.right)
        return !FUNCTIONS.has(n.type) || n === member.value
      })
    }
    return m ? HOLDER : 0
  }

  function rootOfThis(member) {
    let n = unwrap(member)
    while (n?.type === 'MemberExpression') n = unwrap(n.object)
    return n?.type === 'ThisExpression'
  }

  /** Mask of the value a destructuring pattern takes apart (nested patterns take members of it). */
  function patternSource(pattern) {
    let node = pattern
    let depth = 0
    for (;;) {
      const parent = node.parent
      if (parent.type === 'Property' && parent.value === node && parent.parent.type === 'ObjectPattern') {
        node = parent.parent
        depth++
      } else if (parent.type === 'ArrayPattern') {
        node = parent
        depth++
      } else if ((parent.type === 'AssignmentPattern' && parent.left === node) || parent.type === 'RestElement') {
        node = parent
      } else {
        let mask = 0
        if (parent.type === 'VariableDeclarator' && parent.id === node) {
          const loop = parent.parent.parent
          if (loop?.type === 'ForOfStatement' && loop.left === parent.parent) mask = memberOf(expr(loop.right))
          else if (loop?.type !== 'ForInStatement') mask = expr(parent.init)
        } else if (parent.type === 'AssignmentExpression' && parent.left === node) mask = expr(parent.right)
        else if (parent.type === 'ForOfStatement' && parent.left === node) mask = memberOf(expr(parent.right))
        else if (FUNCTIONS.has(parent.type) && parent.params.includes(node)) mask = parameterValue(parent, node)
        for (let i = 0; i < depth; i++) mask = memberOf(mask)
        return mask
      }
    }
  }

  return { expr, variable, returns, classMask, patternSource }
}

/** Merges rule visitors; handlers for the same node type all run. */
function mergeVisitors(...all) {
  const merged = {}
  for (const visitors of all) {
    for (const [key, fn] of Object.entries(visitors)) {
      const before = merged[key]
      merged[key] = before ? (node) => (before(node), fn(node)) : fn
    }
  }
  return merged
}

// ---------------------------------------------------------------------------------------------------------------
// bcs/restricted-imports — who may import the unscoped database clients and drivers, and that the files allowed to
// import them never hand them on (§4.8, §4.10)
// ---------------------------------------------------------------------------------------------------------------

/** Package name of a bare import (`pg-pool/lib/x` → `pg-pool`, `@neondatabase/serverless/x` → `@neondatabase/serverless`). */
function packageName(source) {
  const parts = source.split('/')
  return source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** `pg` matches pg and its subpaths; globs such as `pg-*` or `@neondatabase/*` match package names. */
function matchesPackage(source, pattern) {
  return path.posix.matchesGlob(packageName(source), pattern)
}

/** Whether `source` imported from `file` is a module of the entry: an exact path, a `folder/**` path, or a package. */
function entryHits(entry, file, source) {
  const target = resolveImport(file, source)
  if (target === null) return (entry.packages ?? []).some((p) => matchesPackage(source, p))
  return (entry.paths ?? []).some((p) => (p.endsWith('/**') ? target === p.slice(0, -3) || path.posix.matchesGlob(target, p) : target === p))
}

/** Whether a module (repo path without extension, as resolveImport gives it) matches one of the file globs. */
function moduleIn(target, globs) {
  return ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '/index.ts'].some((ext) => matchesAny(`${target}${ext}`, globs))
}

const DATA_FILE = /\.(json|css|svg|png|jpe?g|gif|webp|avif|ico|txt|md)$/i

/** `module.exports`, `module.exports.x`, `exports.x` (CommonJS globals, not local names). */
function isCommonJsExport(context, member) {
  const root = rootIdentifier(member)
  if (!root || !isGlobal(context, root)) return false
  if (root.name === 'exports') return true
  if (root.name !== 'module') return false
  let n = unwrap(member)
  while (n?.type === 'MemberExpression' && unwrap(n.object) !== root) n = unwrap(n.object)
  return n?.type === 'MemberExpression' && propertyName(n) === 'exports'
}

const restrictedImports = {
  meta: {
    type: 'problem',
    docs: { description: 'จำกัดผู้ที่ import client ฐานข้อมูลแบบไม่แยก tenant และ driver ได้ ไฟล์ที่ import ได้ห้ามส่งต่อ และ src ห้าม import ไฟล์นอก src (§4.8 §4.10)' },
    schema: [
      {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                // module paths (repo-relative, no extension; `folder/**` for a whole folder) and package globs
                paths: { type: 'array', items: { type: 'string' } },
                packages: { type: 'array', items: { type: 'string' } },
                allow: { type: 'array', items: { type: 'string' } },
                // files that may hand the module on (`export … from`, or exporting what they imported); every other
                // allowed file is checked so it cannot launder the module to code that may not import it
                reexportAllow: { type: 'array', items: { type: 'string' } },
                // only these imported names carry the client (e.g. PrismaClient of the generated client); default all
                handoutNames: { type: 'array', items: { type: 'string' } },
                // reviewed exceptions: exports of a file that hold the client on purpose, with the reason
                exportAllow: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { file: { type: 'string' }, names: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
                    required: ['file', 'names', 'reason'],
                    additionalProperties: false,
                  },
                },
                message: { type: 'string' },
              },
              required: ['allow', 'message'],
              additionalProperties: false,
            },
          },
          srcBoundary: {
            type: 'object',
            properties: { allow: { type: 'array', items: { type: 'string' } } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      restricted: 'bcs/restricted-imports: "{{source}}" — {{why}}',
      reexport: 'bcs/restricted-imports: ห้าม export ต่อ "{{source}}" — ส่ง client หรือ driver ต่อให้ชั้นที่ import เองไม่ได้ ({{why}})',
      handout:
        'bcs/restricted-imports: export "{{name}}" ส่ง client ที่ไม่แยก tenant (หรือสิ่งที่ห่อมัน) ออกจากไฟล์ — ชั้นที่ import ไฟล์นี้จะได้ client โดยไม่ผ่านการตรวจ ({{why}})',
      escape:
        'bcs/restricted-imports: ส่ง client ที่ไม่แยก tenant ออกนอกไฟล์ (global, object ของโมดูลอื่น หรือฟังก์ชันของโมดูลที่ import client เองไม่ได้) ({{why}})',
      dynamic:
        'bcs/restricted-imports: import()/require() ที่ชื่อโมดูลคำนวณตอนรัน ตรวจไม่ได้ว่าโหลด client ฐานข้อมูลหรือไม่ — ใช้ชื่อคงที่ (ยกเว้นไฟล์ข้อมูล เช่น `${locale}.json`)',
      outsideSrc: 'bcs/restricted-imports: "{{source}}" อยู่นอก src/ — โค้ดแอปห้ามพึ่ง scripts tests หรือ prisma (§4.10)',
    },
  },
  create(context) {
    const file = relFile(context)
    const { sourceCode } = context
    const { entries = [], srcBoundary } = context.options[0] ?? {}
    const inSrc = file.startsWith('src/')
    function check(node, source) {
      if (typeof source !== 'string') return
      const target = resolveImport(file, source)
      const typeOnly = node.exportKind === 'type' || (node.specifiers?.length > 0 && node.specifiers.every((s) => s.exportKind === 'type'))
      const reexport = (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && !typeOnly
      for (const entry of entries) {
        if (!entryHits(entry, file, source)) continue
        if (!matchesAny(file, entry.allow)) {
          context.report({ node, messageId: 'restricted', data: { source, why: entry.message } })
          return
        }
        if (reexport && !matchesAny(file, entry.reexportAllow)) {
          context.report({ node, messageId: 'reexport', data: { source, why: entry.message } })
          return
        }
      }
      if (srcBoundary && inSrc && target !== null && !target.startsWith('src/') && !matchesAny(target, srcBoundary.allow)) {
        context.report({ node, messageId: 'outsideSrc', data: { source } })
      }
    }
    // A module name computed at run time could be any restricted module; only data files may be loaded that way
    function onDynamic(node, sourceNode) {
      if (!inSrc || entries.every((e) => matchesAny(file, e.allow))) return
      const s = unwrap(sourceNode)
      if (s?.type === 'TemplateLiteral' && DATA_FILE.test(s.quasis.at(-1)?.value.cooked ?? '')) return
      context.report({ node, messageId: 'dynamic' })
    }
    const visitors = moduleVisitors(context, check, onDynamic)

    // Files that may import a module but not hand it on: no export, global, or other module may receive it
    const guarded = entries.filter((e) => matchesAny(file, e.allow) && !matchesAny(file, e.reexportAllow))
    if (guarded.length === 0) return visitors
    const flow = createDbFlow(context, {
      handout: true,
      importMask(def) {
        const info = importInfo(def)
        for (const entry of info ? guarded : []) {
          if (!entryHits(entry, file, info.source)) continue
          if (info.imported === '*') return HOLDER
          if (!entry.handoutNames || entry.handoutNames.includes(info.imported)) return CLIENT
        }
        return 0
      },
      moduleMask: (source) => (source !== null && guarded.some((e) => entryHits(e, file, source)) ? HOLDER : 0),
    })
    const why = guarded[0].message
    const reviewed = (name) => guarded.some((e) => (e.exportAllow ?? []).some((x) => matchesAny(file, [x.file]) && x.names.includes(name)))
    const handout = (node, name, mask) => {
      if (mask && !reviewed(name)) context.report({ node, messageId: 'handout', data: { name, why } })
    }
    const escape = (node, mask) => {
      if (mask) context.report({ node, messageId: 'escape', data: { why } })
    }
    /** An object outside this file: a global (or a local alias of one) or a binding imported from another module. */
    function outside(root) {
      const variable = resolveVariable(context, root)
      if (!variable || variable.defs.length === 0) return true
      if (variable.defs.some((d) => d.type === 'ImportBinding')) return true
      const def = variable.defs[0]
      const origin = def.type === 'Variable' && def.node.init ? rootIdentifier(def.node.init, true) : null
      return origin !== null && origin !== root && GLOBAL_OBJECTS.has(origin.name) && isGlobal(context, origin)
    }
    const exportsOf = {
      ExportNamedDeclaration(node) {
        if (node.source || node.exportKind === 'type') return
        const d = node.declaration
        if (d?.type === 'VariableDeclaration') for (const v of sourceCode.getDeclaredVariables(d)) handout(v.identifiers[0], v.name, flow.variable(v))
        else if (d?.type === 'FunctionDeclaration' && d.id) handout(d.id, d.id.name, flow.returns(d))
        else if (d?.type === 'ClassDeclaration' && d.id) handout(d.id, d.id.name, flow.classMask(d))
        for (const s of node.specifiers) {
          if (s.exportKind === 'type' || s.local.type !== 'Identifier') continue
          const v = resolveVariable(context, s.local)
          handout(s, s.exported.type === 'Identifier' ? s.exported.name : String(s.exported.value), v ? flow.variable(v) : 0)
        }
      },
      ExportDefaultDeclaration(node) {
        const d = node.declaration
        const mask = FUNCTIONS.has(d.type) ? flow.returns(d) : d.type === 'ClassDeclaration' || d.type === 'ClassExpression' ? flow.classMask(d) : flow.expr(d)
        handout(node, 'default', mask)
      },
      TSExportAssignment(node) {
        handout(node, 'export =', flow.expr(node.expression))
      },
      AssignmentExpression(node) {
        const left = unwrap(node.left)
        if (!VALUE_ASSIGNMENT.has(node.operator) || left?.type !== 'MemberExpression') return
        if (isCommonJsExport(context, left)) handout(node, 'module.exports', flow.expr(node.right))
        else {
          const root = rootIdentifier(left)
          if (root && outside(root)) escape(node, flow.expr(node.right))
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee)
        // Object.assign(globalThis, { db }), Reflect.set(importedObject, 'db', db), Object.assign(module.exports, …)
        if (isObjectWriter(callee)) {
          const target = unwrap(node.arguments[0])
          const root = target && rootIdentifier(target)
          if (root && (outside(root) || (target.type === 'MemberExpression' && isCommonJsExport(context, target)))) escape(node, node.arguments.slice(1).reduce((m, a) => m | flow.expr(a), 0))
          return
        }
        // The client handed to a function of another src module that may not import it itself (a setter or registry)
        const root = rootIdentifier(callee)
        const info = root && importInfo(resolveVariable(context, root)?.defs.find((d) => d.type === 'ImportBinding'))
        const target = info ? resolveImport(file, info.source) : null
        if (target === null || guarded.every((e) => moduleIn(target, e.allow))) return
        const mask = node.arguments.reduce((m, a) => m | flow.expr(a), 0)
        if (mask & (CLIENT | HOLDER)) escape(node, mask)
      },
    }
    return mergeVisitors(visitors, exportsOf)
  },
}

// ---------------------------------------------------------------------------------------------------------------
// bcs/query-read-only and bcs/service-tx-writes — queries never write; services write only through the transaction
// client that runCommand hands to execute() (§4.2, §4.3). Both follow the database client, not the method name, so
// map.delete(k) or url.searchParams.delete(k) are not writes.
// ---------------------------------------------------------------------------------------------------------------

const WRITE_METHOD = /^(create|update|delete)\w*$|^upsert$|^\$executeRaw\w*$|^\$runCommandRaw$/

const dbWriteSchema = [
  {
    type: 'object',
    properties: {
      // modules of the unscoped client (repo-relative, no extension): bindings imported from them are clients
      clientModules: { type: 'array', items: { type: 'string' } },
      // modules whose functions may write through raw SQL (src/server/db/sql/**), and the reviewed read-only ones
      opaqueModules: { type: 'array', items: { type: 'string' } },
      readHelpers: { type: 'array', items: { type: 'string' } },
      allowFiles: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
]

/** Reports writes (and calls by a computed method name) on a value that may be a database client. */
function dbWriteRule({ description, messages, typedParams }) {
  return {
    meta: { type: 'problem', docs: { description }, schema: dbWriteSchema, messages },
    create(context) {
      const options = context.options[0] ?? {}
      const file = relFile(context)
      if (matchesAny(file, options.allowFiles)) return {}
      const clientModules = options.clientModules ?? []
      const isClientModule = (source) => source !== null && clientModules.includes(resolveImport(file, source))
      const flow = createDbFlow(context, {
        importMask(def) {
          const info = importInfo(def)
          if (!info || !isClientModule(info.source)) return 0
          return info.imported === '*' ? HOLDER : CLIENT
        },
        moduleMask: (source) => (isClientModule(source) ? HOLDER : 0),
        isSourceCall: forTenantCall,
        isClientParam: typedParams ? (param) => hasDbType(context.sourceCode, param) : undefined,
      })
      const report = (node, name) => context.report({ node, messageId: name === null ? 'dynamic' : 'write', data: { name: name ?? '' } })
      // a member that is called (directly, as a tag, or through .call/.apply/.bind)
      const invoked = (node) => {
        let child = node
        while (WRAPPERS.has(child.parent.type)) child = child.parent
        const p = child.parent
        if (p.type === 'CallExpression' || p.type === 'NewExpression') return p.callee === child
        if (p.type === 'TaggedTemplateExpression') return p.tag === child
        return p.type === 'MemberExpression' && p.object === child && ['call', 'apply', 'bind'].includes(propertyName(p))
      }
      return {
        MemberExpression(node) {
          const name = memberName(context, node)
          if (name !== null ? !WRITE_METHOD.test(name) : !(node.computed && invoked(node))) return
          if (flow.expr(node.object) & CLIENT) report(node, name)
        },
        // const { update } = db.notification
        Property(node) {
          if (node.parent.type !== 'ObjectPattern') return
          const name = keyName(context, node)
          if (name !== null ? !WRITE_METHOD.test(name) : !node.computed) return
          if (flow.patternSource(node.parent) & CLIENT) report(node, name)
        },
        CallExpression(node) {
          const callee = unwrap(node.callee)
          // A raw-SQL helper (deleteMemberSessions(db, …)) handed a client may write with it
          const root = callee?.type === 'Identifier' ? callee : callee?.type === 'MemberExpression' ? rootIdentifier(callee) : null
          const info = root ? importInfo(resolveVariable(context, root)?.defs.find((d) => d.type === 'ImportBinding')) : null
          const target = info ? resolveImport(file, info.source) : null
          if (target !== null && moduleIn(target, options.opaqueModules ?? [])) {
            const helper = callee.type === 'Identifier' ? info.imported : memberName(context, callee)
            if (!(options.readHelpers ?? []).includes(helper) && node.arguments.some((a) => flow.expr(a) & CLIENT)) {
              context.report({ node, messageId: 'helper', data: { name: helper ?? '?' } })
            }
            return
          }
          // Reflect.get(db.notification, 'update'), Object.getOwnPropertyDescriptor(db.notification, 'update')
          if (callee?.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || node.arguments.length < 2) return
          const method = propertyName(callee)
          const reads =
            (callee.object.name === 'Reflect' && (method === 'get' || method === 'getOwnPropertyDescriptor')) ||
            (callee.object.name === 'Object' && method === 'getOwnPropertyDescriptor')
          if (!reads) return
          const name = constString(context, node.arguments[1])
          if (name !== null && !WRITE_METHOD.test(name)) return
          if (flow.expr(node.arguments[0]) & CLIENT) report(node, name)
        },
      }
    },
  }
}

const queryReadOnly = dbWriteRule({
  description: 'queries อ่านข้อมูลอย่างเดียว การเขียนต้องผ่าน runCommand ใน services (§4.2 §4.3)',
  typedParams: true,
  messages: {
    write: 'bcs/query-read-only: {{name}}() เขียนข้อมูล — src/server/queries อ่านอย่างเดียว ย้ายไป service ที่ผ่าน runCommand (§4.2)',
    dynamic: 'bcs/query-read-only: เรียกเมธอดของ client ด้วยชื่อที่คำนวณตอนรัน ตรวจไม่ได้ว่าเป็นการเขียนหรือไม่ — เรียกด้วยชื่อตรง ๆ (§4.2)',
    helper:
      'bcs/query-read-only: {{name}}() ใน src/server/db/sql อาจเขียนข้อมูลด้วย raw SQL — queries อ่านอย่างเดียว (ถ้าอ่านอย่างเดียวจริง เพิ่มชื่อใน readHelpers ของ eslint.config.mjs หลัง review) (§4.2)',
  },
})

const serviceTxWrites = dbWriteRule({
  description: 'services เขียนข้อมูลได้เฉพาะผ่าน tx ที่ runCommand ส่งให้ execute() (§4.3)',
  typedParams: false,
  messages: {
    write:
      'bcs/service-tx-writes: {{name}}() บน client จาก forTenant()/systemDb เขียนนอกธุรกรรมของ runCommand — ไม่มี Event CommandLog และ idempotency เขียนผ่าน tx ที่ execute() ได้รับเท่านั้น (§4.3)',
    dynamic:
      'bcs/service-tx-writes: เรียกเมธอดของ client จาก forTenant()/systemDb ด้วยชื่อที่คำนวณตอนรัน ตรวจไม่ได้ว่าเป็นการเขียนหรือไม่ — เรียกด้วยชื่อตรง ๆ (§4.3)',
    helper:
      'bcs/service-tx-writes: ส่ง client จาก forTenant()/systemDb ให้ {{name}}() ซึ่งเขียนข้อมูลด้วย raw SQL ได้ — ส่ง tx ที่ execute() ได้รับแทน (§4.3)',
  },
})

// ---------------------------------------------------------------------------------------------------------------
// bcs/no-thai-literal and bcs/no-ui-literal — screen text comes from next-intl messages (NFR-I18N-01, FR-PLT-002)
// ---------------------------------------------------------------------------------------------------------------

const THAI = /[฀-๿]/

const noThaiLiteral = {
  meta: {
    type: 'problem',
    docs: { description: 'ข้อความหน้าจอต้องมาจาก next-intl (messages/) ไม่ฝังในโค้ด (NFR-I18N-01, FR-PLT-002)' },
    schema: [],
    messages: { thai: 'bcs/no-thai-literal: ข้อความภาษาไทยในโค้ดหน้าจอ — ย้ายไป messages/src/{th,en}/ แล้วใช้ useTranslations/getTranslations' },
  },
  create(context) {
    const report = (node, text) => {
      if (THAI.test(text)) context.report({ node, messageId: 'thai' })
    }
    return {
      JSXText(node) {
        report(node, node.value)
      },
      Literal(node) {
        if (typeof node.value === 'string') report(node, node.value)
      },
      TemplateElement(node) {
        report(node, node.value.cooked ?? '')
      },
    }
  },
}

const LETTER = /\p{L}/u
// DOM attributes and the prop names this codebase gives user-visible text
const USER_FACING_ATTRIBUTES = new Set([
  'alt',
  'title',
  'placeholder',
  'label',
  'heading',
  'description',
  'message',
  'caption',
  'tooltip',
  'helperText',
  'emptyText',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'aria-braillelabel',
  'aria-brailleroledescription',
])

const noUiLiteral = {
  meta: {
    type: 'problem',
    docs: { description: 'ข้อความที่ผู้ใช้เห็นใน JSX (ทุกภาษา) ต้องมาจาก next-intl (FR-PLT-002 AC2, NFR-I18N-01)' },
    schema: [],
    messages: {
      literal: 'bcs/no-ui-literal: "{{text}}" ฝังในหน้าจอ — ย้ายไป messages/src/{th,en}/ แล้วใช้ useTranslations/getTranslations',
    },
  },
  create(context) {
    const flag = (node, text) => {
      // Thai text is reported by bcs/no-thai-literal
      if (LETTER.test(text) && !THAI.test(text)) context.report({ node, messageId: 'literal', data: { text: text.trim().slice(0, 40) } })
    }
    const flagExpression = (expression) => {
      const n = unwrap(expression)
      if (!n) return
      if (n.type === 'ConditionalExpression') {
        flagExpression(n.consequent)
        flagExpression(n.alternate)
      } else if (n.type === 'LogicalExpression') flagExpression(n.right)
      else if (n.type === 'TemplateLiteral') for (const q of n.quasis) flag(q, q.value.cooked ?? '')
      else {
        const s = staticString(n)
        if (s !== null) flag(n, s)
      }
    }
    return {
      JSXText(node) {
        flag(node, node.value)
      },
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || !USER_FACING_ATTRIBUTES.has(node.name.name) || !node.value) return
        if (node.value.type === 'Literal' && typeof node.value.value === 'string') flag(node.value, node.value.value)
        else if (node.value.type === 'JSXExpressionContainer') flagExpression(node.value.expression)
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === 'JSXElement' || node.parent.type === 'JSXFragment') flagExpression(node.expression)
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------------------------
// bcs/no-test-skip — tests are never skipped, focused, left as todo or inverted (CLAUDE.md §9)
// ---------------------------------------------------------------------------------------------------------------

const SKIP_MODIFIERS = new Set(['skip', 'only', 'todo', 'fails', 'fail', 'skipIf', 'runIf', 'fixme'])
// Keys of a test's options object that skip, focus, park or invert it: it('x', { skip: true }, fn)
const OPTION_MODIFIERS = new Set(['skip', 'only', 'todo', 'fails'])
const TEST_APIS = new Set(['it', 'test', 'describe', 'suite', 'bench', 'specify'])
const TEST_HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'aroundEach', 'aroundAll'])
const TEST_MODULES = /^(vitest|@playwright\/test|playwright\/test|node:test|bun:test|@jest\/globals)$/
// Types of the per-test context a helper may receive (vitest TestContext, Playwright TestInfo)
const TEST_CONTEXT_TYPES = new Set(['TestContext', 'TaskContext', 'ExtendedContext', 'TestInfo'])
const SKIPPING_CALLS = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe'])

const noTestSkip = {
  meta: {
    type: 'problem',
    docs: { description: 'ห้ามข้าม เลือกรัน ค้าง หรือกลับผลเทสต์ (CLAUDE.md §9)' },
    schema: [],
    messages: {
      modifier: 'bcs/no-test-skip: ห้ามใช้ .{{name}} — เทสต์ต้องรันและผ่านจริง ห้ามข้าม เลือกรัน หรือกลับผล (CLAUDE.md §9)',
      option: 'bcs/no-test-skip: ห้ามตั้ง {{name}} ใน options ของเทสต์ — เทสต์ต้องรันและผ่านจริง (CLAUDE.md §9)',
      status: 'bcs/no-test-skip: ห้ามเปลี่ยน expectedStatus — เทสต์ที่คาดว่าจะล้มจะผ่านทั้งที่โค้ดผิด (CLAUDE.md §9)',
      dynamic: 'bcs/no-test-skip: ห้ามเข้าถึง {{root}}[...] แบบคำนวณชื่อ — อาจซ่อน .skip/.only (CLAUDE.md §9)',
    },
  },
  create(context) {
    const { sourceCode } = context
    const roles = new Map()

    /**
     * 'api' for it/test/describe … (globals, imports, and names built from them such as `const t = base.extend()`),
     * 'context' for the per-test context (`(ctx) => ctx.skip()`, Playwright testInfo), else null. Local variables are
     * judged by their value, so `expect(q.skip)` or `const suite = loadGolden()` are not test APIs.
     */
    function role(identifier, depth = 0) {
      if (!identifier || depth > 6) return null
      const variable = resolveVariable(context, identifier)
      if (!variable || variable.defs.length === 0) return TEST_APIS.has(identifier.name) ? 'api' : identifier.name === 'testInfo' ? 'context' : null
      if (roles.has(variable)) return roles.get(variable)
      roles.set(variable, null)
      const result = roleOf(variable, depth)
      roles.set(variable, result)
      return result
    }

    function roleOf(variable, depth) {
      const def = variable.defs[0]
      if (def.type === 'ImportBinding') {
        const info = importInfo(def)
        if (!info) return null
        if (TEST_MODULES.test(info.source)) return TEST_APIS.has(info.imported) || info.imported === '*' ? 'api' : null
        return TEST_APIS.has(info.imported) || TEST_APIS.has(variable.name) ? 'api' : null
      }
      if (def.type === 'Variable') {
        const init = def.node.id.type === 'Identifier' ? def.node.init : null
        if (init) return role(rootIdentifier(init, true), depth + 1)
        // const { skip } = ctx is reported where it is destructured; the name itself is judged like its source
        return null
      }
      if (def.type === 'Parameter') {
        const fn = def.node
        const top = fn.params?.find((p) => contains(p, def.name))
        if (top && hasType(top, TEST_CONTEXT_TYPES)) return 'context'
        if (top && isTestCallback(fn, fn.params.indexOf(top))) return 'context'
        return variable.name === 'testInfo' ? 'context' : null
      }
      return null
    }

    function hasType(param, names) {
      const annotation = paramAnnotation(param)
      let found = false
      if (annotation) {
        walk(sourceCode, annotation, (n) => {
          if (n.type === 'TSTypeReference') {
            const name = n.typeName.type === 'Identifier' ? n.typeName.name : n.typeName.type === 'TSQualifiedName' ? n.typeName.right.name : null
            if (names.has(name)) found = true
          }
          return !found
        })
      }
      return found
    }

    const isHook = (callee) => {
      const c = unwrap(callee)
      if (c?.type === 'Identifier') return TEST_HOOKS.has(c.name)
      return c?.type === 'MemberExpression' && TEST_HOOKS.has(propertyName(c)) && role(rootIdentifier(c, true)) === 'api'
    }

    /**
     * A function given to a test, suite or hook call, whose parameter at `index` is the test context. The callback of
     * it.each(rows)(…) receives rows, and that of it.for(rows)(…) the row then the context.
     */
    function isTestCallback(fn, index) {
      let child = fn
      while (WRAPPERS.has(child.parent.type)) child = child.parent
      const call = child.parent
      if (call.type !== 'CallExpression' || !call.arguments.includes(child)) return false
      const callee = unwrap(call.callee)
      if (callee?.type === 'CallExpression') {
        const table = unwrap(callee.callee)
        if (table?.type !== 'MemberExpression' || role(rootIdentifier(table, true)) !== 'api') return false
        const method = propertyName(table)
        return method === 'for' ? index === 1 : method !== 'each'
      }
      return role(rootIdentifier(callee, true)) === 'api' || isHook(callee)
    }

    const testRoot = (node) => role(rootIdentifier(node, true)) !== null

    /** Where a destructuring pattern takes its value from: a test API or context? */
    function patternFromTest(pattern) {
      let node = pattern
      for (;;) {
        const parent = node.parent
        if ((parent.type === 'Property' && parent.value === node) || parent.type === 'ArrayPattern' || parent.type === 'RestElement') node = parent.type === 'Property' ? parent.parent : parent
        else if (parent.type === 'AssignmentPattern' && parent.left === node) node = parent
        else if (parent.type === 'VariableDeclarator' && parent.id === node) return parent.init ? testRoot(parent.init) : false
        else if (parent.type === 'AssignmentExpression' && parent.left === node) return testRoot(parent.right)
        else if (FUNCTIONS.has(parent.type) && parent.params.includes(node)) return hasType(node, TEST_CONTEXT_TYPES) || isTestCallback(parent, parent.params.indexOf(node))
        else return false
      }
    }

    /** Options objects of a test call: inline, a const bound to one, or spread into one. */
    function optionObjects(node, depth = 0) {
      const n = unwrap(node)
      if (!n || depth > 4) return []
      if (n.type === 'ObjectExpression') return [n, ...n.properties.flatMap((p) => (p.type === 'SpreadElement' ? optionObjects(p.argument, depth + 1) : []))]
      if (n.type === 'Identifier') {
        const variable = constVariable(context, n)
        return variable ? optionObjects(variable.defs[0].node.init, depth + 1) : []
      }
      return []
    }

    /** Playwright test details: { annotation: { type: 'skip' } } (or a list of them) marks the test skipped, fixme or failing. */
    function skippingAnnotation(value) {
      const items = value?.type === 'ArrayExpression' ? value.elements : [value]
      return items.some((item) => {
        const o = unwrap(item)
        if (o?.type !== 'ObjectExpression') return false
        const type = o.properties.find((p) => p.type === 'Property' && keyName(context, p) === 'type')
        const t = type ? constString(context, type.value) : null
        return t === null ? Boolean(type) : ['skip', 'fixme', 'fail'].includes(t)
      })
    }

    const report = (node, name) => context.report({ node, messageId: 'modifier', data: { name } })
    return {
      MemberExpression(node) {
        const name = memberName(context, node)
        if (name !== null) {
          if (SKIP_MODIFIERS.has(name) && testRoot(node.object)) report(node, name)
        } else if (node.computed && testRoot(node.object)) {
          context.report({ node, messageId: 'dynamic', data: { root: rootIdentifier(node.object, true)?.name ?? 'test' } })
        }
      },
      // const { skip } = ctx · it('x', ({ skip }) => skip())
      Property(node) {
        if (node.parent.type !== 'ObjectPattern') return
        const name = keyName(context, node)
        if (name !== null && SKIP_MODIFIERS.has(name) && patternFromTest(node.parent)) report(node, name)
      },
      CallExpression(node) {
        const callee = unwrap(node.callee)
        if (callee?.type === 'Identifier' && SKIPPING_CALLS.has(callee.name)) {
          report(node, callee.name)
          return
        }
        // Reflect.get(it, 'skip'), Object.getOwnPropertyDescriptor(test, 'only')
        if (callee?.type === 'MemberExpression' && callee.object.type === 'Identifier' && ['Reflect', 'Object'].includes(callee.object.name)) {
          const method = propertyName(callee)
          if (['get', 'getOwnPropertyDescriptor'].includes(method) && node.arguments.length >= 2 && testRoot(node.arguments[0])) {
            const name = constString(context, node.arguments[1])
            if (name === null) context.report({ node, messageId: 'dynamic', data: { root: rootIdentifier(node.arguments[0], true)?.name ?? 'test' } })
            else if (SKIP_MODIFIERS.has(name)) report(node, name)
          }
          return
        }
        // it('x', { skip: true }, fn) · describe('x', { todo: true }, …)
        if (role(rootIdentifier(callee, true)) !== 'api') return
        for (const arg of node.arguments) {
          for (const object of optionObjects(arg)) {
            for (const p of object.properties) {
              if (p.type !== 'Property') continue
              const name = keyName(context, p)
              const value = unwrap(p.value)
              if (name !== null && OPTION_MODIFIERS.has(name) && !(value?.type === 'Literal' && value.value === false)) {
                context.report({ node: p, messageId: 'option', data: { name } })
              } else if (name === 'annotation' && skippingAnnotation(value)) {
                context.report({ node: p, messageId: 'option', data: { name: 'annotation' } })
              }
            }
          }
        }
      },
      // Playwright: testInfo.expectedStatus = 'failed' turns a failure into a pass
      AssignmentExpression(node) {
        const left = unwrap(node.left)
        if (left?.type !== 'MemberExpression' || memberName(context, left) !== 'expectedStatus' || !testRoot(left.object)) return
        const value = unwrap(node.right)
        if (!(value?.type === 'Literal' && value.value === 'passed')) context.report({ node, messageId: 'status' })
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------------------------
// bcs/explained-any — `any` only with a reason comment (NFR-MNT-01). Inline eslint-disable has no effect in this
// project, so this rule replaces @typescript-eslint/no-explicit-any + "eslint-disable … -- reason".
// ---------------------------------------------------------------------------------------------------------------

// "any: reason", "any — reason", "no-explicit-any -- reason"
const ANY_REASON = /\bany\b[^\n]*?(?:--|:|—)\s*\S/i

const explainedAny = {
  meta: {
    type: 'problem',
    docs: { description: 'ห้ามใช้ any เว้นแต่มีคอมเมนต์เหตุผล (NFR-MNT-01)' },
    schema: [],
    messages: {
      any: 'bcs/explained-any: ใช้ any ได้เมื่อมีคอมเมนต์เหตุผลบรรทัดเดียวกันหรือบรรทัดก่อนหน้า เช่น // any: <เหตุผล> (NFR-MNT-01)',
    },
  },
  create(context) {
    // A reason comment that ends on line L explains `any` on line L (trailing comment) and on line L + 1
    const explained = new Set()
    for (const c of context.sourceCode.getAllComments()) if (ANY_REASON.test(c.value)) explained.add(c.loc.end.line)
    return {
      TSAnyKeyword(node) {
        const line = node.loc.start.line
        if (!explained.has(line) && !explained.has(line - 1)) context.report({ node, messageId: 'any' })
      },
    }
  },
}

const plugin = {
  meta: { name: 'eslint-plugin-bcs', version: '1.2.0' },
  rules: {
    'no-money-literal': noMoneyLiteral,
    'no-org-code': noOrgCode,
    'core-imports': coreImports,
    'core-purity': corePurity,
    'no-raw-sql': noRawSql,
    'restricted-imports': restrictedImports,
    'query-read-only': queryReadOnly,
    'service-tx-writes': serviceTxWrites,
    'no-thai-literal': noThaiLiteral,
    'no-ui-literal': noUiLiteral,
    'no-test-skip': noTestSkip,
    'explained-any': explainedAny,
  },
}

export default plugin
