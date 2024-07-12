/**
 * "Unknown is never a pass", as a property rather than a per-rule case.
 *
 * test/severity-outcomes.test.mjs drives each rule individually. This file
 * guards the two ways that guarantee dies without any individual case noticing:
 * a typo in INCOMPLETE_RULES, which silently disarms one flag; and a code path
 * that emits a pack alongside missing evidence.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { INCOMPLETE_RULES, RULE_SEVERITY, packContext } from '../src/index.mjs'
import { cleanup, makeTree, manifest } from './helpers.mjs'

const INCOMPLETE = new Set(INCOMPLETE_RULES)

test('every rule named in INCOMPLETE_RULES is a rule this tool can actually emit', () => {
  // A misspelling here disarms one flag and nothing else changes: the rule
  // still fires, the report still says "fail", and a run with unread inputs
  // exits 1 instead of 2. Nothing in a per-rule test can see that.
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `INCOMPLETE_RULES names "${ruleId}", which no rule table entry defines`)
  }
  assert.deepEqual([...INCOMPLETE_RULES].sort(), [...INCOMPLETE_RULES], 'the list is kept sorted so a duplicate is visible')
  assert.equal(new Set(INCOMPLETE_RULES).size, INCOMPLETE_RULES.length)
})

const FIXTURES = {
  'an empty manifest': { 'manifest.json': manifest({}) },
  'an unreadable segment': {
    'manifest.json': manifest({
      good: { kind: 'instruction', priority: 0, mandatory: true, tokens: 1, text: 'obey' },
      gone: { kind: 'evidence', priority: 5, tokens: 1, file: 'gone.md' },
    }),
  },
  'a manifest that is not JSON': { 'manifest.json': '{oops' },
  'a segment with no declared cost': {
    'manifest.json': manifest({ only: { kind: 'context', priority: 1, text: 'x' } }),
  },
  'a citation that resolves to nothing': {
    'manifest.json': manifest({
      good: { kind: 'instruction', priority: 0, mandatory: true, tokens: 1, text: 'obey' },
      claim: { kind: 'claim', priority: 1, tokens: 1, cites: ['absent'], text: 'x' },
    }),
  },
}

for (const [name, files] of Object.entries(FIXTURES)) {
  test(`${name} is incomplete with no pack, never a pass`, async (t) => {
    const root = await makeTree(files)
    t.after(() => cleanup(root))

    const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 1000, tokenCost: 'declared' })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.pack, null)
    assert.ok(report.summary.unexamined > 0)
    assert.ok(report.findings.some((finding) => INCOMPLETE.has(finding.ruleId)))
  })
}

test('a passing run carries no rule that means evidence was missing', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      good: { kind: 'instruction', priority: 0, mandatory: true, tokens: 1, text: 'obey' },
      note: { kind: 'evidence', priority: 5, tokens: 400, text: 'long' },
    }),
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 10, tokenCost: 'declared' })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.unexamined, 0)
  assert.notEqual(report.pack, null)
  for (const finding of report.findings) {
    assert.equal(INCOMPLETE.has(finding.ruleId), false, `a passing run reported "${finding.ruleId}"`)
  }
})

test('a pass is never reached with nothing checked', async (t) => {
  const root = await makeTree({ 'manifest.json': manifest({}) })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 1000, tokenCost: 'declared' })
  assert.equal(report.summary.checked, 0)
  assert.notEqual(report.status, 'pass', 'pass with checked: 0 is green on no evidence')
})
