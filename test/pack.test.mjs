/**
 * The packing primitives, and the invariant check that guards the result.
 *
 * `assertPackInvariants` is the last line of defence for the three guarantees
 * the README makes, so each of its clauses is exercised with a pack that
 * deliberately breaks it. A check nobody has ever seen fire is a check nobody
 * knows is wired up.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertPackInvariants, buildUnits, closureOf, compareAssembly, compareUnits, packUnits, unitsInCycles,
} from '../src/index.mjs'

/** A resolved segment. `unit` defaults to the id, exactly as the manifest layer does. */
const segment = (over) => {
  const base = { id: 'a', kind: 'context', kindRank: 3, priority: 10, mandatory: false, cites: [], tokens: 1, ...over }
  return { ...base, unit: over.unit ?? base.id }
}

const never = () => false

test('segments sharing a unit name become one indivisible piece', () => {
  const { units, unitOf } = buildUnits([
    segment({ id: 'p1', unit: 'table', tokens: 30, priority: 70, kindRank: 2 }),
    segment({ id: 'p2', unit: 'table', tokens: 40, priority: 20, kindRank: 1, mandatory: true }),
  ])
  assert.equal(units.size, 1)
  const unit = units.get('table')
  assert.deepEqual(unit.members, ['p1', 'p2'])
  assert.equal(unit.tokens, 70)
  assert.equal(unit.priority, 20, 'a unit is as important as its most important member')
  assert.equal(unit.kindRank, 1)
  assert.equal(unit.mandatory, true, 'one mandatory member makes the whole unit mandatory')
  assert.equal(unitOf.get('p1'), 'table')
})

test('closure follows citations transitively and survives a cycle', () => {
  const { edges } = buildUnits([
    segment({ id: 'a', cites: ['b'] }),
    segment({ id: 'b', cites: ['c'] }),
    segment({ id: 'c', cites: ['a'] }),
    segment({ id: 'lonely' }),
  ])
  const closure = closureOf('a', edges)
  assert.deepEqual([...closure.units].sort(), ['a', 'b', 'c'])
  assert.equal(closure.depth, 2)
  assert.deepEqual([...closureOf('lonely', edges).units], ['lonely'])
  assert.equal(closureOf('lonely', edges).depth, 0)
})

test('a cycle is detected and reported, not refused', () => {
  const { units, edges } = buildUnits([
    segment({ id: 'a', cites: ['b'] }),
    segment({ id: 'b', cites: ['a'] }),
    segment({ id: 'c' }),
  ])
  const closures = new Map([...units.keys()].map((id) => [id, closureOf(id, edges)]))
  assert.deepEqual(unitsInCycles(units, edges, closures), ['a', 'b'])
})

test('units are ordered by priority, then kind rank, then id by code unit', () => {
  const unit = (over) => ({ id: 'x', priority: 5, kindRank: 2, ...over })
  assert.equal(compareUnits(unit({ priority: 1 }), unit({ priority: 2 })), -1)
  assert.ok(compareUnits(unit({ kindRank: 0 }), unit({ kindRank: 3 })) < 0)
  assert.equal(compareUnits(unit({ id: 'Z' }), unit({ id: 'a' })), -1)
  assert.ok(compareAssembly(unit({ kindRank: 0, priority: 99 }), unit({ kindRank: 3, priority: 0 })) < 0)
})

test('an over-budget mandatory closure selects nothing at all', () => {
  const segments = [
    segment({ id: 'must', mandatory: true, tokens: 10, unit: 'must', cites: ['huge'] }),
    segment({ id: 'huge', tokens: 500, unit: 'huge' }),
  ]
  const { units, edges } = buildUnits(segments)
  const closures = new Map([...units.keys()].map((id) => [id, closureOf(id, edges)]))
  const outcome = packUnits({ units, closures, budgetTokens: 100, deadline: never })

  assert.equal(outcome.overBudget, true)
  assert.equal(outcome.mandatoryTokens, 510)
  assert.equal(outcome.selected, undefined, 'nothing is selected when the mandatory set does not fit')
})

test('a deadline that fires mid-loop selects nothing rather than a partial pack', () => {
  const segments = [segment({ id: 'a', unit: 'a' }), segment({ id: 'b', unit: 'b' })]
  const { units, edges } = buildUnits(segments)
  const closures = new Map([...units.keys()].map((id) => [id, closureOf(id, edges)]))

  let calls = 0
  const outcome = packUnits({
    units, closures, budgetTokens: 1000, deadline: () => (calls += 1) > 1,
  })
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.selected, undefined)
  assert.equal(outcome.usedTokens, undefined)
})

test('assertPackInvariants catches a dropped mandatory segment', () => {
  const segments = [segment({ id: 'must', mandatory: true, tokens: 5 }), segment({ id: 'other', tokens: 5 })]
  const pack = { budgetTokens: 100, usedTokens: 5, retained: [{ id: 'other', tokens: 5 }] }
  assert.deepEqual(assertPackInvariants(pack, segments), ['mandatory segment "must" is not retained'])
})

test('assertPackInvariants catches a retained claim whose citation was dropped', () => {
  const segments = [segment({ id: 'claim', cites: ['evidence'], tokens: 5 }), segment({ id: 'evidence', tokens: 5 })]
  const pack = { budgetTokens: 100, usedTokens: 5, retained: [{ id: 'claim', tokens: 5 }] }
  assert.deepEqual(
    assertPackInvariants(pack, segments),
    ['retained segment "claim" cites "evidence", which is not retained'],
  )
})

test('assertPackInvariants catches an arithmetic disagreement and an overspent budget', () => {
  const segments = [segment({ id: 'a', tokens: 5 })]
  assert.deepEqual(
    assertPackInvariants({ budgetTokens: 100, usedTokens: 9, retained: [{ id: 'a', tokens: 5 }] }, segments),
    ['usedTokens is 9 but the retained segments cost 5'],
  )
  assert.deepEqual(
    assertPackInvariants({ budgetTokens: 1, usedTokens: 5, retained: [{ id: 'a', tokens: 5 }] }, segments),
    ['usedTokens 5 exceeds the budget of 1'],
  )
})

test('assertPackInvariants says nothing about a pack that honours all of them', () => {
  const segments = [
    segment({ id: 'must', mandatory: true, tokens: 5, cites: ['evidence'] }),
    segment({ id: 'evidence', tokens: 7 }),
  ]
  const pack = {
    budgetTokens: 100,
    usedTokens: 12,
    retained: [{ id: 'must', tokens: 5 }, { id: 'evidence', tokens: 7 }],
  }
  assert.deepEqual(assertPackInvariants(pack, segments), [])
})
