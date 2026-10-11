import { describeP1Seed } from '../support/seed-p1'

// P1-02: the phase-1 workbook seeds late in a fiscal year — 150 days of history inside FY2569 (OQ-11 default: the
// fiscal year is the calendar year). A Monday 10:00 in Bangkok.
describeP1Seed({ label: 'late in the fiscal year (2026-12-14)', now: new Date('2026-12-14T03:00:00Z'), orgCode: 'P1-SEED-LATE', fiscalYears: ['FY2569'] })
