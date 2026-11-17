import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import type { WorkflowVisualizationStep, WorkflowVisualizationForkPath } from '../../services/internalAgents'
import '@xyflow/react/dist/style.css'
import './AgentWorkflowViz.css'

export type { WorkflowVisualizationStep, WorkflowVisualizationForkPath }

// ─── constants ────────────────────────────────────────────────────────────────

const NODE_WIDTH        = 220
const NODE_HEIGHT       = 32
const NODE_GAP          = 22

const FORK_COLLAPSED_H  = 28
const FORK_TAB_ROW_H    = 36
const FORK_INNER_STEP_H = 30
const FORK_INNER_CONN_H = 22
const FORK_PADDING_V    = 24
const FORK_GAP          = 28

const SOLID = { stroke: '#d0d0d0', strokeWidth: 1 }

// ─── height helpers ───────────────────────────────────────────────────────────

function forkExpandedHeight(steps: WorkflowVisualizationStep[]): number {
  return (
    FORK_TAB_ROW_H +
    steps.length * FORK_INNER_STEP_H +
    Math.max(0, steps.length - 1) * FORK_INNER_CONN_H +
    FORK_PADDING_V
  )
}

function forkNodeHeight(paths: WorkflowVisualizationForkPath[], activeIdx: number, expanded: boolean): number {
  return expanded ? forkExpandedHeight(paths[activeIdx].steps) : FORK_COLLAPSED_H
}

// ─── graph builder ────────────────────────────────────────────────────────────

interface FlatItem {
  kind: 'step' | 'fork'
  id: string
  label?: string
  paths?: WorkflowVisualizationForkPath[]
  height: number
}

function flatten(
  steps: WorkflowVisualizationStep[],
  expandedForks: Set<string>,
  activePaths: Map<string, number>,
): FlatItem[] {
  const items: FlatItem[] = []
  for (const step of steps) {
    items.push({ kind: 'step', id: step.id, label: step.label, height: NODE_HEIGHT })
    if (step.fork) {
      const forkId = `fork-${step.id}`
      const isExpanded = expandedForks.has(forkId)
      const activeIdx = activePaths.get(forkId) ?? 0
      items.push({
        kind: 'fork', id: forkId, paths: step.fork.paths,
        height: forkNodeHeight(step.fork.paths, activeIdx, isExpanded),
      })
    }
  }
  return items
}

function buildGraph(
  steps: WorkflowVisualizationStep[],
  expandedForks: Set<string>,
  activePaths: Map<string, number>,
  onToggleFork: (id: string) => void,
  onSelectPath: (forkId: string, idx: number) => void,
): { nodes: Node[]; edges: Edge[]; totalHeight: number } {
  const items = flatten(steps, expandedForks, activePaths)
  const nodes: Node[] = []
  const edges: Edge[] = []
  let y = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const isFork = item.kind === 'fork'

    if (isFork) {
      const forkId = item.id
      const isExpanded = expandedForks.has(forkId)
      const activeIdx = activePaths.get(forkId) ?? 0
      nodes.push({
        id: forkId, type: 'fork', position: { x: 0, y },
        data: {
          paths: item.paths,
          expanded: isExpanded,
          activePathIdx: activeIdx,
          onToggle: () => onToggleFork(forkId),
          onSelectPath: (idx: number) => onSelectPath(forkId, idx),
        },
        style: { width: NODE_WIDTH }, width: NODE_WIDTH, height: item.height,
      })
    } else {
      nodes.push({
        id: item.id, type: 'step', position: { x: 0, y },
        data: { label: item.label },
        style: { width: NODE_WIDTH }, width: NODE_WIDTH, height: NODE_HEIGHT,
      })
    }

    if (i < items.length - 1) {
      edges.push({
        id: `e-${i}`, source: item.id, target: items[i + 1].id,
        type: 'straight', style: SOLID,
      })
    }

    y += item.height + (isFork ? FORK_GAP : NODE_GAP)
  }

  return { nodes, edges, totalHeight: y }
}

