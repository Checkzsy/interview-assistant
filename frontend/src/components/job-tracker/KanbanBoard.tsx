import { useCallback, useMemo, useRef, useState, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  closestCenter,
  defaultDropAnimationSideEffects,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import dayjs from 'dayjs'
import {
  Building2,
  Briefcase,
  MapPin,
  Calendar,
  GripVertical,
  LayoutGrid,
  ChevronLeft,
  ChevronRight,
  Inbox,
  ArrowRight,
  MessageSquareText,
  Trash2,
} from 'lucide-react'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'
import { isLightColorScheme } from '@/lib/colorScheme'
import DeleteApplicationDialog from './DeleteApplicationDialog'
import type { Application } from './types'
import { filterApplicationsBySearch } from './search'
import {
  STAGE_LABELS,
  STAGE_COLUMN_ORDER,
  STAGE_HEADER_ICON,
  STAGE_EMOJI,
  ONGOING_STAGES,
  TERMINAL_STAGES,
  getStageColumnStage,
  getStageTheme,
  getCardLeftBorder,
  isRejectedStage,
  isTerminalStage,
  nextStageAfter,
} from './stageConfig'

const dropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0.5' } },
  }),
}

function sortAppsInColumn(apps: Application[]): Application[] {
  return [...apps].sort((a, b) => {
    const so = (a.sort_order ?? 0) - (b.sort_order ?? 0)
    if (so !== 0) return so
    const fa = a.next_followup_at
    const fb = b.next_followup_at
    if (fa == null && fb == null) return a.id - b.id
    if (fa == null) return 1
    if (fb == null) return -1
    return fa - fb
  })
}

function buildColumnIds(apps: Application[], visibleStages: string[]): Record<string, number[]> {
  const byStage = new Map<string, Application[]>()
  for (const s of STAGE_COLUMN_ORDER) byStage.set(s, [])
  for (const a of apps) {
    const k = getStageColumnStage(a.stage)
    byStage.get(k)!.push(a)
  }
  const out: Record<string, number[]> = {}
  for (const s of visibleStages) {
    out[s] = sortAppsInColumn(byStage.get(s) ?? []).map((x) => x.id)
  }
  return out
}

function linkedReviewCount(summary: Application['review_summary'] | null | undefined): number {
  return Number(summary?.linked_review_count ?? summary?.review_count ?? 0)
}

function latestLinkedReviewAt(summary: Application['review_summary'] | null | undefined): number | null {
  return summary?.latest_linked_review_at ?? summary?.latest_review_at ?? null
}

function reviewBadgeLabel(summary: Application['review_summary']): string {
  const linkedCount = linkedReviewCount(summary)
  const shortCount = Math.max(0, linkedCount - summary.review_count)
  if (summary.review_count <= 0) {
    return linkedCount > 1 ? `短样本 ${linkedCount}` : '短样本'
  }
  return shortCount > 0 ? `${summary.review_count} +${shortCount} 短` : String(summary.review_count)
}

const RAIL_LABEL: Record<string, string> = {
  applied: '\u6295\u9012',
  written: '\u6D4B\u8BC4',
  interview1: '\u4E00\u9762',
  interview2: '\u4E8C\u9762',
  interview3: '\u4E09\u9762',
  hr: 'HR\u9762',
  offer: 'Offer',
  rejected: '\u6302\u4E86',
  withdrawn: '\u5F03',
}

function StageSelect({
  value,
  disabled,
  isLight,
  onChange,
}: {
  value: string
  disabled?: boolean
  isLight: boolean
  onChange: (stage: string) => void
}) {
  return (
    <select
      className={`mt-2 w-full max-w-full rounded-xl border px-2.5 py-1.5 text-[11px] font-medium outline-none transition-all duration-200 cursor-pointer ${
        isLight
          ? 'border-gray-200/90 bg-white text-gray-800 hover:border-gray-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 shadow-sm'
          : 'border-white/[0.08] bg-black/25 text-text-primary hover:border-white/20 focus:border-accent-blue/50 focus:ring-2 focus:ring-accent-blue/20 shadow-sm'
      }`}
      value={value}
      disabled={disabled}
      aria-label="阶段"
      onChange={(e) => onChange(e.target.value)}
    >
      <optgroup label="进行中">
        {ONGOING_STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_EMOJI[s]} {STAGE_LABELS[s] ?? s}
          </option>
        ))}
      </optgroup>
      <optgroup label="已结束">
        {TERMINAL_STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_EMOJI[s]} {STAGE_LABELS[s] ?? s}
          </option>
        ))}
      </optgroup>
    </select>
  )
}

