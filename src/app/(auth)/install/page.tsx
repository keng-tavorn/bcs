import { getTranslations } from 'next-intl/server'

export async function generateMetadata() {
  const t = await getTranslations('pwa')
  return { title: t('installTitle') }
}

// How to add BCS to the home screen (spec §9.7). iOS has no install prompt, so the steps are written out.
export default async function InstallPage() {
  const t = await getTranslations('pwa')
  const platforms = [
    { id: 'ios', title: t('iosTitle'), steps: [t('iosStep1'), t('iosStep2'), t('iosStep3')] },
    { id: 'android', title: t('androidTitle'), steps: [t('androidStep1'), t('androidStep2'), t('androidStep3')] },
  ]
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('installTitle')}</h1>
      <p className="text-ink-muted">{t('installIntro')}</p>
      {platforms.map((platform) => (
        <section key={platform.id} aria-labelledby={`install-${platform.id}`} className="flex flex-col gap-2">
          <h2 id={`install-${platform.id}`} className="text-xl font-semibold">
            {platform.title}
          </h2>
          <ol className="list-decimal space-y-1 pl-6">
            {platform.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}
