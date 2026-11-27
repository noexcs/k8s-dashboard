// 设置页：/c/:cluster/settings — 语言切换 + 主题三档 + 集群列表/动态集群增删 + 关于。
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NavSettingsCard } from '@/features/settings/NavSettingsCard'
import { PromSettingsCard } from '@/features/settings/PromSettingsCard'
import { ClusterSettingsCard } from '@/features/settings/ClusterSettingsCard'
import { LANGS, useLang } from '@/i18n'
import { THEME_OPTIONS, useTheme } from '@/hooks/useTheme'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { WEB_VERSION } from '@/lib/version'
import { AIServiceCard } from './AIServiceCard'

export function SettingsPage() {
  const t = useT()
  const { lang, setLang } = useLang()
  const { theme, setTheme } = useTheme()

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-lg font-medium">{t('settings:title')}</h1>

      <Card className="gap-3 [--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-sm">{t('settings:language')}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* 两档选项不做下拉，与外观卡片同交互（点卡片即切换） */}
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('settings:language')}>
            {LANGS.map(o => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={lang === o.value}
                onClick={() => setLang(o.value)}
                className={cn(
                  'rounded-md border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                  lang === o.value ? 'border-foreground/15 bg-accent' : 'hover:bg-accent/40',
                )}
              >
                <div className="text-[13px] font-medium">{o.label}</div>
                <div className="mt-0.5 text-xs leading-4 text-muted-foreground">{t(o.descKey)}</div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-3 [--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-sm">{t('settings:appearance')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('settings:appearance')}>
            {THEME_OPTIONS.map(o => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={theme === o.value}
                onClick={() => setTheme(o.value)}
                className={cn(
                  'rounded-md border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                  theme === o.value ? 'border-foreground/15 bg-accent' : 'hover:bg-accent/40',
                )}
              >
                <div className="text-[13px] font-medium">{t(o.labelKey)}</div>
                <div className="mt-0.5 text-xs leading-4 text-muted-foreground">{t(o.descKey)}</div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <NavSettingsCard />

      <PromSettingsCard />

      <ClusterSettingsCard />

      <Card className="gap-3 [--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-sm">{t('settings:about')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-[13px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('settings:frontendVersion')}</span>
            <span className="font-mono">v{WEB_VERSION}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('settings:project')}</span>
            <span>headlamp fork · K8S Dashboard</span>
          </div>
        </CardContent>
      </Card>

      {/* 值班名：UI 写/交接/接班统一署名（审计 actor）。单用户可留空；多人轮值时必填才有责任账 */}
      <Card className="gap-3 [--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-sm">{t('settings:oncallName')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Input
            defaultValue={localStorage.getItem('k8s-oncall') ?? ''}
            placeholder={t('settings:oncallNamePh')}
            className="h-8 max-w-60 text-[13px]"
            onChange={(e) => localStorage.setItem('k8s-oncall', e.target.value.trim())}
          />
          <p className="text-xs text-muted-foreground">{t('settings:oncallNameHint')}</p>
        </CardContent>
      </Card>

      <AIServiceCard />
    </div>
  )
}
