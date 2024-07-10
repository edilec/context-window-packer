/**
 * The two cost models.
 *
 * The estimator is a documented heuristic, not a tokenizer, and the README says
 * so. These tests pin the documented rule exactly -- an alphanumeric run costs
 * ceil(length / 4), every other non-whitespace character costs 1, whitespace is
 * free -- so the documentation and the behaviour cannot drift apart silently.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { CHARS_PER_TOKEN, TOKEN_COST_MODELS, estimateTokens, packContext, validateTokenCost } from '../src/index.mjs'
import { cleanup, findingFor, makeTree, manifest } from './helpers.mjs'

test('the estimator follows the documented rule, character by character', () => {
  assert.equal(CHARS_PER_TOKEN, 4)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('    \n\t  '), 0, 'whitespace is free')
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2, 'five characters is two tokens, not one')
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('a b c d'), 4, 'four one-character runs')
  assert.equal(estimateTokens('!?.'), 3, 'each punctuation character costs one')
  assert.equal(estimateTokens('hello, world'), 5, 'ceil(5/4) + 1 for the comma + ceil(5/4), with the space free')
})

test('the estimator is stable and involves no locale', () => {
  const text = 'Any text at all, with punctuation; numbers 1234567 and CAPITALS.'
  const first = estimateTokens(text)
  for (let repeat = 0; repeat < 5; repeat += 1) assert.equal(estimateTokens(text), first)
  assert.equal(estimateTokens(text), estimateTokens(String(text)))
})

test('non-ASCII text costs one per character rather than being ignored', () => {
  assert.equal(estimateTokens('你好'), 2)
  assert.equal(estimateTokens('café'), 2, 'three ASCII letters plus one non-ASCII character')
})

test('there is no default cost model', () => {
  assert.deepEqual([...TOKEN_COST_MODELS], ['declared', 'estimate'])
  assert.throws(() => validateTokenCost(undefined), /token cost model is required/)
  assert.throws(() => validateTokenCost('guess'), /Unknown token cost model "guess"/)
  assert.equal(validateTokenCost('estimate'), 'estimate')
})

test('declared mode never treats a missing count as free', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      counted: { kind: 'instruction', priority: 0, mandatory: true, tokens: 5, text: 'obey' },
      uncounted: { kind: 'context', priority: 9, text: 'this segment declares no token count' },
    }),
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 1000, tokenCost: 'declared' })
  assert.equal(findingFor(report, 'segment-cost-unknown').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.pack, null, 'a budget cannot be spent against a cost nobody knows')
})

test('estimate mode refuses a declared count rather than silently ignoring it', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      counted: { kind: 'instruction', priority: 0, mandatory: true, tokens: 5, text: 'obey' },
    }),
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 1000, tokenCost: 'estimate' })
  assert.equal(findingFor(report, 'segment-cost-conflict').severity, 'error')
  assert.equal(report.status, 'incomplete')
})

test('the two models really can disagree, which is why the run must choose', async (t) => {
  const text = 'a sentence whose estimated cost is nothing like the number written beside it'
  const root = await makeTree({
    'manifest.json': manifest({ only: { kind: 'context', priority: 1, text } }),
  })
  t.after(() => cleanup(root))

  const estimated = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 1000, tokenCost: 'estimate' })
  assert.equal(estimated.pack.usedTokens, estimateTokens(text))
  assert.notEqual(estimated.pack.usedTokens, 3)
})
