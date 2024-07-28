/**
 * The three acceptance criteria, driven through the real command line.
 *
 *   1. Mandatory items cannot be dropped silently.
 *   2. An over-budget mandatory set stops clearly.
 *   3. Citation targets remain with retained claims.
 *
 * Each is pinned as a property over a whole range of budgets rather than at one
 * convenient number: a guarantee that holds at budget 240 and nowhere else is
 * not a guarantee, and a single-budget test cannot tell the two apart.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { join } from 'node:path'

import { packContext } from '../src/index.mjs'
import { cleanup, makeTree, manifest, runReport } from './helpers.mjs'

/**
 * The library entry point over a fixture.
 *
 * The property loops below sweep three hundred budgets each. Spawning a process
 * per budget turned a one-second suite into a seventy-five-second one, and a
 * slow guard is a guard people stop running. The exit codes these properties
 * imply are pinned separately, through the real command line, in the tests that
 * follow each loop and in test/severity-outcomes.test.mjs.
 */
const pack = (root, budgetTokens, tokenCost = 'declared') =>
  packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens, tokenCost })

const BRIEF = {
  'manifest.json': manifest({
    guardrails: { kind: 'instruction', priority: 0, mandatory: true, tokens: 40, text: 'obey' },
    task: { kind: 'instruction', priority: 5, mandatory: true, tokens: 20, text: 'summarise' },
    'claim-a': { kind: 'claim', priority: 10, tokens: 15, cites: ['evidence-a'], text: 'a claim' },
    'evidence-a': { kind: 'evidence', priority: 60, tokens: 90, text: 'a table' },
    'claim-b': { kind: 'claim', priority: 20, tokens: 12, cites: ['evidence-b1', 'evidence-b2'], text: 'b claim' },
    // A two-hop chain: the claim rests on a summary, and the summary rests on
    // the table. Dropping the table would leave the summary unsupported and the
    // claim resting on an unsupported summary, so all three travel together.
    'claim-chain': { kind: 'claim', priority: 30, tokens: 8, cites: ['summary-chain'], text: 'chained claim' },
    'summary-chain': { kind: 'evidence', priority: 75, tokens: 14, cites: ['table-chain'], text: 'a summary' },
    'table-chain': { kind: 'evidence', priority: 80, tokens: 22, text: 'the underlying table' },
    'evidence-b1': { kind: 'evidence', priority: 70, unit: 'b-table', tokens: 30, text: 'b half one' },
    'evidence-b2': { kind: 'evidence', priority: 70, unit: 'b-table', tokens: 30, text: 'b half two' },
    background: { kind: 'context', priority: 90, tokens: 25, text: 'background' },
  }),
}

const MANDATORY_IDS = ['guardrails', 'task']

test('acceptance 1: a mandatory segment is either retained or the run stops loudly, at every budget', async (t) => {
  const root = await makeTree(BRIEF)
  t.after(() => cleanup(root))

  // 0 through 300 covers well under the mandatory cost (60), exactly it, and
  // well past the cost of the entire manifest (262). If a budget existed at
  // which a mandatory segment quietly vanished, it is in this range.
  for (let budget = 0; budget <= 300; budget += 1) {
    const report = await pack(root, budget)

    if (report.pack === null) {
      assert.equal(report.status, 'fail')
      assert.equal(report.findings.filter((finding) => finding.ruleId === 'mandatory-over-budget').length, 1)
      assert.ok(budget < 60, `budget ${budget} refused although the mandatory set costs 60`)
      continue
    }

    const retained = new Set(report.pack.retained.map((entry) => entry.id))
    for (const id of MANDATORY_IDS) {
      assert.ok(retained.has(id), `budget ${budget} produced a pack without mandatory segment "${id}"`)
    }
    assert.equal(report.status, 'pass')
  }

  // The verdicts above are library values; these two pin the exit codes the
  // same inputs produce at the process boundary.
  assert.equal(runReport(root, ['--token-cost', 'declared', '--budget-tokens', '59']).status, 1)
  assert.equal(runReport(root, ['--token-cost', 'declared', '--budget-tokens', '60']).status, 0)
})

test('acceptance 1: a mandatory segment survives a budget that drops everything optional', async (t) => {
  const root = await makeTree(BRIEF)
  t.after(() => cleanup(root))

  const { report, status } = await runReport(root, ['--token-cost', 'declared', '--budget-tokens', '60'])
  assert.equal(status, 0)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.pack.retained.map((entry) => entry.id), ['guardrails', 'task'])
  assert.equal(report.pack.usedTokens, 60)

  // "Not silently": every single dropped segment is named in the report with
  // its own finding, so nothing leaves the window without an explanation.
  const dropped = report.pack.dropped.map((entry) => entry.id).sort()
  const explained = report.findings
    .filter((finding) => finding.ruleId === 'segment-dropped')
    .map((finding) => finding.location.pointer.replace('/segments/', ''))
    .sort()
  assert.deepEqual(explained, dropped)
  assert.deepEqual(dropped, [
    'background', 'claim-a', 'claim-b', 'claim-chain',
    'evidence-a', 'evidence-b1', 'evidence-b2', 'summary-chain', 'table-chain',
  ])
})

