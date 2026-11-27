// 设置页「侧栏」卡片：条目显隐（kind 勾选）+ 分组上下移排序；持久化见 useNavPrefs。
import { ChevronDown, ChevronUp, RotateCcw } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { useNavPrefs } from '@/hooks/useNavPrefs'
import { tf, useT } from '@/i18n'
import { useCrds } from '@/resources/crds'
import { NAV_SECTIONS, sectionItems } from '@/resources/registry'

export function NavSettingsCard() {
  const { cluster } = useParams()
  const t = useT()
  const nav = useNavPrefs(cluster)
  const { defs: crds } = useCrds(cluster)

  return (
    <Card className="gap-3 [--card-spacing:--spacing(5)]">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">{t('settings:sidebar')}</CardTitle>
          {nav.dirty && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[13px]" onClick={nav.reset}>
              <RotateCcw className="size-3.5" />
              {t('settings:sidebarReset')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground">{t('settings:sidebarHint')}</div>
        {nav.orderedSections.map((section, i) => {
          const isCrd = section === 'crd'
          const label = isCrd ? t('ui:customResources') : t(NAV_SECTIONS.find(s => s.section === section)!.label)
          const items = isCrd
            ? crds.map(d => ({ key: d.kind, label: t(d.label) }))
            : sectionItems(section).map(d => ({ key: d.kind, label: t(d.label) }))
          if (isCrd && items.length === 0) return null
          return (
            <div key={section} className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-1">
                <span className="text-[13px] font-medium">{label}</span>
                <span className="text-xs text-muted-foreground">({tf('settings:sidebarCount', { n: items.length })})</span>
                <span className="ml-auto flex">
                  <Button variant="ghost" size="icon" className="size-6" disabled={i === 0} onClick={() => nav.move(section, -1)} aria-label={t('settings:sidebarUp')}>
                    <ChevronUp className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6" disabled={i === nav.orderedSections.length - 1} onClick={() => nav.move(section, 1)} aria-label={t('settings:sidebarDown')}>
                    <ChevronDown className="size-3.5" />
                  </Button>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {items.map(it => (
                  <label key={it.key} className="flex cursor-pointer items-center gap-1.5 text-[13px]">
                    <Checkbox
                      checked={!nav.hidden.has(it.key)}
                      onCheckedChange={v => nav.setHidden(it.key, v !== true)}
                      className="size-3.5"
                    />
                    <span className={nav.hidden.has(it.key) ? 'text-muted-foreground' : ''}>{it.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
