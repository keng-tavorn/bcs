// A small, strict XML reader for e-Tax invoices (spec BR-IVC-05): elements with their local names (namespace prefixes
// dropped), attributes, text and CDATA; entities &lt; &gt; &amp; &quot; &apos; and numeric references. Anything not
// well-formed — an unclosed or mismatched tag, a stray "<" or "&", text after the root, nesting deeper than any invoice
// — throws XmlError, so a broken file is told apart from an invoice that is merely missing a value. No DTD and no
// external entities are ever read.

export class XmlError extends Error {}

export interface XmlElement {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: readonly XmlElement[]
  readonly text: string
}

const NAMED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
/** Far deeper than an e-Tax invoice (about ten levels); keeps a hostile file from exhausting the stack in find() */
const MAX_DEPTH = 64

function decode(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+;|#[0-9]+;|[A-Za-z][\w.-]*;)?/g, (whole, ref: string | undefined) => {
    if (!ref) throw new XmlError('a bare & is not allowed')
    const name = ref.slice(0, -1)
    if (name.startsWith('#')) {
      const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      try {
        if (code > 0) return String.fromCodePoint(code)
      } catch {
        // beyond Unicode: falls through to the error below
      }
      throw new XmlError(`bad character reference ${whole}`)
    }
    const named = NAMED[name]
    if (named === undefined) throw new XmlError(`unknown entity ${whole}`)
    return named
  })
}

const localName = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1)

/** The ">" that closes the tag opened at `from`, skipping quoted attribute values; -1 when there is none */
function tagEnd(text: string, from: number): number {
  let quote = ''
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

interface Building {
  name: string
  qualified: string
  attributes: Record<string, string>
  children: XmlElement[]
  text: string
}

export function parseXml(source: string): XmlElement {
  const text = source.replace(/^﻿/, '')
  const stack: Building[] = []
  let root: XmlElement | null = null
  const attach = (element: XmlElement) => {
    if (stack.length) stack.at(-1)!.children.push(element)
    else if (root) throw new XmlError('more than one root element')
    else root = element
  }
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    const chunk = lt === -1 ? text.slice(i) : text.slice(i, lt)
    if (chunk.trim()) {
      if (stack.length === 0) throw new XmlError('text outside the root element')
      stack.at(-1)!.text += decode(chunk)
    }
    if (lt === -1) break
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt)
      if (end === -1) throw new XmlError('unclosed processing instruction')
      i = end + 2
    } else if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt)
      if (end === -1) throw new XmlError('unclosed comment')
      i = end + 3
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt)
      if (end === -1 || stack.length === 0) throw new XmlError('unclosed or misplaced CDATA')
      stack.at(-1)!.text += text.slice(lt + 9, end)
      i = end + 3
    } else if (text.startsWith('<!', lt)) {
      throw new XmlError('DTDs are not read')
    } else if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt)
      if (end === -1) throw new XmlError('unclosed end tag')
      const qualified = text.slice(lt + 2, end).trim()
      const open = stack.pop()
      if (!open || open.qualified !== qualified) throw new XmlError(`end tag </${qualified}> does not match`)
      attach({ name: open.name, attributes: open.attributes, children: open.children, text: open.text })
      i = end + 1
    } else {
      const end = tagEnd(text, lt + 1)
      if (end === -1) throw new XmlError('unclosed start tag')
      const selfClosing = text[end - 1] === '/'
      const inner = text.slice(lt + 1, selfClosing ? end - 1 : end)
      const m = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(inner)
      if (!m) throw new XmlError('bad start tag')
      const attributes: Record<string, string> = {}
      const attrs = m[2]!
      const attrPattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
      for (let a = attrPattern.exec(attrs); a; a = attrPattern.exec(attrs)) attributes[localName(a[1]!)] = decode(a[3] ?? a[4] ?? '')
      if (attrs.replace(attrPattern, '').trim().length) throw new XmlError('bad attribute')
      if (selfClosing) attach({ name: localName(m[1]!), attributes, children: [], text: '' })
      else {
        if (!stack.length && root) throw new XmlError('more than one root element')
        if (stack.length >= MAX_DEPTH) throw new XmlError('nested too deeply')
        stack.push({ name: localName(m[1]!), qualified: m[1]!, attributes, children: [], text: '' })
      }
      i = end + 1
    }
  }
  if (stack.length) throw new XmlError(`<${stack.at(-1)!.qualified}> is not closed`)
  if (!root) throw new XmlError('no root element')
  return root
}

/** The first element at this path of local names below `from` (depth-first), or null */
export function find(from: XmlElement, ...path: string[]): XmlElement | null {
  if (path.length === 0) return from
  const [head, ...rest] = path
  for (const child of from.children) {
    if (child.name === head) {
      const found = find(child, ...rest)
      if (found) return found
    }
  }
  return null
}

/** The first element with this local name anywhere below `from`, or null */
export function findDeep(from: XmlElement, name: string): XmlElement | null {
  for (const child of from.children) {
    if (child.name === name) return child
    const found = findDeep(child, name)
    if (found) return found
  }
  return null
}
