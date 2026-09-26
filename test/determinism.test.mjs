/**
 * The output contract: the same manifest always produces the same bytes.
 *
 * Two things can break that without any test noticing. The first is a clock or
 * an environment reading sneaking into the report. The second is object key
 * order: JSON preserves the order the file was written in, so a manifest whose
 * segments are listed differently is the same manifest to a reader and a
 * different one to a loop that iterates `Object.keys`. Both are pinned here.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { cleanup, makeTree, manifest, runCli } from './helpers.mjs'

const SEGMENTS = {
  guardrails: { kind: 'instruction', priority: 0, mandatory: true, tokens: 10, text: 'obey' },
  'claim-a': { kind: 'claim', priority: 4, tokens: 6, cites: ['evidence-a'], text: 'a' },
  'evidence-a': { kind: 'evidence', priority: 8, tokens: 30, text: 'table a' },
  'claim-b': { kind: 'claim', priority: 5, tokens: 6, cites: ['evidence-b'], text: 'b' },
  'evidence-b': { kind: 'evidence', priority: 9, tokens: 90, text: 'table b' },
  background: { kind: 'context', priority: 20, tokens: 12, text: 'background' },
}

function reversedKeys(segments) {
  const out = {}
  for (const key of Object.keys(segments).reverse()) out[key] = segments[key]
  return out
}

test('two runs over the same manifest produce byte-identical stdout', async (t) => {
  const root = await makeTree({ 'manifest.json': manifest(SEGMENTS) })
  t.after(() => cleanup(root))
  const args = ['--manifest', join(root, 'manifest.json'), '--root', root, '--json', '--token-cost', 'declared', '--budget-tokens', '60']

  const first = runCli(args)
  const second = runCli(args)
  assert.equal(first.status, 0)
  assert.equal(first.stdout, second.stdout)
  assert.ok(first.stdout.length > 100)
})

test('the order the manifest lists its segments in does not reach the output', async (t) => {
  const forward = await makeTree({ 'manifest.json': manifest(SEGMENTS) })
  const backward = await makeTree({ 'manifest.json': manifest(reversedKeys(SEGMENTS)) })
  t.after(() => cleanup(forward))
  t.after(() => cleanup(backward))

  const run = (root) => runCli([
    '--manifest', join(root, 'manifest.json'), '--root', root, '--json',
    '--token-cost', 'declared', '--budget-tokens', '60',
  ]).stdout

  // Proof the fixture is real: the two files genuinely differ.
  assert.notEqual(manifest(SEGMENTS), manifest(reversedKeys(SEGMENTS)))
  assert.equal(run(forward), run(backward))
})

test('nothing in the report varies with the wall clock', async (t) => {
  const root = await makeTree({ 'manifest.json': manifest(SEGMENTS) })
  t.after(() => cleanup(root))
  const args = ['--manifest', join(root, 'manifest.json'), '--root', root, '--json', '--token-cost', 'declared', '--budget-tokens', '60']

  const before = runCli(args).stdout
  const year = String(new Date().getUTCFullYear())
  assert.equal(before.includes(year), false, 'a timestamp reached the report')
  assert.equal(before.includes(root), false, 'an absolute host path reached the report')

  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(runCli(args).stdout, before)
})

test('the same manifest packs the same way whichever directory it is read from', async (t) => {
  const first = await makeTree({ 'manifest.json': manifest(SEGMENTS) })
  const second = await makeTree({ 'manifest.json': manifest(SEGMENTS) })
  t.after(() => cleanup(first))
  t.after(() => cleanup(second))

  const run = (root) => runCli([
    '--manifest', join(root, 'manifest.json'), '--root', root, '--json',
    '--token-cost', 'declared', '--budget-tokens', '60',
  ]).stdout
  assert.notEqual(first, second)
  assert.equal(run(first), run(second))
})
