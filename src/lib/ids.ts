import { v7 as uuidv7, validate, version } from 'uuid'

/** New primary key: UUID v7, time-ordered (ADR-028). Generated in the app because Postgres 17 has no uuidv7(). */
export function newId(): string {
  return uuidv7()
}

export function isUuidV7(value: string): boolean {
  return validate(value) && version(value) === 7
}
