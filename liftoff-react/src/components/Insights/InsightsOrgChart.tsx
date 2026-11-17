import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import type { OrgChartBlock } from '../../types/insights'
import '@xyflow/react/dist/style.css'
import './InsightsOrgChart.css'
import { assignLayers } from './assignLayers'

// Renders the org_chart block the Chief AI Officer emits when it proposes a
// team structure. Built on @xyflow/react, the same library and the same
// read-only canvas configuration as AgentWorkflowViz, so the two diagrams in
// the product look like they belong to one product.
//
// Layout is layered top-down rather than free-form: an edge means "hands off
// to", so depth carries meaning and a stable left-to-right order within a
// layer keeps the picture from reshuffling when the CAIO revises the plan.

const NODE_WIDTH = 200
const NODE_HEIGHT = 58
const H_GAP = 28
const V_GAP = 74

interface LayoutNode {
  id: string
  label: string
  kind: string
  department: string
}

function buildGraph(block: OrgChartBlock): {
  nodes: Node[]
  edges: Edge[]
  width: number
  height: number
} {
  const byId = new Map<string, LayoutNode>(
    block.nodes.map(n => [
      n.id,
      {
        id: n.id,
        label: n.label,
        kind: n.type ?? '',
        department: n.department ?? '',
      },
    ]),
  )

  const layers = assignLayers(block)
  const widest = Math.max(1, ...layers.map(l => l.length))
  const canvasWidth = widest * NODE_WIDTH + (widest - 1) * H_GAP

  const nodes: Node[] = []
  layers.forEach((layer, depth) => {
    const rowWidth = layer.length * NODE_WIDTH + (layer.length - 1) * H_GAP
    const startX = (canvasWidth - rowWidth) / 2
    layer.forEach((id, i) => {
      const model = byId.get(id)
      if (!model) return
      nodes.push({
        id,
        type: 'orgTeam',
        position: { x: startX + i * (NODE_WIDTH + H_GAP), y: depth * (NODE_HEIGHT + V_GAP) },
        data: { label: model.label, kind: model.kind, department: model.department },
        style: { width: NODE_WIDTH },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })
    })
  })

  const placed = new Set(nodes.map(n => n.id))
  const edges: Edge[] = block.edges
    .filter(e => placed.has(e.from) && placed.has(e.to))
    .map((e, i) => ({
      id: `oc-e-${i}`,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      label: e.label,
      labelShowBg: true,
      style: { stroke: 'var(--color-gray-200)', strokeWidth: 1 },
    }))

  return {
    nodes,
    edges,
    width: canvasWidth,
    height: layers.length * NODE_HEIGHT + Math.max(0, layers.length - 1) * V_GAP,
  }
}

function OrgTeamNode({ data }: NodeProps) {
  const { label, kind, department } = data as {
    label: string
    kind: string
    department: string
  }
  return (
    <div className="ioc__node">
      <Handle type="target" position={Position.Top} className="ioc__handle" />
      <span className="ioc__node-label">{label}</span>
      {(department || kind) && (
        <span className="ioc__node-meta">
          {department}
          {department && kind ? ' · ' : ''}
          {kind === 'workflow' ? 'Workflow' : kind === 'agent' ? 'Team' : kind}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="ioc__handle" />
    </div>
  )
}

const nodeTypes = { orgTeam: OrgTeamNode }

export default function InsightsOrgChart({ block }: { block: OrgChartBlock }) {
  const rfRef = useRef<ReactFlowInstance | null>(null)

  const { nodes, edges, height } = useMemo(() => buildGraph(block), [block])

  const fit = useCallback((rf: ReactFlowInstance) => {
    setTimeout(() => rf.fitView({ padding: 0.08, maxZoom: 1 }), 50)
  }, [])

  useEffect(() => {
    if (rfRef.current) fit(rfRef.current)
  }, [nodes, fit])

  if (nodes.length === 0) return null

  return (
    <div className="ioc">
      {block.title && <h3 className="ioc__title">{block.title}</h3>}
      <div className="ioc__canvas" style={{ height: height + 32 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          preventScrolling={false}
          onInit={rf => {
            rfRef.current = rf
            fit(rf)
          }}
          proOptions={{ hideAttribution: true }}
        />
      </div>
    </div>
  )
}
