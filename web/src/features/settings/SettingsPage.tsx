// 设置页：/c/:cluster/settings — 外观（明暗模式 + 配色主题色板墙 + 自定义覆盖瓦片）/语言/侧栏在前，
// 集群与观测/AI 集成居中，关于收尾。
import { Activity, BellRing, Boxes, Check, Info, Languages, PanelLeft, Palette, RotateCcw, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { NavSettingsCard } from '@/features/settings/NavSettingsCard'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PromSettingsCard } from '@/features/settings/PromSettingsCard'
import { ClusterSettingsCard } from '@/features/settings/ClusterSettingsCard'
import { LANGS, tf, useLang, useT } from '@/i18n'
import themesMeta from '@tokens/json/themes.json'
import { THEME_OPTIONS, hexLuminance, reapplyTheme, useTheme, type ThemeId } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { WEB_VERSION } from '@/lib/version'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { AIServiceCard } from './AIServiceCard'
import { FADE, INSET, SectionCard, Segmented, SettingRow, SettingTile } from './parts'

// 预设色板：Radix Colors v3 色族 9 档 light 值照抄（@radix-ui/colors），冷暖全谱
const ACCENT_PRESETS: [hex: string, name: string][] = [
  ['#e5484d', 'Red'], ['#f76b15', 'Orange'], ['#ffc53d', 'Amber'], ['#ffe629', 'Yellow'],
  ['#30a46c', 'Green'], ['#12a594', 'Teal'], ['#7ce2fe', 'Sky'], ['#0090ff', 'Blue'],
  ['#3e63dd', 'Indigo'], ['#6e56cf', 'Violet'], ['#d6409f', 'Pink'], ['#8e4ec6', 'Purple'],
]
const SIDEBAR_PRESETS: [hex: string, name: string][] = [
  ['#111827', 'Ink'], ['#1e293b', 'Slate'], ['#1d3a5f', 'Navy'], ['#14532d', 'Forest'], ['#2e1065', 'Plum'],
]
const BG_PRESETS: [hex: string, name: string][] = [
  ['#f5f7fa', 'Cool'], ['#eef2f7', 'Mist'], ['#f8f4ec', 'Sand'], ['#fbfaf6', 'Paper'], ['#ffffff', 'Snow'],
]
const previewVars = (map: Record<string, string>) => {
  const s = document.documentElement.style
  for (const [k, v] of Object.entries(map)) s.setProperty(k, v)
}
/** 与 store apply() 同规则：深底白字、浅底深字 */
const autoFg = (hex: string) => (hexLuminance(hex) > 0.45 ? '#111827' : '#ffffff')

/**
 * 原生取色器防卡顿通道：面板拖动连续发 input——rAF 合帧只走 preview（不入 store、
 * 不落盘、零 React 重渲染），change（面板提交）才 commit 落 store。
 * input 非受控：受控 value 回流会在拖动中重置面板选色，外部变更由 effect 单向同步。
 */
function useColorChannel(ref: RefObject<HTMLInputElement | null>, preview: (hex: string) => void, commit: (hex: string) => void, committedOf: () => string) {
  const fns = useRef({ preview, commit, committedOf })
  fns.current = { preview, commit, committedOf }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    // 面板拖动连续 input 但不提交（ESC/取消关闭）时 preview 变量已成幽灵——
    // cancel 事件回滚 store 真值 + 复位 input.value（否则重开面板显示被放弃的"当前色"）；
    // change（提交）后 dirty 清零，回滚变 no-op
    let dirty = false
    const revert = () => {
      if (!dirty) return
      dirty = false
      el.value = fns.current.committedOf()
      reapplyTheme()
    }
    const onInput = () => {
      dirty = true
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fns.current.preview(el.value))
    }
    const onChange = () => {
      dirty = false
      fns.current.commit(el.value)
    }
    el.addEventListener('input', onInput)
    el.addEventListener('change', onChange)
    el.addEventListener('cancel', revert)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('input', onInput)
      el.removeEventListener('change', onChange)
      el.removeEventListener('cancel', revert)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 事件只绑一次，回调经 fns ref 取最新
  }, [])
}

