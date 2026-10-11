import { describeP1Seed } from '../support/seed-p1'

// P1-02: the phase-1 workbook seeds early in a fiscal year — its 150 days of history span FY2569 and FY2570, and each
// request takes its budget key's line of the year of the day it was sent. A Monday 10:00 in Bangkok.
describeP1Seed({ label: 'early in the fiscal year (2027-02-15)', now: new Date('2027-02-15T03:00:00Z'), orgCode: 'P1-SEED-EARLY', fiscalYears: ['FY2569', 'FY2570'] })
