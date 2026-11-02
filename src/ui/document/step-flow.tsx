'use client'

import '@xyflow/react/dist/base.css'
import { Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { Ellipsis, Maximize, Minus, Plus, Sparkles } from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { cn } from '../cn'
import { Button } from '../form/button'
import { StateLine } from '../request-view/status'
import { ButtonGroup } from '../shadcn/button-group'
import { Button as IconButton } from '../shadcn/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../shadcn/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../shadcn/tooltip'
import { StatusBadge } from './badges'
import { useDecisionLink } from './decision-link'
import { Stamp, type StepCardView } from './step-cards'
import { BOX_WIDTH, boxesOf, CANVAS_PAD, canvasHeight, linesOf, placeBoxes, startView, type FlowBox } from './step-flow-layout'

// The route of a document as a map of boxes on a computer's screen (FR-INT-012 AC3 · ADR-076): a box per step, reviewers
// and committees fanned out one box per slot, on a canvas that is dragged and zoomed. It shows the record and changes
// nothing on it — boxes cannot be moved or joined (NG-4) — and it carries the same words as the cards phones get. Pressing
// a box opens the step's panel. The box of the reader's own open task also has the decide buttons (ADR-076), which open
// the decision bar's confirmation (decision-link.tsx). The wheel keeps scrolling the page; Ctrl and the wheel, a pinch and
// the buttons zoom. This file and @xyflow/react load only on a wide screen (step-route.tsx), never on a LIFF page (ADR-052).

export interface StepFlowLabels {
  readonly list: string
  readonly open: string
  readonly zoomIn: string
  readonly zoomOut: string
  readonly fit: string
}

type BoxNode = Node<{ readonly box: FlowBox }, 'box'>

const MIN_ZOOM = 0.5
const MAX_ZOOM = 1.5

const Opening = createContext<{ readonly open: (key: string) => void; readonly openLabel: string; readonly briefLink: string | null } | null>(null)

const hiddenHandle = { opacity: 0, minWidth: 0, minHeight: 0, width: 1, height: 1, border: 0 } as const

const frameOf = (step: StepCardView, slotOpen: boolean | null) => {
  const current = slotOpen ?? step.current
  if (current) return cn('border-2', step.overdue ? 'border-danger' : 'border-primary')
  if (step.stamp && step.stampTone) return { ok: 'border-primary', warn: 'border-warn', danger: 'border-danger' }[step.stampTone]
  return 'border-line'
}

/** The heading is the button, stretched over the box as on the cards; the decide buttons sit above it */
function BoxTitle({ title, stepKey }: { title: string; stepKey: string }) {
  const opening = useContext(Opening)
  return (
    <h3 className="min-w-0 font-semibold text-ink">
      <button type="button" onClick={() => opening?.open(stepKey)} aria-haspopup="dialog" className="cursor-pointer text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
        {title}
        <span className="sr-only"> — {opening?.openLabel}</span>
      </button>
    </h3>
  )
}

/** The name read out says which step it decides, since the decision bar has a button of the same word */
function DecideButtons({ title }: { title: string }) {
  const commands = useDecisionLink()?.commands
  if (!commands) return null
  return (
    <div className="nodrag nopan relative z-10 mt-2 flex gap-2" data-box-decide="">
      <Button onClick={commands.approve} aria-label={`${commands.approveLabel} ${title}`} className="flex-1">
        {commands.approveLabel}
      </Button>
      {/* modal={false}: the menu hands over to the bar's dialog, which holds the page itself */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" aria-label={commands.moreLabel} className="px-3">
            <Ellipsis aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {commands.others.map((other) => (
              <DropdownMenuItem key={other.key} variant={other.key === 'REJECT' ? 'destructive' : 'default'} onSelect={() => commands.open(other.key)}>
                {other.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Under the decide buttons: where the AI's summary for this decision is, when there is one (FR-AI-301) */
function BriefLink() {
  const label = useContext(Opening)?.briefLink
  if (!label) return null
  return (
    <a href="#ai-brief-title" className="nodrag nopan relative z-10 mt-1 inline-flex min-h-8 items-center gap-1 self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
      <Sparkles aria-hidden="true" className="size-4 text-info" />
      {label}
    </a>
  )
}

function Frame({ className, current, children }: { className: string; current?: boolean; children: ReactNode }) {
  return (
    <div
      role="listitem"
      aria-current={current ? 'step' : undefined}
      data-step-card=""
      style={{ width: BOX_WIDTH }}
      className={cn('pointer-events-auto relative flex flex-col gap-0.5 rounded-md border bg-bg p-3 has-focus-visible:ring-2 has-focus-visible:ring-focus has-focus-visible:ring-offset-2', className)}
    >
      {children}
    </div>
  )
}

function StepBox({ step }: { step: StepCardView }) {
  return (
    <Frame className={frameOf(step, null)} current={step.current}>
      <StatusBadge look={step.badge.look} label={step.badge.label} className="self-start" />
      <BoxTitle title={step.title} stepKey={step.key} />
      {step.people.map((p) => (
        <p key={p} className="break-words text-ink">
          {p}
        </p>
      ))}
      {(step.notes ?? []).map((n) => (
        <p key={n} className="text-ink-muted">
          {n}
        </p>
      ))}
      {step.due ? <p className={cn('tabular', step.overdue ? 'font-medium text-danger' : 'text-ink-muted')}>{step.due}</p> : null}
      {step.sla ? <p className="tabular text-ink-muted">{step.sla}</p> : null}
      {step.stamp ? <Stamp stamp={step.stamp} /> : null}
      {step.mine ? <DecideButtons title={step.title} /> : null}
      {step.mine ? <BriefLink /> : null}
    </Frame>
  )
}

/** The label over a step's slots: the step, how far it is, and its time */
function GroupLabel({ step }: { step: StepCardView }) {
  return (
    <div
      role="listitem"
      aria-current={step.current ? 'step' : undefined}
      style={{ width: BOX_WIDTH }}
      className="pointer-events-auto relative flex flex-col gap-0.5 rounded-md p-1 has-focus-visible:ring-2 has-focus-visible:ring-focus has-focus-visible:ring-offset-2"
    >
      <StatusBadge look={step.badge.look} label={step.badge.label} className="self-start" />
      <BoxTitle title={step.title} stepKey={step.key} />
      {step.progress ? <p className="text-ink-muted">{step.progress}</p> : null}
      {(step.notes ?? []).map((n) => (
        <p key={n} className="text-ink-muted">
          {n}
        </p>
      ))}
      {step.due ? <p className={cn('tabular', step.overdue ? 'font-medium text-danger' : 'text-ink-muted')}>{step.due}</p> : null}
    </div>
  )
}

function SlotBox({ step, slot }: { step: StepCardView; slot: NonNullable<StepCardView['slots']>[number] }) {
  const open = step.current && (slot.state.kind === 'waiting' || slot.state.kind === 'question')
  const settled = { done: 'border-primary', returned: 'border-warn', rejected: 'border-danger' } as const
  const frame = open ? frameOf(step, true) : (settled[slot.state.kind as keyof typeof settled] ?? 'border-line')
  return (
    <Frame className={frame}>
      <StateLine kind={slot.state.kind}>{slot.state.text}</StateLine>
      <BoxTitle title={slot.role ?? slot.who} stepKey={step.key} />
      {slot.role ? <p className="break-words text-ink">{slot.who}</p> : null}
      {slot.rules ? <p className="text-ink-muted">{slot.rules}</p> : null}
      {slot.decided ? <p className="tabular text-ink-muted">{slot.decided}</p> : null}
      {slot.mine ? <DecideButtons title={slot.role ?? slot.who} /> : null}
      {slot.mine ? <BriefLink /> : null}
    </Frame>
  )
}

function BoxView({ data: { box } }: NodeProps<BoxNode>) {
  const joined = box.kind !== 'GROUP'
  return (
    <>
      {joined ? <Handle type="target" position={Position.Left} isConnectable={false} style={hiddenHandle} /> : null}
      {box.kind === 'STEP' ? <StepBox step={box.step} /> : null}
      {box.kind === 'GROUP' ? <GroupLabel step={box.step} /> : null}
      {box.kind === 'SLOT' ? <SlotBox step={box.step} slot={box.slot} /> : null}
      {box.kind === 'NEXT' ? (
        <div role="listitem" style={{ width: BOX_WIDTH }} className="pointer-events-auto rounded-md border border-dashed border-line-strong bg-bg p-3 text-ink-muted">
          {box.text}
        </div>
      ) : null}
      {joined && box.kind !== 'NEXT' ? <Handle type="source" position={Position.Right} isConnectable={false} style={hiddenHandle} /> : null}
    </>
  )
}

const NODE_TYPES = { box: BoxView }

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton variant="outline" size="icon-lg" aria-label={label} onClick={onClick} className="bg-bg">
          {children}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}

function Canvas({ steps, next, labels }: { steps: readonly StepCardView[]; next?: string; labels: StepFlowLabels }) {
  // Worked out once: the provider above starts this canvas again when the route says something new, and a refresh that
  // brings the same route keeps where the reader dragged and zoomed to
  const [boxes] = useState(() => boxesOf(steps, next))
  const [nodes, setNodes, onNodesChange] = useNodesState<BoxNode>(boxes.map((box) => ({ id: box.id, type: 'box', position: { x: 0, y: 0 }, data: { box }, domAttributes: { 'aria-roledescription': undefined } })))
  const edges = useMemo<Edge[]>(
    () =>
      linesOf(boxes).map((line) => {
        const color = line.done ? 'var(--primary)' : 'var(--line-strong)'
        // The order is in the list of boxes; a line says nothing more to a screen reader
        return { id: line.id, source: line.source, target: line.target, type: 'smoothstep', ariaRole: 'presentation', domAttributes: { 'aria-hidden': true }, style: { stroke: color, strokeWidth: 1.5 }, markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 } }
      }),
    [boxes],
  )
  const measured = useNodesInitialized()
  const flow = useReactFlow<BoxNode>()
  const frame = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(canvasHeight(0))
  const [placed, setPlaced] = useState(false)

  // The boxes' heights are known once drawn, so they are placed then; the canvas takes its height from that placing
  useEffect(() => {
    if (!measured) return
    const sizes = new Map(flow.getNodes().map((n) => [n.id, n.measured?.height ?? 0]))
    const place = placeBoxes(boxes, (id) => sizes.get(id) ?? 0)
    setNodes((list) => list.map((n) => ({ ...n, position: place.positions.get(n.id) ?? n.position })))
    const canvas = { width: frame.current?.clientWidth ?? 0, height: canvasHeight(place.height) }
    setHeight(canvas.height)
    const current = boxes.find((b) => (b.kind === 'STEP' || b.kind === 'GROUP') && b.step.current)
    void flow.setViewport(startView(place, current ? (place.positions.get(current.id)?.x ?? 0) + BOX_WIDTH : null, canvas))
    setPlaced(true)
  }, [measured, boxes, flow, setNodes])

  // Tabbing to a button of a box off the canvas brings the box into view; the wrapper resets the browser's own scroll
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node')?.dataset.id
    const box = id ? flow.getNode(id) : undefined
    const canvas = frame.current?.getBoundingClientRect()
    const shown = id ? frame.current?.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect() : undefined
    if (!box || !canvas || !shown) return
    if (shown.left >= canvas.left && shown.right <= canvas.right && shown.top >= canvas.top && shown.bottom <= canvas.bottom) return
    void flow.setCenter(box.position.x + BOX_WIDTH / 2, box.position.y + (box.measured?.height ?? 0) / 2, { zoom: flow.getZoom() })
  }

  // React Flow marks its root an application and calls each box a "node" (undone on the nodes above). Here nothing takes
  // over the keyboard, and the layer that holds only the boxes is the route's list of steps, read item by item
  useEffect(() => {
    frame.current?.querySelector('.react-flow')?.removeAttribute('role')
    const list = frame.current?.querySelector('.react-flow__nodes')
    list?.setAttribute('role', 'list')
    list?.setAttribute('aria-label', labels.list)
  }, [labels.list])

  return (
    <div ref={frame} data-step-flow="" onFocusCapture={onFocusCapture} className="relative w-full overflow-hidden rounded-md border border-line bg-surface" style={{ height }}>
      <ReactFlow<BoxNode>
        style={{ visibility: placed ? 'visible' : 'hidden' }}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        panActivationKeyCode={null}
        disableKeyboardA11y
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Lines} gap={24} color="var(--line)" />
      </ReactFlow>
      <ButtonGroup orientation="vertical" className="absolute top-3 right-3">
        <ZoomButton label={labels.zoomIn} onClick={() => void flow.zoomIn()}>
          <Plus aria-hidden="true" />
        </ZoomButton>
        <ZoomButton label={labels.zoomOut} onClick={() => void flow.zoomOut()}>
          <Minus aria-hidden="true" />
        </ZoomButton>
        <ZoomButton label={labels.fit} onClick={() => void flow.fitView({ padding: CANVAS_PAD / 400, maxZoom: 1, minZoom: MIN_ZOOM })}>
          <Maximize aria-hidden="true" />
        </ZoomButton>
      </ButtonGroup>
    </div>
  )
}

export function StepFlow({ steps, next, labels, onOpen, briefLink }: { steps: readonly StepCardView[]; next?: string; labels: StepFlowLabels; onOpen: (key: string) => void; briefLink?: string }) {
  const opening = useMemo(() => ({ open: onOpen, openLabel: labels.open, briefLink: briefLink ?? null }), [onOpen, labels.open, briefLink])
  // A new state of the route (a decision was made, the page refreshed) places its boxes from the start
  return (
    <Opening.Provider value={opening}>
      <ReactFlowProvider key={JSON.stringify([steps, next ?? null])}>
        <Canvas steps={steps} {...(next ? { next } : {})} labels={labels} />
      </ReactFlowProvider>
    </Opening.Provider>
  )
}
