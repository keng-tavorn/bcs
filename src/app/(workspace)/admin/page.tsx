import { getTranslations } from 'next-intl/server'
import { HubPage } from '../_shell/hub'

export async function generateMetadata() {
  const t = await getTranslations('shell.items')
  return { title: t('admin') }
}

/** "ผู้ดูแลองค์กร" (§9.10): the organization's admin pages this member may open */
export default function AdminPage() {
  return <HubPage group="admin" />
}
