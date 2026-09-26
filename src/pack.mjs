/**
 * Atomic units, citation closure and the packing decision itself.
 *
 * Three structural choices live here and each of them is a guarantee the README
 * states:
 *
 * 1. **A unit is all or nothing.** Segments sharing a `unit` name are one
 *    indivisible piece of evidence. Half a table is not a smaller table, it is
 *    a misleading one.
 * 2. **A claim travels with what it cites.** Selecting a segment selects the
 *    transitive closure of its citation targets, so a retained claim is never
 *    left pointing at material that is not in the window.
 * 3. **Mandatory material is selected before anything competes for the
 *    budget**, and if the mandatory closure alone does not fit, no pack is
 *    produced at all. There is no arrangement in which a mandatory segment is
 *    quietly left out.
 *
 * Nothing here reads a file, a clock or the environment: the caller injects a
 * `deadline` predicate, so a run can be proved to stop without waiting.
 */

import { byCodeUnit } from './text.mjs'

/**
 * Group segments into atomic units and build the citation graph between units.
 *
 * `segments` must already carry a resolved integer `tokens`. A unit inherits
 * the *lowest* priority number and the *lowest* kind rank of its members, so a
 * unit is as important as its most important member; splitting that difference
 * would let an atomic unit be ranked below a piece of itself.
 */
export function buildUnits(segments) {
  const unitOf = new Map()
  const units = new Map()

  for (const segment of [...segments].sort((left, right) => byCodeUnit(left.id, right.id))) {
    unitOf.set(segment.id, segment.unit)
    const existing = units.get(segment.unit)
    if (existing === undefined) {
      units.set(segment.unit, {
        id: segment.unit,
        members: [segment.id],
        priority: segment.priority,
        kindRank: segment.kindRank,
        tokens: segment.tokens,
        mandatory: segment.mandatory,
      })
      continue
    }
    existing.members.push(segment.id)
    existing.priority = Math.min(existing.priority, segment.priority)
    existing.kindRank = Math.min(existing.kindRank, segment.kindRank)
    existing.tokens += segment.tokens
    existing.mandatory = existing.mandatory || segment.mandatory
  }

  const edges = new Map()
  for (const id of [...units.keys()].sort(byCodeUnit)) edges.set(id, new Set())
  for (const segment of segments) {
    const from = unitOf.get(segment.id)
    for (const target of segment.cites) {
      const to = unitOf.get(target)
      if (to === undefined || to === from) continue
      edges.get(from).add(to)
    }
  }

  return { units, unitOf, edges }
}

/**
 * The order units are considered for the budget in.
 *
 * Priority first (lower number is more important), then kind rank, then the
 * unit name by code unit. The third key is what makes the answer independent of
 * the order the manifest happened to list its segments in: without it two units
 * of equal priority and kind would be decided by an insertion order no reader
 * of the manifest can see.
 */
export function compareUnits(left, right) {
  return left.priority - right.priority
    || left.kindRank - right.kindRank
    || byCodeUnit(left.id, right.id)
}

/**
 * The order retained segments are assembled in.
 *
 * Kind rank first, so the instructions a model must obey lead the window,
 * then priority, then id. This is deliberately *not* the selection order: you
 * choose material by importance and you lay it out by role.
 */
export function compareAssembly(left, right) {
  return left.kindRank - right.kindRank
    || left.priority - right.priority
    || byCodeUnit(left.id, right.id)
}

/**
 * Every unit reachable from `start` through citations, and how many hops the
 * furthest one took.
 *
 * Breadth-first with a visited set, so a citation cycle terminates rather than
 * recursing forever -- cycles are legal here and are reported as information,
 * not refused. The returned depth is what the caller compares against its
 * documented limit.
 */
export function closureOf(start, edges) {
  const seen = new Set([start])
  let frontier = [start]
  let depth = 0
  while (frontier.length > 0) {
    const next = []
    for (const unit of frontier) {
      for (const target of [...(edges.get(unit) ?? [])].sort(byCodeUnit)) {
        if (seen.has(target)) continue
        seen.add(target)
        next.push(target)
      }
    }
    if (next.length === 0) break
    depth += 1
    frontier = next
  }
  return { units: seen, depth }
}

