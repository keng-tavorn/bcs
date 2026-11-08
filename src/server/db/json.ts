import { Prisma } from './generated/client'

// SQL NULL for a nullable Json column (spec §6.1): Prisma takes a plain null as a JSON value it cannot store there, so a
// service that clears such a column (RiskTier.pendingChange, RiskQuestion.appliesWhen · S11-04) writes this instead.
export const DB_NULL = Prisma.DbNull
