// 设置页「侧栏」卡片：每个分组一枚可拖动的勾选卡片——
// 卡片头=拖拽手柄+组名+隐藏数(EyeOff)+条目总数，卡片体=响应式勾选网格（容器查询 2→3→4 列）；
// 分组顺序=鼠标按住卡片拖动（HTML5 DnD，dragEnter 即实时换位，drop 只收尾）。
// 持久化（按集群 localStorage）见 useNavPrefs；底栏 dirty 时出现恢复默认按钮。
import { useState } from 'react'
import { EyeOff, GripVertical, RotateCcw } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { useNavPrefs, type NavGroupKey } from '@/hooks/useNavPrefs'
import { tf, useT } from '@/i18n'
import { useCrds } from '@/resources/crds'
import { NAV_SECTIONS, sectionItems } from '@/resources/registry'
import { FADE, INSET, SectionCard } from './parts'

export function NavSettingsCard({ id }: { id?: string }) {
  const { cluster } = useParams()
  const t = useT()
  const nav = useNavPrefs(cluster)
  const { defs: crds } = useCrds(cluster)

  const groups = nav.orderedSections
    .map(section => ({
      section,
      label:
        section === 'crd'
          ? t('ui:customResources')
          : t(NAV_SECTIONS.find(s => s.section === section)!.label),
      items: (section === 'crd' ? crds : sectionItems(section)).map(d => ({
        key: d.kind,
        label: t(d.label),
      })),
    }))
    .filter(g => g.items.length > 0)

  // 拖拽中的卡片 + 当前悬停目标（高亮落点提示）；dragEnter 实时 moveTo，列表跟着手指走
  const [dragging, setDragging] = useState<NavGroupKey | null>(null)
  const [overKey, setOverKey] = useState<NavGroupKey | null>(null)
  const endDrag = () => {
    setDragging(null)
    setOverKey(null)
  }

  return (
    <SectionCard id={id} title={t('settings:sidebar')} desc={t('settings:sidebarHint')}>
      <div className="flex flex-col gap-2">
        {groups.map(g => {
          const hiddenCount = g.items.filter(it => nav.hidden.has(it.key)).length
          return (
            <section
              key={g.section}
              draggable
              onDragStart={e => {
                setDragging(g.section)
                e.dataTransfer.effectAllowed = 'move'
                // Firefox 规范怪癖：不 setData 不启动拖拽
                e.dataTransfer.setData('text/plain', g.section)
              }}
              onDragEnter={() => {
                if (dragging && dragging !== g.section) {
                  nav.moveTo(dragging, g.section)
                  setOverKey(g.section)
                }
              }}
              onDragOver={e => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={e => e.preventDefault()}
              onDragEnd={endDrag}
              className={cn(
                INSET,
                '@container overflow-hidden p-3 transition-shadow',
                dragging === g.section && 'opacity-45',
                overKey === g.section && dragging !== g.section && 'ring-2 ring-ring/50',
              )}
            >
              <header className="mb-1 flex items-center gap-2">
                <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" aria-hidden />
                <h3 className="text-[13px] font-semibold tracking-tight">{g.label}</h3>
                {hiddenCount > 0 && (
                  <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                    <EyeOff className="size-3" aria-hidden />
                    {hiddenCount}
                  </span>
                )}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {g.items.length === 1 ? t('settings:sidebarCountOne') : tf('settings:sidebarCount', { n: g.items.length })}
                </span>
              </header>
              <div className="grid grid-cols-2 gap-x-3 @xl:grid-cols-3 @4xl:grid-cols-4">
                {g.items.map(it => {
                  const isHidden = nav.hidden.has(it.key)
                  return (
                    <label
                      key={it.key}
                      className="-mx-1.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-[13px] transition-colors hover:bg-background/60 dark:hover:bg-background/20"
                    >
                      <Checkbox
                        checked={!isHidden}
                        onCheckedChange={v => nav.setHidden(it.key, v !== true)}
                        className="size-3.5 shrink-0"
                      />
                      <span className={cn('min-w-0 truncate', isHidden && 'text-muted-foreground')}>
                        {it.label}
                      </span>
                    </label>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>

      {/* ---- 底部操作行：有改动才出现，常驻可点 ---- */}
      {nav.dirty && (
        <div className={cn(FADE, 'mt-4 flex items-center justify-end gap-2 border-t pt-3')}>
          <Button variant="outline" size="sm" onClick={nav.reset}>
            <RotateCcw />
            {t('settings:sidebarReset')}
          </Button>
        </div>
      )}
    </SectionCard>
  )
}
