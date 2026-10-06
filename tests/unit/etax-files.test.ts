import { describe, expect, it } from 'vitest'
import { MAX_EMBEDDED_FILE_BYTES } from '@/lib/constants'
import { embeddedFiles } from '@/lib/pdf-embedded'
import { find, findDeep, parseXml, XmlError } from '@/lib/xml'
import { etaxXml, pdfWithEmbedded } from '../support/etax-files'

// The readers under BR-IVC-05 (FR-P2P-008 AC4): a strict XML reader that tells a broken file from an invoice that
// lacks a value, and the embedded files of a PDF/A-3, all on files the tests make themselves.

const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes)

describe('[FR-P2P-008/AC4] the XML reader', () => {
  it('reads elements by local name with attributes, entities and Thai text', () => {
    const root = parseXml(etaxXml())
    expect(root.name).toBe('TaxInvoice_CrossIndustryInvoice')
    expect(find(root, 'ExchangedDocument', 'ID')?.text).toBe('ET-0001')
    expect(find(findDeep(root, 'SellerTradeParty')!, 'Name')?.text).toBe('บริษัท ผู้ขายทดสอบ & ลูก จำกัด')
    expect(find(findDeep(root, 'SpecifiedTaxRegistration')!, 'ID')?.attributes).toEqual({ schemeID: 'TXID' })
    expect(find(root, 'ExchangedDocument', 'Missing')).toBeNull()
    expect(findDeep(root, 'Missing')).toBeNull()
  })

  it('reads CDATA, character references, quoted ">" in attributes, a byte-order mark, comments and declarations', () => {
    expect(parseXml(`<a x='1 > 0' y="&quot;q&quot;"><![CDATA[<b>&]]>&#x0E01;&#3585;&lt;&gt;&amp;&apos;</a>`)).toEqual({ name: 'a', attributes: { x: '1 > 0', y: '"q"' }, children: [], text: `<b>&กก<>&'` })
    expect(parseXml('﻿<?xml version="1.0"?><!-- c --><p:a xmlns:p="urn:x"><p:b/></p:a>').children).toEqual([{ name: 'b', attributes: {}, children: [], text: '' }])
  })

  it.each([
    ['an unclosed tag', '<a><b></a>'],
    ['a mismatched end tag', '<a></b>'],
    ['text outside the root', '<a/>x'],
    ['two roots', '<a/><b/>'],
    ['a second root after an element', '<a></a><b></b>'],
    ['a stray <', '<a>1 < 2</a>'],
    ['a bare &', '<a>A & B</a>'],
    ['an unknown entity', '<a>&nbsp;</a>'],
    ['a character reference beyond Unicode', '<a>&#x110000;</a>'],
    ['a zero character reference', '<a>&#0;</a>'],
    ['a DTD with an external entity', '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'],
    ['an attribute without a value', '<a b></a>'],
    ['an unclosed start tag', '<a'],
    ['an unclosed end tag', '<a></a'],
    ['an unclosed comment', '<a><!-- </a>'],
    ['an unclosed processing instruction', '<?xml <a/>'],
    ['CDATA outside the root', '<![CDATA[x]]><a/>'],
    ['an unclosed CDATA section', '<a><![CDATA[x</a>'],
    ['a start tag that is not a name', '<1a></1a>'],
    ['no element at all', '   '],
    ['nesting deeper than any invoice', `${'<a>'.repeat(65)}${'</a>'.repeat(65)}`],
  ])('refuses %s', (_, xml) => {
    expect(() => parseXml(xml)).toThrow(XmlError)
  })

  it('takes nesting up to the limit', () => {
    expect(parseXml(`${'<a>'.repeat(64)}${'</a>'.repeat(64)}`).name).toBe('a')
  })
})

describe('[FR-P2P-008/AC4] the files embedded in a PDF', () => {
  it('reads deflated and plain streams, with /Length written out, as a reference, or a one-filter array', () => {
    const pdf = pdfWithEmbedded([
      { name: 'a.xml', content: etaxXml() },
      { name: 'b.xml', content: '<x/>', filter: 'none' },
      { name: 'c.xml', content: '<y/>', indirectLength: true },
      { name: 'd.xml', content: '<z/>', filter: '[/FlateDecode]' },
    ])
    expect(embeddedFiles(pdf).map(utf8)).toEqual([etaxXml(), '<x/>', '<y/>', '<z/>'])
  })

  it('keeps a stream that holds the word endstream when /Length says where it ends', () => {
    expect(embeddedFiles(pdfWithEmbedded([{ name: 'a.txt', content: 'one\nendstream\ntwo', filter: 'none' }])).map(utf8)).toEqual(['one\nendstream\ntwo'])
  })

  it('gives nothing for an encrypted PDF, a file that is not a PDF, or a PDF without embedded files', () => {
    expect(embeddedFiles(pdfWithEmbedded([{ name: 'a.xml', content: etaxXml() }], { encrypted: true }))).toEqual([])
    expect(embeddedFiles(new TextEncoder().encode(etaxXml()))).toEqual([])
    expect(embeddedFiles(pdfWithEmbedded([]))).toEqual([])
  })

  it('skips a damaged stream, filters it does not take, and anything past the size limit', () => {
    const skipped = pdfWithEmbedded([
      { name: 'damaged.xml', content: etaxXml(), written: new Uint8Array([1, 2, 3, 4]) },
      { name: 'hex.xml', content: '3c782f3e>', filter: '/ASCIIHexDecode' },
      { name: 'two.xml', content: '<x/>', filter: '[/ASCII85Decode /FlateDecode]' },
      { name: 'bomb.xml', content: new Uint8Array(MAX_EMBEDDED_FILE_BYTES + 1) },
      { name: 'big.xml', content: new Uint8Array(MAX_EMBEDDED_FILE_BYTES + 1), filter: 'none' },
      { name: 'ok.xml', content: '<ok/>' },
    ])
    expect(embeddedFiles(skipped).map(utf8)).toEqual(['<ok/>'])
  })
})
