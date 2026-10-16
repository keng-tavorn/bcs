import type { OrgSettings } from './org-settings'

// S6-21 (BR-UAT-01): every e-mail of a UAT sandbox starts with "[UAT]", so nobody takes it for the real system's
export const uatSubject = (subject: string) => (subject.startsWith('[UAT]') ? subject : `[UAT] ${subject}`)

/**
 * The settings a UAT sandbox starts with (BR-UAT-01 · ADR-174): production's, with the LINE channel off and asking
 * through the LINE chat off (S17 · BR-LINE-10), since a sandbox never sends by LINE. The other keys of chatIntake and
 * the whole of bcsGo are copied as they are. The one place both the sandbox command and the seed of SIMEC-UAT use.
 */
export function sandboxSettingsOf(settings: OrgSettings): OrgSettings {
  return {
    ...settings,
    features: { ...settings.features, lineChannel: false },
    ...(settings.chatIntake ? { chatIntake: { ...settings.chatIntake, enabled: false } } : {}),
  }
}