/** Units that can reach themselves through citations, sorted by code unit. */
export function unitsInCycles(units, edges, closures) {
  const cyclic = []
  for (const id of [...units.keys()].sort(byCodeUnit)) {
    for (const target of edges.get(id) ?? []) {
      if (closures.get(target).units.has(id)) {
        cyclic.push(id)
        break
      }
    }
  }
  return cyclic
}

/**
 * Choose which units fit the budget.
 *
 * Mandatory units and their citation closure are taken first and as a set: if
 * that set alone exceeds the budget the function returns `overBudget` and
 * selects nothing, because a pack missing a mandatory segment is worse than no
 * pack. Optional units are then offered the remaining budget in
 * `compareUnits` order, each with the part of its closure that is not already
 * selected; a unit whose closure does not fit is dropped and the next one is
 * still offered what is left. First fit, not an optimal knapsack -- see the
 * README's non-goals.
 *
 * `deadline()` is consulted once per unit. When it fires the function returns
 * `timedOut` with no selection at all: a partial pack produced by a clock
 * running out is exactly the "unknown reported as a result" shape this catalog
 * exists to avoid.
 */
export function packUnits({ units, closures, budgetTokens, deadline }) {
  const ordered = [...units.values()].sort(compareUnits)
  const selected = new Set()
  const drops = new Map()

  const costOf = (ids) => {
    let total = 0
    for (const id of ids) total += units.get(id).tokens
    return total
  }

  const mandatory = new Set()
  for (const unit of ordered) {
    if (!unit.mandatory) continue
    if (deadline()) return { timedOut: true }
    for (const id of closures.get(unit.id).units) mandatory.add(id)
  }
  const mandatoryTokens = costOf(mandatory)
  if (mandatoryTokens > budgetTokens) {
    return { overBudget: true, mandatoryTokens, mandatoryUnits: [...mandatory].sort(byCodeUnit) }
  }

  for (const id of mandatory) selected.add(id)
  let usedTokens = mandatoryTokens

  for (const unit of ordered) {
    if (selected.has(unit.id)) continue
    if (deadline()) return { timedOut: true }
    const addition = [...closures.get(unit.id).units].filter((id) => !selected.has(id))
    const additionTokens = costOf(addition)
    if (usedTokens + additionTokens <= budgetTokens) {
      for (const id of addition) selected.add(id)
      usedTokens += additionTokens
      continue
    }
    drops.set(unit.id, { unitTokens: additionTokens, remaining: budgetTokens - usedTokens })
  }

  return { selected, usedTokens, mandatoryTokens, drops }
}

/**
 * The guarantees, restated as a check that runs on every produced pack.
 *
 * This is not decoration. Each clause is a README promise, and a promise with
 * nothing that fails when it stops being true is a promise that will quietly
 * stop being true. `packContext` refuses to emit a pack that violates any of
 * them, and the function is exported so a test can hand it a deliberately
 * broken pack and see each clause fire.
 */
export function assertPackInvariants(pack, segments) {
  const violations = []
  const retained = new Set(pack.retained.map((entry) => entry.id))
  const byId = new Map(segments.map((segment) => [segment.id, segment]))

  for (const segment of [...segments].sort((left, right) => byCodeUnit(left.id, right.id))) {
    if (segment.mandatory && !retained.has(segment.id)) {
      violations.push(`mandatory segment "${segment.id}" is not retained`)
    }
  }
  for (const entry of pack.retained) {
    for (const target of byId.get(entry.id)?.cites ?? []) {
      if (!retained.has(target)) {
        violations.push(`retained segment "${entry.id}" cites "${target}", which is not retained`)
      }
    }
  }
  let total = 0
  for (const entry of pack.retained) total += entry.tokens
  if (total !== pack.usedTokens) {
    violations.push(`usedTokens is ${pack.usedTokens} but the retained segments cost ${total}`)
  }
  if (pack.usedTokens > pack.budgetTokens) {
    violations.push(`usedTokens ${pack.usedTokens} exceeds the budget of ${pack.budgetTokens}`)
  }
  return violations
}
