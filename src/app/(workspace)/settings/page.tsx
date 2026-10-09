import { getTranslations } from 'next-intl/server'
import { HubPage } from '../_shell/hub'

export async function generateMetadata() {
  const t = await getTranslations('shell.items')
  return { title: t('settings') }
}

/** "ตั้งค่าของฉัน" (§9.10): the member's own settings pages */
export default function SettingsPage() {
  return <HubPage group="settings" />
}
