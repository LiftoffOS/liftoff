import { describe, it, expect } from 'vitest'
import { assignLayers } from './assignLayers'
import type { OrgChartBlock } from '../../types/insights'

// The layout is fed by an LLM, so the shapes that matter are the malformed
// ones: a cycle, an edge naming a node that does not exist, an isolated node.
// Every one of them has to still produce a diagram, because the alternative
// the user sees is a blank space where the team structure should be.

function block(
  nodes: Array<{ id: string; label: string }>,
  edges: Array<{ from: string; to: string }>,
): OrgChartBlock {
  return { type: 'org_chart', nodes, edges }
}

const n = (id: string) => ({ id, label: id })

describe('assignLayers', () => {
  it('puts a root above what it hands off to', () => {
    const layers = assignLayers(
      block([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]),
    )
    expect(layers).toEqual([['a'], ['b'], ['c']])
  })

  it('puts siblings on one row', () => {
    const layers = assignLayers(
      block([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]),
    )
    expect(layers[0]).toEqual(['a'])
    expect(layers[1].sort()).toEqual(['b', 'c'])
  })

  it('places every node exactly once, edges or not', () => {
    const layers = assignLayers(block([n('a'), n('b'), n('lonely')], [{ from: 'a', to: 'b' }]))
    const placed = layers.flat()
    expect(placed.sort()).toEqual(['a', 'b', 'lonely'])
    expect(new Set(placed).size).toBe(placed.length)
  })

  it('terminates on a cycle instead of hanging', () => {
    const layers = assignLayers(
      block([n('a'), n('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]),
    )
    expect(layers.flat().sort()).toEqual(['a', 'b'])
  })

  it('ignores an edge naming a node that is not in the list', () => {
    const layers = assignLayers(
      block([n('a'), n('b')], [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'b' }]),
    )
    expect(layers).toEqual([['a'], ['b']])
  })

  it('returns nothing to draw for an empty structure', () => {
    expect(assignLayers(block([], []))).toEqual([])
  })
})
