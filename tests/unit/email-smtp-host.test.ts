import { describe, expect, it } from 'vitest'
import { smtpHost } from '@/integrations/email-provider'

// The SMTP host of the e-mail adapter (spec §5.1, FR-P2P-005): local Mailpit by its loopback address, so a network whose
// DNS answers "localhost" slowly never holds a PO's send command; every other host as configured.

describe('[FR-P2P-005/AC1] the SMTP host', () => {
  it('reaches localhost by 127.0.0.1 and leaves other hosts alone', () => {
    expect(smtpHost('localhost')).toBe('127.0.0.1')
    expect(smtpHost('smtp.example.com')).toBe('smtp.example.com')
    expect(smtpHost('127.0.0.1')).toBe('127.0.0.1')
  })
})
