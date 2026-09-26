/**
 * The README's rule table against the source of truth, in both directions.
 *
 * This is **not** the severity guard -- `test/severity-outcomes.test.mjs` is,
 * and it works by driving real inputs through the real command line and
 * asserting exit codes, which no edit to a table can satisfy. Three
 * declarations agreeing with each other are satisfied by one coordinated edit.
 *
 * What this file guards is the documentation, which is a separate promise: a
 * README that describes a rule the tool does not emit, omits one it does, or
 * states the wrong severity is a documentation overclaim, and a reader has no
 * way to tell. So the table is parsed out of the shipped README and compared
 * against the code, in both directions.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { INCOMPLETE_RULES, RULE_SEVERITY } from '../src/index.mjs'

const README = new URL('../README.md', import.meta.url)
const ROW = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes)? *\| /gm

async function documentedRules() {
  const text = await readFile(README, 'utf8')
  const rows = new Map()
  for (const match of text.matchAll(ROW)) {
    assert.equal(rows.has(match[1]), false, `the README documents "${match[1]}" twice`)
    rows.set(match[1], { severity: match[2], incomplete: match[3] === 'yes' })
  }
  return rows
}

test('every rule the tool can emit is documented, and nothing else is', async () => {
  const documented = await documentedRules()
  assert.ok(documented.size > 0, 'the README rule table could not be parsed at all')
  assert.deepEqual([...documented.keys()].sort(), Object.keys(RULE_SEVERITY).sort())
})

test('the documented severity of every rule matches the one the tool uses', async () => {
  const documented = await documentedRules()
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(documented.get(ruleId).severity, severity, `the README documents "${ruleId}" with the wrong severity`)
  }
})

test('the documented incomplete column matches INCOMPLETE_RULES, in both directions', async () => {
  const documented = await documentedRules()
  const incomplete = new Set(INCOMPLETE_RULES)
  for (const [ruleId, row] of documented) {
    assert.equal(
      row.incomplete,
      incomplete.has(ruleId),
      `the README and INCOMPLETE_RULES disagree about whether "${ruleId}" makes a run incomplete`,
    )
  }
})

test('the rule table is sorted, so a rule added in the wrong place is visible', () => {
  const declared = Object.keys(RULE_SEVERITY)
  assert.deepEqual(declared, [...declared].sort())
})