function SortableKanbanCard({
  app,
  isLight,
  sortDisabled,
  busy,
  onStageChange,
  onRequestDelete,
  index,
}: {
  app: Application
  isLight: boolean
  sortDisabled: boolean
  busy: boolean
  onStageChange: (id: number, stage: string) => void
  onRequestDelete: (app: Application) => void
  index: number
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: app.id,
    disabled: sortDisabled || busy,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    animationDelay: `${index * 30}ms`,
  }
  const fu = app.next_followup_at
  const leftBorder = getCardLeftBorder(app.stage, isLight)
  const theme = getStageTheme(app.stage, isLight)
  const nextStage = nextStageAfter(app.stage)
  const reviewSummary = app.review_summary
  const reviewScore = reviewSummary?.latest_avg_score
  const linkedReviews = linkedReviewCount(reviewSummary)
  const terminalStage = isTerminalStage(app.stage)
  const rejectedStage = isRejectedStage(app.stage)
  const timeBadgeLabel = terminalStage
    ? latestLinkedReviewAt(reviewSummary) != null
      ? `复盘 ${dayjs.unix(Math.floor(latestLinkedReviewAt(reviewSummary) as number)).format('M/D')}`
      : rejectedStage
        ? STAGE_LABELS[app.stage] ?? app.stage
        : '已放弃'
    : fu != null
      ? dayjs.unix(Math.floor(fu)).format('M/D')
      : null
  const timeBadgeClass = terminalStage
    ? rejectedStage
      ? isLight
        ? 'bg-red-50 text-red-700 border border-red-200'
        : 'bg-red-500/15 text-red-200'
      : isLight
        ? 'bg-zinc-100 text-zinc-600 border border-zinc-200'
        : 'bg-white/[0.06] text-text-muted'
    : isLight
      ? 'bg-amber-50 text-amber-700 border border-amber-200'
      : 'bg-amber-500/15 text-amber-100/90'

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        kanban-card rounded-xl border pl-2.5 pr-3 py-2.5 border-l-[3.5px] group/card shadow-sm hover:shadow-md transition-all duration-200
        ${leftBorder}
        ${isLight
          ? 'border-gray-200/80 bg-white hover:border-gray-300/90'
          : 'border-white/[0.08] bg-bg-secondary/90 hover:border-white/15'
        }
        ${busy ? 'opacity-50 pointer-events-none' : ''}
        ${isDragging ? 'opacity-40 ring-2 ring-accent-blue/40 scale-[1.02] shadow-xl' : ''}
      `}
    >
      <div className="flex gap-2">
        <button
          type="button"
          className={`
            mt-0.5 flex h-8 w-7 shrink-0 items-center justify-center self-start rounded-lg
            touch-none cursor-grab active:cursor-grabbing outline-none transition-all duration-150 active:scale-90
            ${sortDisabled || busy ? 'cursor-not-allowed opacity-30' : ''}
            ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-text-muted/60 hover:bg-white/[0.06] hover:text-text-primary'}
          `}
          aria-label="拖动排序"
          disabled={sortDisabled || busy}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="w-4 h-4" strokeWidth={2} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${theme.iconBg} ${theme.iconText}`}
            >
              <Building2 className="w-4 h-4" strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-[13px] font-semibold leading-snug line-clamp-2 ${isLight ? 'text-gray-900' : 'text-text-primary'}`}>
                {app.company}
              </p>
              <p className={`mt-0.5 flex items-start gap-1 text-[11px] ${isLight ? 'text-gray-500' : 'text-text-secondary'}`}>
                <Briefcase className="w-3 h-3 mt-0.5 shrink-0 opacity-60" />
                <span className="line-clamp-2">{app.position || '\u5C97\u4F4D'}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-1.5 pl-[2.5rem] flex-wrap">
            {app.city ? (
              <span className={`inline-flex items-center gap-1 text-[10px] ${isLight ? 'text-gray-400' : 'text-text-muted'}`}>
                <MapPin className="w-3 h-3 shrink-0 opacity-70" />
                {app.city}
              </span>
            ) : null}
            {timeBadgeLabel ? (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${timeBadgeClass}`}
              >
                <Calendar className="w-3 h-3 opacity-80" />
                {timeBadgeLabel}
              </span>
            ) : null}
            {linkedReviews > 0 ? (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                  reviewSummary.review_count <= 0
                    ? 'bg-amber-500/15 text-amber-500'
                    : reviewScore == null
                    ? isLight ? 'bg-gray-100 text-gray-500' : 'bg-white/[0.06] text-text-muted'
                    : reviewScore < 6
                      ? 'bg-yellow-500/15 text-yellow-500'
                      : reviewScore >= 8
                        ? 'bg-green-500/15 text-green-500'
                        : 'bg-blue-500/15 text-blue-500'
                }`}
              >
                <MessageSquareText className="w-3 h-3 opacity-80" />
                复盘 {reviewBadgeLabel(reviewSummary)}{reviewScore != null && reviewSummary.review_count > 0 ? ` · ${reviewScore.toFixed(1)}` : ''}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5 mt-2 pl-[2.5rem]">
            <StageSelect
              value={app.stage}
              isLight={isLight}
              disabled={busy}
              onChange={(st) => onStageChange(app.id, st)}
            />
            {nextStage && !busy && (
              <button
                type="button"
                title={`\u79FB\u81F3 ${STAGE_LABELS[nextStage]}`}
                onClick={() => onStageChange(app.id, nextStage)}
                className={`mt-2 inline-flex h-[30px] shrink-0 items-center justify-center gap-1 rounded-xl border px-2.5 transition-all duration-150 active:scale-95 shadow-sm ${
                  isLight
                    ? 'border-blue-200/80 bg-blue-50/80 text-blue-600 hover:bg-blue-100 hover:border-blue-300'
                    : 'border-accent-blue/30 bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 hover:border-accent-blue/40'
                }`}
              >
                <ArrowRight className="w-3.5 h-3.5" />
                <span className="text-[10px] font-medium">推进</span>
              </button>
            )}
            <button
              type="button"
              title={`删除 ${app.company}`}
              aria-label={`删除 ${app.company}`}
              disabled={busy}
              onClick={() => onRequestDelete(app)}
              className={`mt-2 inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl border transition-all duration-150 active:scale-90 shadow-sm disabled:opacity-40 ${
                isLight
                  ? 'border-gray-200/80 bg-gray-50/80 text-gray-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600'
                  : 'border-white/10 bg-white/[0.04] text-text-muted hover:border-accent-red/30 hover:bg-accent-red/15 hover:text-accent-red'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function KanbanColumn({
  stage,
  appMap,
  ids,
  isLight,
  sortDisabled,
  busyId,
  onStageChange,
  onRequestDelete,
}: {
  stage: string
  appMap: Map<number, Application>
  ids: number[]
  isLight: boolean
  sortDisabled: boolean
  busyId: number | null
  onStageChange: (id: number, stage: string) => void
  onRequestDelete: (app: Application) => void
}) {
  const Icon = STAGE_HEADER_ICON[stage] ?? LayoutGrid
  const theme = getStageTheme(stage, isLight)
  const list = useMemo(
    () => ids.map((id) => appMap.get(id)).filter(Boolean) as Application[],
    [ids, appMap],
  )

  return (
    <div
      data-kanban-stage={stage}
      className={`
        flex w-[min(100vw-2rem,280px)] shrink-0 snap-start flex-col rounded-2xl border overflow-hidden shadow-sm
        min-h-[min(480px,60vh)] max-h-[calc(100vh-200px)]
        ${isLight
          ? 'border-gray-200/90 bg-gray-50/70'
          : 'border-white/[0.08] bg-bg-secondary/40 backdrop-blur-sm'
        }
      `}
    >
      {/* Stage color bar */}
      <div className={`h-1.5 w-full shrink-0 ${theme.dotColor}`} />

      {/* Column header */}
      <div
        className={`flex items-center gap-2.5 border-b px-3.5 py-2.5 shrink-0 backdrop-blur-md ${
          isLight ? 'border-gray-200/80 bg-white/70' : 'border-white/[0.06] bg-black/15'
        }`}
      >
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-xl transition-transform ${theme.iconBg}`}
        >
          <Icon className={`w-[18px] h-[18px] ${theme.iconText}`} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className={`truncate text-xs font-bold tracking-tight ${isLight ? 'text-gray-800' : 'text-text-primary'}`}>
            <span>{STAGE_LABELS[stage] ?? stage}</span>
          </h3>
          <p className={`text-[10px] mt-0.5 ${isLight ? 'text-gray-400' : 'text-text-muted'}`}>
            {list.length} 条记录
          </p>
        </div>
        <span
          className={`flex h-6 min-w-[1.5rem] items-center justify-center rounded-full px-2 text-[10px] font-bold shadow-sm ${
            list.length > 0
              ? `${theme.iconBg} ${theme.iconText}`
              : isLight
                ? 'bg-gray-200 text-gray-400'
                : 'bg-white/[0.06] text-text-muted/50'
          }`}
        >
          {list.length}
        </span>
      </div>

      {/* Cards */}
      <div data-kanban-column-scroll className="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5 [scrollbar-width:thin]">
        <SortableContext items={list.map((a) => a.id)} strategy={verticalListSortingStrategy} id={stage}>
          {list.map((app, i) => (
            <SortableKanbanCard
              key={app.id}
              app={app}
              isLight={isLight}
              sortDisabled={sortDisabled}
              busy={busyId === app.id}
              onStageChange={onStageChange}
              onRequestDelete={onRequestDelete}
              index={i}
            />
          ))}
        </SortableContext>
        {list.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
            <div className={`rounded-lg p-3 ${isLight ? 'bg-gray-100' : 'bg-white/[0.03]'}`}>
              <Inbox className={`w-8 h-8 ${isLight ? 'text-gray-300' : 'text-text-muted/30'}`} strokeWidth={1.5} />
            </div>
            <p className={`text-[11px] ${isLight ? 'text-gray-400' : 'text-text-muted/60'}`}>{'\u65E0\u5339\u914D\u8BB0\u5F55'}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function CardPreview({ app, isLight }: { app: Application; isLight: boolean }) {
  const leftBorder = getCardLeftBorder(app.stage, isLight)
  const theme = getStageTheme(app.stage, isLight)
  return (
    <div
      className={`
        w-[260px] cursor-grabbing rounded-xl border border-l-[3.5px] px-3.5 py-2.5 shadow-2xl
        ${leftBorder}
        ${isLight ? 'border-gray-200/90 bg-white' : 'border-white/20 bg-bg-secondary/95'}
      `}
    >
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-lg ${theme.iconBg}`}>
          <Building2 className={`w-3 h-3 ${theme.iconText}`} />
        </span>
        <p className={`text-[13px] font-semibold line-clamp-1 ${isLight ? 'text-gray-900' : 'text-text-primary'}`}>{app.company}</p>
      </div>
      <p className={`mt-1 text-[11px] line-clamp-1 ${isLight ? 'text-gray-500' : 'text-text-secondary'}`}>{app.position || '\u5C97\u4F4D'}</p>
    </div>
  )
}

type Props = {
  applications: Application[]
  onStageChange: (appId: number, stage: string) => void | Promise<void>
  onReorderInStage: (stage: string, orderedIds: number[]) => void | Promise<void>
  onDelete: (appId: number) => void | Promise<void>
  search: string
  showTerminalStages: boolean
  onShowTerminalStagesChange: (show: boolean) => void
  terminalApplicationsCount: number
}

export default function KanbanBoard({
  applications,
  onStageChange,
  onReorderInStage,
  onDelete,
  search,
  showTerminalStages,
  onShowTerminalStagesChange,
  terminalApplicationsCount,
}: Props) {
  const colorScheme = useUiPrefsStore((s) => s.colorScheme)
  const isLight = isLightColorScheme(colorScheme)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const movingRef = useRef<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null)

  const visibleStages = useMemo(
    () => (showTerminalStages ? [...STAGE_COLUMN_ORDER] : [...ONGOING_STAGES]),
    [showTerminalStages],
  )

  const filteredApps = useMemo(() => filterApplicationsBySearch(applications, search), [applications, search])
  const sortDisabled = search.trim().length > 0

  const fullColumnIds = useMemo(
    () => buildColumnIds(applications, visibleStages),
    [applications, visibleStages],
  )
  const displayColumnIds = useMemo(
    () => (sortDisabled ? buildColumnIds(filteredApps, visibleStages) : fullColumnIds),
    [sortDisabled, filteredApps, visibleStages, fullColumnIds],
  )

  const appMap = useMemo(() => new Map(applications.map((a) => [a.id, a])), [applications])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleStageSelect = useCallback(
    async (id: number, stage: string) => {
      const app = applications.find((x) => x.id === id)
      if (!app || app.stage === stage || movingRef.current != null) return
      movingRef.current = id
      setBusyId(id)
      try {
        await Promise.resolve(onStageChange(id, stage))
      } finally {
        movingRef.current = null
        setBusyId(null)
      }
    },
    [applications, onStageChange],
  )

  const confirmDelete = useCallback(() => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (target) void Promise.resolve(onDelete(target.id))
  }, [deleteTarget, onDelete])

  const handleDragStart = (e: DragStartEvent) => {
    setActiveId(Number(e.active.id))
  }

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    setActiveId(null)
    if (sortDisabled || !over) return
    const a = Number(active.id)
    const o = Number(over.id)
    if (a === o) return
    const stage = visibleStages.find((s) => fullColumnIds[s]?.includes(a))
    if (!stage) return
    const list = fullColumnIds[stage]
    if (!list.includes(o)) return
    const oldIndex = list.indexOf(a)
    const newIndex = list.indexOf(o)
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return
    const next = arrayMove(list, oldIndex, newIndex)
    void onReorderInStage(stage, next)
  }

  const scrollBy = (dx: number) => scrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' })

  const handleBoardWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.shiftKey || event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    const board = scrollRef.current
    if (!board || board.scrollWidth <= board.clientWidth) return

    const target = event.target instanceof HTMLElement ? event.target : null
    const columnScroller = target?.closest('[data-kanban-column-scroll]') as HTMLElement | null
    if (columnScroller && columnScroller.scrollHeight > columnScroller.clientHeight) {
      const canScrollDown = event.deltaY > 0 && columnScroller.scrollTop + columnScroller.clientHeight < columnScroller.scrollHeight - 1
      const canScrollUp = event.deltaY < 0 && columnScroller.scrollTop > 0
      if (canScrollDown || canScrollUp) return
    }

    event.preventDefault()
    board.scrollLeft += event.deltaY
  }, [])

  const scrollToStage = (stage: string) => {
    const run = () =>
      document.querySelector(`[data-kanban-stage="${stage}"]`)?.scrollIntoView({
        behavior: 'smooth',
        inline: 'nearest',
        block: 'nearest',
      })
    if (!(visibleStages as readonly string[]).includes(stage)) {
      onShowTerminalStagesChange(true)
      requestAnimationFrame(() => requestAnimationFrame(run))
      return
    }
    run()
  }

  const activeApp = activeId != null ? appMap.get(activeId) : undefined

  const totalApps = applications.length

  return (
    <div
      className={`flex h-full min-h-0 gap-3.5 rounded-2xl border p-3.5 md:p-5 shadow-sm transition-colors ${
        isLight ? 'border-gray-200/90 bg-white/70 backdrop-blur-md' : 'border-white/[0.07] bg-bg-primary/50 backdrop-blur-md'
      }`}
    >
      <DeleteApplicationDialog
        target={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />

      {/* Left stage rail (desktop) */}
      <nav
        className={`hidden w-14 shrink-0 flex-col gap-1 md:flex ${
          isLight ? 'border-r border-gray-200 pr-2' : 'border-r border-white/[0.06] pr-2'
        }`}
        aria-label="阶段导航"
      >
        {visibleStages.map((st) => {
          const Icon = STAGE_HEADER_ICON[st] ?? LayoutGrid
          const n = displayColumnIds[st]?.length ?? 0
          const theme = getStageTheme(st, isLight)
          return (
            <button
              key={st}
              type="button"
              title={`${STAGE_LABELS[st] ?? st}\uFF08${n}\uFF09`}
              onClick={() => scrollToStage(st)}
              className={`
                relative flex flex-col items-center gap-0.5 rounded-xl py-2 text-[9px] font-bold transition-all duration-150 active:scale-90 hover:scale-[1.04]
                ${isLight
                  ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700'
                  : 'text-text-muted/70 hover:bg-white/[0.06] hover:text-text-primary'
                }
              `}
            >
              <Icon className={`w-4 h-4 opacity-90 ${n > 0 ? theme.iconText : ''}`} strokeWidth={2} />
              <span className="scale-90">{RAIL_LABEL[st] ?? st.slice(0, 1)}</span>
              {n > 0 ? (
                <span
                  className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[9px] font-bold ${theme.dotColor} text-white shadow-sm`}
                >
                  {n > 99 ? '99+' : n}
                </span>
              ) : null}
            </button>
          )
        })}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-xl shadow-sm ${
                isLight ? 'bg-blue-500/10 text-blue-600' : 'bg-violet-500/20 text-violet-200'
              }`}
            >
              <LayoutGrid className="w-5 h-5" strokeWidth={2} />
            </div>
            <div>
              <h2 className={`text-sm font-bold tracking-tight ${isLight ? 'text-gray-800' : 'text-text-primary'}`}>
                求职管道
              </h2>
              <p className={`text-[10px] mt-0.5 ${isLight ? 'text-gray-400' : 'text-text-muted'}`}>
                {totalApps} 条 · {sortDisabled ? '搜索中' : '可排序'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!showTerminalStages && terminalApplicationsCount > 0 ? (
              <button
                type="button"
                onClick={() => onShowTerminalStagesChange(true)}
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ring-1 transition-all duration-150 active:scale-95 shadow-sm ${
                  isLight
                    ? 'bg-red-50 text-red-600 ring-red-200 hover:bg-red-100'
                    : 'bg-red-500/15 text-red-200 ring-red-400/25 hover:bg-red-500/25'
                }`}
              >
                {terminalApplicationsCount} 条在已结束 · 展开
              </button>
            ) : null}
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] font-medium transition-all duration-150 active:scale-95 ${
                isLight
                  ? 'border-gray-200 bg-white hover:bg-gray-50'
                  : 'border-white/[0.08] bg-black/20 hover:bg-white/[0.04]'
              }`}
            >
              <input
                type="checkbox"
                className="rounded border-bg-hover text-accent-blue focus:ring-accent-blue/30"
                checked={showTerminalStages}
                onChange={(e) => onShowTerminalStagesChange(e.target.checked)}
              />
              显示已结束
            </label>
            <div className={`flex rounded-xl border p-0.5 shadow-sm ${isLight ? 'border-gray-200 bg-white/70' : 'border-bg-hover bg-bg-secondary/40'}`}>
              <button
                type="button"
                aria-label="向左"
                className={`rounded-lg p-1.5 transition-all duration-150 active:scale-90 ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-text-muted hover:bg-bg-hover hover:text-text-primary'}`}
                onClick={() => scrollBy(-320)}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                aria-label="向右"
                className={`rounded-lg p-1.5 transition-all duration-150 active:scale-90 ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700' : 'text-text-muted hover:bg-bg-hover hover:text-text-primary'}`}
                onClick={() => scrollBy(320)}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Mobile stage tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 md:hidden [scrollbar-width:none]">
          {visibleStages.map((st) => {
            const n = displayColumnIds[st]?.length ?? 0
            const theme = getStageTheme(st, isLight)
            return (
              <button
                key={st}
                type="button"
                onClick={() => scrollToStage(st)}
                className={`shrink-0 rounded-xl px-3 py-1.5 text-[10px] font-semibold whitespace-nowrap flex items-center gap-1.5 transition-all duration-150 active:scale-95 shadow-sm ${
                  isLight
                    ? 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
                    : 'bg-white/[0.06] border border-white/10 text-text-muted hover:border-white/20'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${theme.dotColor}`} />
                {RAIL_LABEL[st]}
                {n > 0 && <span className="opacity-60">{n}</span>}
              </button>
            )
          })}
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div
            ref={scrollRef}
            data-kanban-board-scroll
            onWheel={handleBoardWheel}
            className="flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden pb-1 scroll-smooth snap-x snap-mandatory [scrollbar-width:thin]"
          >
            {visibleStages.map((stage) => (
              <KanbanColumn
                key={stage}
                stage={stage}
                appMap={appMap}
                ids={displayColumnIds[stage] ?? []}
                isLight={isLight}
                sortDisabled={sortDisabled}
                busyId={busyId}
                onStageChange={handleStageSelect}
                onRequestDelete={setDeleteTarget}
              />
            ))}
          </div>
          {/* portal 到 body：DragOverlay 是 fixed 定位并按视口坐标计算，
              而本组件根节点的 backdrop-blur 会成为其 containing block，
              不 portal 则拖拽预览会整体偏移一个看板位移量。 */}
          {createPortal(
            <DragOverlay dropAnimation={dropAnimation}>
              {activeApp ? <CardPreview app={activeApp} isLight={isLight} /> : null}
            </DragOverlay>,
            document.body,
          )}
        </DndContext>
      </div>
    </div>
  )
}
