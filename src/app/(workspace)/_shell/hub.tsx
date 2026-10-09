import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { memberPrincipal } from '@/server/authz'
import { listEnabledModules } from '@/server/queries/organization'
import { MenuHub } from '@/ui/shell/menu-hub'
import { getSession } from '../../_lib/session'
import { visibleMenu } from './menu'

// The hub pages of the sidebar's footer (/settings, /admin · §9.10): the pages of the group this member may open, from
// the same menu as the sidebar (FR-PLT-002 AC1). A member who may open none of them gets "not found", as the sidebar
// shows no hub to them; every page checks permissions again.
export async function HubPage({ group }: { group: 'settings' | 'admin' }) {
  const state = await getSession()
  if (state.kind !== 'member') notFound()
  const [tItems, tHub] = await Promise.all([getTranslations('shell.items'), getTranslations('shell.hub')])
  const modules = await listEnabledModules(state.member.organizationId)
  const entries = visibleMenu(memberPrincipal(state.member.id, state.roles), modules, true).filter((item) => item.group === group)
  if (entries.length === 0) notFound()
  return (
    <MenuHub
      title={tItems(group)}
      intro={tHub(group === 'settings' ? 'settingsIntro' : 'adminIntro')}
      entries={entries.map((item) => ({ key: item.key, href: item.href, label: tItems(item.key) }))}
    />
  )
}