/** 预设色点：实体圆钮（size-6 好点，触屏升 size-7）；选中=ring+反色对勾（非颜色线索）；「跟随主题」= 斜纹圆点；disabled=原生禁用（pointer-events 挡不住键盘） */
function SwatchDot({ hex, active, title, onClick, disabled }: { hex?: string; active: boolean; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative size-6 shrink-0 rounded-full border transition-transform motion-safe:active:scale-95 pointer-coarse:size-7',
        hex
          ? cn('border-black/10 ring-1 ring-inset ring-black/10 dark:border-white/20 dark:ring-white/25', active && 'ring-2 ring-ring ring-offset-1 ring-offset-card')
          : cn('border-border bg-[linear-gradient(135deg,transparent_44%,var(--muted-foreground)_44%,var(--muted-foreground)_56%,transparent_56%)]', active && 'ring-2 ring-ring'),
      )}
      style={hex ? { background: hex } : undefined}
    >
      {active && hex && <Check className="absolute inset-0 m-auto size-3" style={{ color: autoFg(hex) }} aria-hidden />}
    </button>
  )
}

/** 颜色瓦片：跟随主题点 + 预设色板 + 取色器分隔线 + 原生取色器；右侧常驻回显 hex 或「跟随主题」；disabled=点了无效的场景整块禁用 */
function ColorField({ label, hint, className, presets, value, onPick, preview, disabled }: {
  label: string
  hint?: string
  className?: string
  presets: [hex: string, name: string][]
  value?: string
  onPick: (v: string | undefined) => void
  preview: (hex: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  useColorChannel(ref, preview, v => onPick(v), () => value ?? '#0090ff')
  useEffect(() => {
    if (ref.current && value) ref.current.value = value
  }, [value])
  return (
    <SettingTile
      className={cn('bg-card', disabled && 'opacity-50', className)}
      aria-disabled={disabled || undefined}
      label={
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="font-medium text-foreground/80">{label}</span>
          {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
        </span>
      }
      trailing={
        // mono 只给 hex 值——「跟随主题」是中文，mono 栈无 CJK 字形会回落系统体导致字宽抖
        <span className={cn('shrink-0 text-xs tabular-nums', value ? 'font-mono font-medium text-foreground' : 'text-muted-foreground')}>
          {value ?? t('settings:customFollow')}
        </span>
      }
    >
      <div className={cn('flex flex-wrap items-center gap-2', disabled && 'pointer-events-none')}>
        <SwatchDot active={!value} disabled={disabled} title={`${label} · ${t('settings:customFollow')}`} onClick={() => onPick(undefined)} />
        {presets.map(([hex, name]) => (
          <SwatchDot key={hex} hex={hex} disabled={disabled} active={value?.toLowerCase() === hex} title={`${label} · ${name} ${hex}`} onClick={() => onPick(hex)} />
        ))}
        <span className="mx-0.5 h-6 w-px shrink-0 bg-border" aria-hidden="true" />
        <input
          ref={ref}
          type="color"
          defaultValue="#0090ff"
          aria-label={label}
          title={label}
          disabled={disabled}
          className="size-6 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
        />
      </div>
    </SettingTile>
  )
}

// 未自定义时滑杆停在工程默认值上（Tailwind 基准）；拖回默认 = 该项清零（交还主题）
const RADIUS_DEFAULT = 5
const DENSITY_DEFAULT = 4
// 主题层生效像素(apply() 同步跑过后的 computed;面板随 useTheme 重渲拿到新主题值);
// dist 主题块值为 rem,px/rem 自适应换算
const livePx = (name: string, fallback: number) => {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const v = parseFloat(raw)
  if (!Number.isFinite(v)) return fallback
  if (!raw.endsWith('rem')) return v
  return v * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
}
const FONT_DEFAULT = 100

/** 滑杆瓦片：数值回显常驻右上；覆盖态数字加粗 + 实体「跟随主题」还原钮 */
function SliderField({ label, display, min, max, step, value, overridden, onReset, onChange }: {
  label: string
  display: string
  min: number
  max: number
  step: number
  value: number
  overridden: boolean
  onReset: () => void
  onChange: (v: number) => void
}) {
  const t = useT()
  const resetTitle = `${label} · ${t('settings:resetOne')}`
  return (
    <SettingTile
      className="bg-card"
      label={label}
      trailing={
        <span className="flex items-center gap-1.5">
          <span className={cn('font-mono text-xs tabular-nums', overridden ? 'font-medium text-foreground' : 'text-muted-foreground')}>{display}</span>
          {/* 槽位常驻：还原钮出现/消失不再推挤回显列 */}
          <span className="grid size-6 place-items-center">
            {overridden && (
              <button
                type="button"
                title={resetTitle}
                aria-label={resetTitle}
                onClick={onReset}
                className={cn(FADE, 'grid size-6 place-items-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground')}
              >
                <RotateCcw className="size-3.5" />
              </button>
            )}
          </span>
        </span>
      }
    >
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        thumbAriaLabel={label}
        thumbValueText={display}
      />
    </SettingTile>
  )
}

export function SettingsPage() {
  const t = useT()
  const { lang, setLang } = useLang()
  const { theme, setTheme, resolved, id, setThemeId, custom, setCustom, resetCustom } = useTheme()
  // 未覆盖的滑杆回显主题人格档生效值(锐角/柔圆主题各显示自己的档),拖到同值即清覆盖
  const themeRadiusPx = livePx('--dt-radius-base', RADIUS_DEFAULT)
  const themeDensityPx = livePx('--dt-spacing-scale-default', DENSITY_DEFAULT)
  const themeOpt = THEME_OPTIONS.find(o => o.value === theme)!
  const langOpt = LANGS.find(o => o.value === lang) ?? LANGS[0]
  const overrideCount = Object.keys(custom).length

  // 左侧卡片导航：8 个锚点=8 张设置卡；IO 跟随滚动高亮，点击=平滑滚动+落点闪光
  const sections = [
    { id: 'sec-appearance', label: t('settings:appearance'), icon: Palette },
    { id: 'sec-language', label: t('settings:language'), icon: Languages },
    { id: 'sec-nav', label: t('settings:sidebar'), icon: PanelLeft },
    { id: 'sec-cluster', label: t('settings:cluster'), icon: Boxes },
    { id: 'sec-prom', label: t('settings:promTitle'), icon: Activity },
    { id: 'sec-ai', label: t('settings:aiCard'), icon: Sparkles },
    { id: 'sec-notify', label: t('settings:aiGroupNotify'), icon: BellRing },
    { id: 'sec-about', label: t('settings:about'), icon: Info },
  ]
  const [activeSec, setActiveSec] = useState('sec-appearance')
  // 点击跳转的短暂锁定：贴近页尾的两个锚点（通知/关于）共享同一最大滚动位，
  // 位置无法区分「用户想在哪」——点击意图 1.2s 内说了算，手动滚动即接管
  const spyLock = useRef(0)
  useEffect(() => {
    const order = Array.from(document.querySelectorAll('[data-setting-section]'), el => el.id)
    const scroller = document.querySelector<HTMLElement>('[data-setting-section]')?.closest('.overflow-auto')
    if (!scroller) return
    const spy = () => {
      if (Date.now() < spyLock.current) return
      const port = scroller.getBoundingClientRect()
      const line = port.top + 96
      let current = order[0] ?? ''
      for (const id of order) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= line) current = id
      }
      // 触底=看尾：短尾卡（「关于」）物理上滚不进判定带，取最后一个探出视口底的节
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8) {
        for (const id of [...order].reverse()) {
          const el = document.getElementById(id)
          if (el && el.getBoundingClientRect().top <= port.bottom - 48) {
            current = id
            break
          }
        }
      }
      setActiveSec(prev => (prev === current ? prev : current))
    }
    spy()
    scroller.addEventListener('scroll', spy, { passive: true })
    window.addEventListener('resize', spy)
    return () => {
      scroller.removeEventListener('scroll', spy)
      window.removeEventListener('resize', spy)
    }
  }, [])
  const jump = (sid: string) => {
    const el = document.getElementById(sid)
    if (!el) return
    spyLock.current = Date.now() + 1200
    el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    setActiveSec(sid)
    el.setAttribute('data-flash', '')
    window.setTimeout(() => el.removeAttribute('data-flash'), 600)
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 lg:max-w-4xl">
      <div className="space-y-0.5">
        <h1 className="text-xl font-semibold tracking-tight">{t('settings:title')}</h1>
        <p className="text-xs text-muted-foreground">{t('settings:pageDesc')}</p>
      </div>

      <div className="flex items-start gap-8">
        {/* 窄屏（<lg）单栏时导航收起：卡片本就 2-3 屏，横着挤一排不如不要 */}
        <nav data-slot="settings-nav" aria-label={t('settings:title')} className="sticky top-2 hidden w-44 shrink-0 lg:block">
          <ul className="space-y-1">
            {sections.map(s => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => jump(s.id)}
                  aria-current={activeSec === s.id ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                    activeSec === s.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <s.icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 space-y-6">
      <SectionCard
        id="sec-appearance"
        title={t('settings:appearance')}
        desc={t('settings:appearanceDesc')}
        action={overrideCount > 0 && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="hidden font-mono sm:inline-flex">
              {overrideCount === 1 ? t('settings:customCountOne') : tf('settings:customCount', { n: overrideCount })}
            </Badge>
            <Button variant="outline" size="sm" onClick={resetCustom}>
              <RotateCcw className="size-3.5" />
              {t('settings:customResetAll')}
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          {/* 明暗模式：与其他单行设置同款 SettingRow（左「档位+说明」右 segmented 药丸），不再自造 inset */}
          <SettingRow
            label={t('settings:appearanceMode')}
            hint={t(themeOpt.descKey)}
            control={
              <Segmented
                ariaLabel={t('settings:appearanceMode')}
                value={theme}
                onChange={setTheme}
                options={THEME_OPTIONS.map(o => ({ value: o.value, label: t(o.labelKey), title: t(o.descKey) }))}
              />
            }
          />

          {/* Visual Theme：token 产物驱动的下拉（新增主题只加 token 源）；说明文案随行切换 */}
          <SettingRow
            label={t('settings:themePick')}
            hint={t(`settings:themeNote-${id}`)}
            control={
              <Select value={id} onValueChange={v => setThemeId(v as ThemeId)}>
                <SelectTrigger size="sm" className="w-[9.5rem] shrink-0" aria-label={t('settings:themePick')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {themesMeta.themes.map(th => (
                    <SelectItem key={th.id} value={th.id}>
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="size-3 shrink-0 rounded-full border border-black/10 dark:border-white/20"
                          style={{ background: `linear-gradient(135deg, ${th.swatch.background} 50%, ${th.swatch.primary} 50%)` }}
                        />
                        {th.id.charAt(0).toUpperCase() + th.id.slice(1)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          {/* 用户级自定义：muted inset 面板嵌实体瓦片（覆盖态加粗回显 + 常驻还原钮）；换主题后依然生效 */}
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">{t('settings:customTitle')}</div>
            <div className={cn(INSET, 'grid gap-2 p-3 sm:grid-cols-2')}>
              <SliderField
                label={t('settings:customRadius')}
                display={`${custom.radiusPx ?? themeRadiusPx}px`}
                min={0}
                max={16}
                step={1}
                value={custom.radiusPx ?? themeRadiusPx}
                overridden={custom.radiusPx != null}
                onReset={() => setCustom({ radiusPx: undefined })}
                onChange={v => setCustom({ radiusPx: v === themeRadiusPx ? undefined : v })}
              />
              <SliderField
                label={t('settings:customDensity')}
                display={`${(custom.densityPx ?? themeDensityPx).toFixed(1)}px`}
                min={3}
                max={5}
                step={0.1}
                value={custom.densityPx ?? themeDensityPx}
                overridden={custom.densityPx != null}
                onReset={() => setCustom({ densityPx: undefined })}
                onChange={v => setCustom({ densityPx: v === themeDensityPx ? undefined : v })}
              />
              <SliderField
                label={t('settings:customFontSize')}
                display={`${custom.fontPct ?? FONT_DEFAULT}%`}
                min={88}
                max={116}
                step={2}
                value={custom.fontPct ?? FONT_DEFAULT}
                overridden={custom.fontPct != null}
                onReset={() => setCustom({ fontPct: undefined })}
                onChange={v => setCustom({ fontPct: v === FONT_DEFAULT ? undefined : v })}
              />
              {/* 字重档位：整体平移 400/500/600 三档（覆盖后中英+CJK 同步提重，
                  专治小字号中文回退苹方观感偏浅）；「跟随」= 默认档 */}
              <SettingTile label={t('settings:customFontWeight')} className="bg-card">
                <Segmented
                  ariaLabel={t('settings:customFontWeight')}
                  value={custom.fontW ?? 'default'}
                  onChange={v => setCustom({ fontW: v === 'default' ? undefined : v })}
                  options={[
                    { value: 'boost', label: t('settings:customFontWeightBoost') },
                    { value: 'heavy', label: t('settings:customFontWeightHeavy') },
                    { value: 'default', label: t('settings:customFollow') },
                  ]}
                />
              </SettingTile>
              {/* 阴影档位：覆盖 --dt-shadow-{xs..xl}；「跟随主题」= 主题默认投影 */}
              <SettingTile label={t('settings:customShadow')} className="bg-card">
                <Segmented
                  ariaLabel={t('settings:customShadow')}
                  value={custom.shadow ?? 'default'}
                  onChange={v => setCustom({ shadow: v === 'default' ? undefined : v })}
                  options={[
                    { value: 'none', label: t('settings:customShadowNone') },
                    { value: 'soft', label: t('settings:customShadowSoft') },
                    { value: 'default', label: t('settings:customFollow') },
                  ]}
                />
              </SettingTile>
              <ColorField
                label={t('settings:customAccent')}
                className="sm:col-span-2"
                presets={ACCENT_PRESETS}
                value={custom.accent}
                onPick={v => setCustom({ accent: v })}
                preview={hex => previewVars({ '--dt-color-primary-default': hex, '--dt-color-border-ring': hex, '--dt-color-primary-foreground': autoFg(hex) })}
              />
              <ColorField
                label={t('settings:customSidebar')}
                presets={SIDEBAR_PRESETS}
                value={custom.sidebar}
                onPick={v => setCustom({ sidebar: v })}
                preview={hex => previewVars({ '--dt-color-navigation-sidebar': hex, '--dt-color-navigation-sidebar-foreground': autoFg(hex) })}
              />
              <ColorField
                label={t('settings:customBg')}
                hint={t('settings:customBgLightOnly')}
                presets={BG_PRESETS}
                value={custom.bgBase}
                onPick={v => setCustom({ bgBase: v })}
                preview={hex => previewVars({ '--dt-color-background-default': hex })}
                disabled={resolved === 'dark'}
              />
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard id="sec-language" title={t('settings:language')}>
        {/* 两档选项不做下拉，与明暗模式同交互（分段即切换） */}
        <SettingRow
          label={t('settings:language')}
          hint={t(langOpt.descKey)}
          control={
            <Segmented
              ariaLabel={t('settings:language')}
              value={lang}
              onChange={setLang}
              options={LANGS.map(o => ({ value: o.value, label: o.label }))}
            />
          }
        />
      </SectionCard>

      <NavSettingsCard id="sec-nav" />

      <ClusterSettingsCard id="sec-cluster" />

      <PromSettingsCard id="sec-prom" />

      <AIServiceCard />

      <SectionCard id="sec-about" title={t('settings:about')} desc={t('settings:aboutDesc')}>
        <div className="divide-y divide-border text-[13px]">
          <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
            <span className="text-muted-foreground">{t('settings:frontendVersion')}</span>
            <span className="font-mono">v{WEB_VERSION}</span>
          </div>
          <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
            <span className="text-muted-foreground">{t('settings:project')}</span>
            <span>{t('settings:aboutProjectValue')}</span>
          </div>
        </div>
      </SectionCard>
        </div>
      </div>
    </div>
  )
}
