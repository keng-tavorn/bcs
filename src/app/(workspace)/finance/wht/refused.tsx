import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Notice } from '@/ui/form/notice'
import { Page, PageHeader } from '@/ui/page/page'

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** What a tax page shows when its view refuses (S8-13): PAY switched off, or a member without the capability */
export async function Refused({ code }: { code: string }) {
  const t = await getTranslations('apTax')
  const payOff = code === 'MODULE_DISABLED'
  return (
    <Page>
      <PageHeader title={payOff ? t('payOffTitle') : t('forbiddenTitle')} />
      <div className="flex max-w-2xl flex-col gap-4">
        <Notice tone="warning">{payOff ? t('payOffHint') : t('forbiddenHint')}</Notice>
        <Link href="/" className={linkClass}>
          {t('home')}
        </Link>
      </div>
    </Page>
  )
}