// ─── node components ──────────────────────────────────────────────────────────

function StepNode({ data }: NodeProps) {
  return (
    <div className="awv__step-node">
      <Handle type="target" position={Position.Top}    className="awv__handle" />
      {String(data.label ?? '')}
      <Handle type="source" position={Position.Bottom} className="awv__handle" />
    </div>
  )
}

function ForkNode({ data }: NodeProps) {
  const { paths, expanded, activePathIdx, onToggle, onSelectPath } = data as {
    paths: WorkflowVisualizationForkPath[]; expanded: boolean; activePathIdx: number
    onToggle: () => void; onSelectPath: (idx: number) => void
  }

  if (!expanded) {
    return (
      <div
        className="awv__fork-node awv__fork-node--collapsed nopan"
        role="button"
        tabIndex={0}
        aria-expanded={false}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() }
        }}
      >
        <Handle type="target" position={Position.Top}    className="awv__handle" />
        <ChevronDownIcon className="awv__fork-chevron awv__fork-chevron--right" />
        <span className="awv__fork-conditions">
          {paths.map(p => p.condition).join('  ·  ')}
        </span>
        <Handle type="source" position={Position.Bottom} className="awv__handle" />
      </div>
    )
  }

  const activePath = paths[activePathIdx]

  return (
    <div className="awv__fork-node awv__fork-node--expanded nopan">
      <Handle type="target" position={Position.Top}    className="awv__handle" />
      <div className="awv__fork-tabs">
        {paths.map((path, i) => (
          <button
            key={i} type="button"
            className={`awv__fork-tab${i === activePathIdx ? ' awv__fork-tab--active' : ''}`}
            onClick={() => onSelectPath(i)}
          >
            {path.condition}
          </button>
        ))}
        <button type="button" className="awv__fork-close" onClick={onToggle}>
          <ChevronDownIcon className="awv__fork-chevron awv__fork-chevron--up" />
        </button>
      </div>
      <div className="awv__fork-steps">
        {activePath.steps.map((step: WorkflowVisualizationStep, i: number) => (
          <div key={step.id} className="awv__fork-step">
            {i > 0 && <div className="awv__fork-connector" />}
            <div className="awv__fork-pill">{step.label}</div>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} className="awv__handle" />
    </div>
  )
}

const nodeTypes = { step: StepNode, fork: ForkNode }

// ─── main component ───────────────────────────────────────────────────────────

interface AgentWorkflowVizProps {
  steps: WorkflowVisualizationStep[]
}

export function AgentWorkflowViz({ steps }: AgentWorkflowVizProps) {
  const [expandedForks, setExpandedForks] = useState<Set<string>>(new Set())
  const [activePaths,   setActivePaths]   = useState<Map<string, number>>(new Map())
  const rfRef = useRef<ReactFlowInstance | null>(null)

  const onToggleFork = useCallback((id: string) => {
    setExpandedForks(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const onSelectPath = useCallback((forkId: string, idx: number) => {
    setActivePaths(prev => new Map(prev).set(forkId, idx))
  }, [])

  const { nodes, edges, totalHeight } = useMemo(
    () => buildGraph(steps, expandedForks, activePaths, onToggleFork, onSelectPath),
    [steps, expandedForks, activePaths, onToggleFork, onSelectPath],
  )

  useEffect(() => {
    setTimeout(() => rfRef.current?.fitView({ padding: 0.05, maxZoom: 1 }), 50)
  }, [nodes])

  if (steps.length === 0) return null

  return (
    <div className="awv">
      <div className="awv__canvas" style={{ height: totalHeight + 32 }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          nodesDraggable={false} nodesConnectable={false}
          nodesFocusable={false} edgesFocusable={false}
          panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false}
          preventScrolling={false}
          onInit={rf => { rfRef.current = rf; setTimeout(() => rf.fitView({ padding: 0.05, maxZoom: 1 }), 50) }}
          proOptions={{ hideAttribution: true }}
        />
      </div>
    </div>
  )
}