test('acceptance 2: an over-budget mandatory set stops clearly', async (t) => {
  const root = await makeTree(BRIEF)
  t.after(() => cleanup(root))

  const { report, status, stderr } = await runReport(root, ['--token-cost', 'declared', '--budget-tokens', '59'])
  assert.equal(status, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.pack, null, 'no pack may be produced when the mandatory set does not fit')

  const finding = report.findings.find((entry) => entry.ruleId === 'mandatory-over-budget')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /cost 60 tokens/)
  assert.match(finding.message, /budget of 59/)
  assert.equal(report.summary.mandatoryTokens, 60)
  assert.equal(stderr.includes('incomplete'), false, 'an impossible request is a verdict, not missing evidence')
})

test('acceptance 2: a mandatory claim drags its citations into the budget it must fit', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      rule: { kind: 'instruction', priority: 0, mandatory: true, tokens: 10, text: 'obey' },
      'must-cite': { kind: 'claim', priority: 1, mandatory: true, tokens: 5, cites: ['big-table'], text: 'claim' },
      'big-table': { kind: 'evidence', priority: 80, tokens: 400, text: 'table' },
    }),
  })
  t.after(() => cleanup(root))

  // The mandatory segments alone cost 15. Only the citation closure pushes the
  // requirement to 415, so this fails only if closure is part of the mandatory
  // set -- which is exactly the guarantee.
  const { report, status } = await runReport(root, ['--token-cost', 'declared', '--budget-tokens', '100'])
  assert.equal(status, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.pack, null)
  assert.equal(report.summary.mandatoryTokens, 415)
})

test('acceptance 3: a citation chain travels together, not only its first hop', async (t) => {
  const root = await makeTree(BRIEF)
  t.after(() => cleanup(root))

  // claim-chain rests on summary-chain, which rests on table-chain. A closure
  // that followed only the first hop would retain the claim and the summary at
  // budget 82, leaving the summary's own evidence outside the window -- so the
  // property is stated over the whole range rather than at one number.
  for (let budget = 60; budget <= 300; budget += 1) {
    const ids = new Set((await pack(root, budget)).pack.retained.map((entry) => entry.id))
    if (ids.has('claim-chain')) {
      assert.ok(ids.has('summary-chain'), `budget ${budget} retained a claim without the summary it rests on`)
      assert.ok(ids.has('table-chain'), `budget ${budget} retained a claim two hops from evidence it does not have`)
    }
    if (ids.has('summary-chain')) {
      assert.ok(ids.has('table-chain'), `budget ${budget} retained a summary without its own evidence`)
    }
  }

  // 60 mandatory + 8 + 14 + 22 is exactly 104, and nothing of higher priority
  // fits in the 44 tokens that leaves, so the whole chain arrives there.
  const whole = new Set((await pack(root, 104)).pack.retained.map((entry) => entry.id))
  assert.ok(whole.has('claim-chain') && whole.has('summary-chain') && whole.has('table-chain'))
  const short = new Set((await pack(root, 103)).pack.retained.map((entry) => entry.id))
  assert.equal(short.has('claim-chain'), false, 'one token short and the chain does not arrive at all')
})

test('acceptance 3: no retained segment ever loses a citation target, at any budget', async (t) => {
  const root = await makeTree(BRIEF)
  t.after(() => cleanup(root))

  for (let budget = 60; budget <= 300; budget += 1) {
    const report = await pack(root, budget)
    const retained = new Map(report.pack.retained.map((entry) => [entry.id, entry]))
    for (const entry of retained.values()) {
      for (const target of entry.cites) {
        assert.ok(retained.has(target), `budget ${budget} retained "${entry.id}" without its citation "${target}"`)
      }
    }
  }
})

test('acceptance 3: a claim and its evidence are dropped together, and retained together', async (t) => {
  const root = await makeTree(BRIEF)
  t.after(() => cleanup(root))

  // 60 mandatory + 15 claim-a + 90 evidence-a = 165. One token short and the
  // pair goes; one token over and both arrive.
  const tight = await runReport(root, ['--token-cost', 'declared', '--budget-tokens', '164'])
  const tightIds = tight.report.pack.retained.map((entry) => entry.id)
  assert.equal(tightIds.includes('claim-a'), false)
  assert.equal(tightIds.includes('evidence-a'), false)

  const roomy = await runReport(root, ['--token-cost', 'declared', '--budget-tokens', '165'])
  const roomyIds = roomy.report.pack.retained.map((entry) => entry.id)
  assert.ok(roomyIds.includes('claim-a'))
  assert.ok(roomyIds.includes('evidence-a'))
})

test('acceptance 3: an atomic evidence unit is retained whole or not at all', async (t) => {
  const root = await makeTree(BRIEF)
  t.after(() => cleanup(root))

  for (let budget = 60; budget <= 300; budget += 1) {
    const report = await pack(root, budget)
    const retained = new Set(report.pack.retained.map((entry) => entry.id))
    assert.equal(
      retained.has('evidence-b1'),
      retained.has('evidence-b2'),
      `budget ${budget} split the atomic unit "b-table"`,
    )
  }
})
