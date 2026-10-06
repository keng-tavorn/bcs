import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { prisma } from '@/server/db/client'
import { E2E_DB } from '../support/e2e-env'
import { makeRoom } from './budget-room'

// Run by tests/e2e/request-form.spec.ts and liff-requests.spec.ts against the e2e database only:
//   <line code> <baht>   the budget line of the demo organization has at least <baht> left, before a test asks for that
//                        much on it and expects "งบพอ" and the request to go
// When other specs of the run have left the line less, a BUDGET_ADMIN tops it up through the budget import, as an
// administrator does (tests/e2e/budget-room.ts). Prints { code, available, added } (baht before VAT) as JSON last.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the budget room scene runs in the e2e database only')

const [code = '', baht = ''] = process.argv.slice(2)
if (!/^[A-Z0-9-]{3,50}$/.test(code)) throw new Error('the scene needs the code of a budget line')
if (!/^\d{1,13}\.\d{2}$/.test(baht)) throw new Error('the scene needs an amount in baht with two decimals')

const room = await makeRoom(code, amountToSatang(baht))
console.log(JSON.stringify({ code: room.code, available: satangToAmount(room.available), added: satangToAmount(room.added) }))
await prisma.$disconnect()
