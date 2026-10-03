import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

// Loads a golden suite (spec §7, §15.2). The YAML files are byte-for-byte copies of the spec blocks
// (scripts/golden-drift.ts checks that); runners only adapt shapes and never change an expect value.

export interface GoldenCase {
  readonly id: string
  readonly [key: string]: unknown
}

export interface GoldenSuite {
  readonly suite: string
  readonly fn?: string
  readonly cases: readonly GoldenCase[]
}

export function loadGolden(name: string): GoldenSuite {
  const file = path.resolve(import.meta.dirname, `${name}.yaml`)
  const suite = parse(readFileSync(file, 'utf8')) as GoldenSuite
  if (!suite?.cases?.length) throw new Error(`${file} has no cases`)
  return suite
}
