import type { OrgChartBlock } from '../../types/insights'

/**
 * Assign each node a layer: roots (nothing points at them) first, then anyone
 * reachable from a placed node. Runs breadth-first with a visited set, so a
 * cycle in the model's output places each node once instead of hanging.
 */
export function assignLayers(block: OrgChartBlock): string[][] {
  const ids = block.nodes.map(n => n.id)
  const known = new Set(ids)
  const incoming = new Map<string, number>(ids.map(id => [id, 0]))
  const outgoing = new Map<string, string[]>(ids.map(id => [id, []]))

  for (const edge of block.edges) {
    // Edges naming a node that is not in the list are the model's mistake, not
    // a reason to drop the whole diagram.
    if (!known.has(edge.from) || !known.has(edge.to)) continue
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)!.push(edge.to)
  }

  const layerOf = new Map<string, number>()
  let frontier = ids.filter(id => (incoming.get(id) ?? 0) === 0)
  // Everything in a cycle has an incoming edge, so a fully cyclic graph would
  // start with an empty frontier. Fall back to the declared order.
  if (frontier.length === 0) frontier = ids.slice(0, 1)

  let depth = 0
  const seen = new Set<string>()
  while (frontier.length > 0 && depth < ids.length) {
    const next: string[] = []
    for (const id of frontier) {
      if (seen.has(id)) continue
      seen.add(id)
      layerOf.set(id, depth)
      for (const child of outgoing.get(id) ?? []) {
        if (!seen.has(child)) next.push(child)
      }
    }
    frontier = next
    depth++
  }

  // Anything unreachable (an isolated node, or one only reachable through a
  // cycle) goes on the bottom row rather than vanishing.
  for (const id of ids) {
    if (!layerOf.has(id)) layerOf.set(id, depth)
  }

  const layers: string[][] = []
  for (const id of ids) {
    const layer = layerOf.get(id)!
    ;(layers[layer] ??= []).push(id)
  }
  return layers.filter(Boolean)
}
