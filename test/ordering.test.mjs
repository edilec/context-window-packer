/**
 * Ordering, pinned behaviourally.
 *
 * Scanning this tool's own source for `.localeCompare(` is not a determinism
 * test: substituting `Intl.Collator` produces identical collation drift with
 * different source text, so the grep passes while the output quietly becomes
 * machine-dependent.
 *
 * So these tests choose inputs whose order genuinely differs between code-unit
 * and collation ordering, push them through the real report path, and assert
 * the exact emitted sequence. Each one also asserts that the collation ordering
 * of the same strings is *different*, so the fixture is provably able to tell
 * the two apart -- a discrimination test that fails loudly if someone ever
 * picks example ids that both orderings agree on.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { compareFindingRows, packContext } from '../src/index.mjs'
import { cleanup, makeTree, manifest } from './helpers.mjs'

const collated = (values) => [...values].sort(new Intl.Collator('en').compare)

test('findings sort by pointer using code units, not collation', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      filler: { kind: 'instruction', priority: 0, mandatory: true, tokens: 10, text: 'obey' },
      README: { kind: 'context', priority: 5, tokens: 8, text: 'r' },
      'Z-note': { kind: 'context', priority: 5, tokens: 8, text: 'z' },
      'a-b': { kind: 'context', priority: 5, tokens: 8, text: 'ab' },
      'a-note': { kind: 'context', priority: 5, tokens: 8, text: 'an' },
      a_b: { kind: 'context', priority: 5, tokens: 8, text: 'au' },
      assets: { kind: 'context', priority: 5, tokens: 8, text: 'as' },
    }),
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 10, tokenCost: 'declared' })
  const pointers = report.findings.map((finding) => finding.location.pointer)

  assert.deepEqual(pointers, [
    '/segments/README',
    '/segments/Z-note',
    '/segments/a-b',
    '/segments/a-note',
    '/segments/a_b',
    '/segments/assets',
  ])
  assert.notDeepEqual(pointers, collated(pointers), 'the fixture must distinguish code-unit ordering from collation')
})

test('findings sort by file using code units, not collation', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      good: { kind: 'instruction', priority: 0, mandatory: true, tokens: 1, text: 'obey' },
      zulu: { kind: 'evidence', priority: 5, tokens: 1, file: 'Zulu.md' },
      alpha: { kind: 'evidence', priority: 5, tokens: 1, file: 'alpha.md' },
    }),
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  const files = report.findings.map((finding) => finding.location.file)

  assert.deepEqual(files, ['Zulu.md', 'alpha.md'])
  assert.notDeepEqual(files, collated(files), 'the fixture must distinguish code-unit ordering from collation')
})

test('the pack itself is ordered by code unit where ids decide the tie', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      README: { kind: 'context', priority: 5, tokens: 1, text: 'r' },
      'Z-note': { kind: 'context', priority: 5, tokens: 1, text: 'z' },
      'a-b': { kind: 'context', priority: 5, tokens: 1, text: 'ab' },
      a_b: { kind: 'context', priority: 5, tokens: 1, text: 'au' },
      assets: { kind: 'context', priority: 5, tokens: 1, text: 'as' },
    }),
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  const ids = report.pack.retained.map((entry) => entry.id)

  assert.deepEqual(ids, ['README', 'Z-note', 'a-b', 'a_b', 'assets'])
  assert.notDeepEqual(ids, collated(ids), 'the fixture must distinguish code-unit ordering from collation')
})

test('retained segments are assembled by kind rank before priority', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      'late-instruction': { kind: 'instruction', priority: 90, tokens: 1, text: 'i' },
      'early-context': { kind: 'context', priority: 1, tokens: 1, text: 'c' },
      'mid-claim': { kind: 'claim', priority: 50, tokens: 1, text: 'm' },
      'mid-evidence': { kind: 'evidence', priority: 50, tokens: 1, text: 'e' },
    }),
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  assert.deepEqual(
    report.pack.retained.map((entry) => entry.id),
    ['late-instruction', 'mid-claim', 'mid-evidence', 'early-context'],
  )
  // ...while selection went by priority, which is the opposite order.
  assert.deepEqual(
    report.pack.dropped.map((entry) => entry.id),
    [],
  )
})

test('each tie-break key of the documented sort is load-bearing', () => {
  const row = (over) => ({
    ruleId: 'segment-dropped',
    severity: 'info',
    message: 'm',
    location: { file: 'f', pointer: '/p' },
    ...over,
  })

  assert.equal(compareFindingRows(row({ location: { file: 'A' } }), row({ location: { file: 'a' } })), -1)
  assert.equal(compareFindingRows(row({ location: { file: 'f', pointer: '/A' } }), row({ location: { file: 'f', pointer: '/a' } })), -1)
  assert.equal(compareFindingRows(row({ ruleId: 'citation-cycle' }), row({ ruleId: 'segment-dropped' })), -1)
  assert.equal(compareFindingRows(row({ message: 'A' }), row({ message: 'a' })), -1)
  assert.equal(compareFindingRows(row({ evidence: 'A' }), row({ evidence: 'a' })), -1)
  assert.equal(compareFindingRows(row({}), row({})), 0)
})
