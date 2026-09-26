/**
 * Path confinement, against real paths rather than spellings.
 *
 * Rejecting `../` and absolute paths is not confinement. A symlink planted
 * inside the declared root points outside it while spelling nothing suspicious,
 * and following one has already echoed out-of-root content into a report in
 * this catalog. So the tests below plant an actual symlink and check that the
 * content behind it never appears.
 */

import assert from 'node:assert/strict'
import { symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'

import { isInside, packContext } from '../src/index.mjs'
import { cleanup, findingFor, makeTree, manifest } from './helpers.mjs'

const GOOD = { kind: 'instruction', priority: 0, mandatory: true, tokens: 1, text: 'obey' }
const SECRET = 'THIS-CONTENT-IS-OUTSIDE-THE-ROOT'

test('a lexically escaping path is refused before anything is opened', async (t) => {
  const outer = await makeTree({
    'secret.md': SECRET,
    'inner/manifest.json': manifest({
      good: GOOD,
      escape: { kind: 'evidence', priority: 5, tokens: 1, file: '../secret.md' },
    }),
  })
  t.after(() => cleanup(outer))
  const root = join(outer, 'inner')

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  const finding = findingFor(report, 'path-escapes-root')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.pack, null)
  assert.equal(JSON.stringify(report).includes(SECRET), false)
  assert.equal(finding.location.file, 'manifest.json', 'an escaping path never becomes the reported file')
  assert.equal(finding.evidence, '../secret.md')
})

test('a symlink out of the root is followed to its real path and refused there', async (t) => {
  const outer = await makeTree({
    'secret.md': SECRET,
    'inner/manifest.json': manifest({
      good: GOOD,
      sneaky: { kind: 'evidence', priority: 5, tokens: 1, file: 'innocent.md' },
    }),
  })
  t.after(() => cleanup(outer))
  const root = join(outer, 'inner')
  await symlink(join(outer, 'secret.md'), join(root, 'innocent.md'))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  const finding = findingFor(report, 'path-escapes-root')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.pack, null)
  assert.equal(JSON.stringify(report).includes(SECRET), false, 'out-of-root content must never reach the report')
  assert.match(finding.message, /through a link/)
})

test('a symlink that stays inside the root is read normally', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      good: GOOD,
      linked: { kind: 'evidence', priority: 5, tokens: 1, file: 'link.md' },
    }),
    'real/inside.md': 'inside content',
  })
  t.after(() => cleanup(root))
  await symlink(join(root, 'real', 'inside.md'), join(root, 'link.md'))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.pack.retained.map((entry) => entry.id).sort(), ['good', 'linked'])
})

test('a manifest outside the declared root is a configuration error, not a report', async (t) => {
  const outer = await makeTree({
    'manifest.json': manifest({ good: GOOD }),
    'inner/keep.md': 'x',
  })
  t.after(() => cleanup(outer))

  await assert.rejects(
    () => packContext({ manifest: join(outer, 'manifest.json'), root: join(outer, 'inner'), budgetTokens: 10, tokenCost: 'declared' }),
    /must lie inside the declared root/,
  )
})

test('no reported path is ever absolute', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      good: GOOD,
      absent: { kind: 'evidence', priority: 5, tokens: 1, file: 'sub/absent.md' },
    }),
    'sub/other.md': 'x',
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  assert.ok(report.findings.length > 0)
  for (const finding of report.findings) {
    assert.equal(isAbsolute(finding.location.file), false, `${finding.location.file} is an absolute host path`)
    assert.equal(finding.location.file.includes(root), false)
  }
  assert.equal(findingFor(report, 'segment-file-unreadable').location.file, 'sub/absent.md')
})

test('a directory is not a segment file', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      good: GOOD,
      folder: { kind: 'evidence', priority: 5, tokens: 1, file: 'sub' },
    }),
    'sub/thing.md': 'x',
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  assert.match(findingFor(report, 'segment-file-unreadable').message, /not a regular file/)
  assert.equal(report.status, 'incomplete')
})

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/child'), true)
  assert.equal(isInside('/a/root', '/a/rootsibling/child'), false)
  assert.equal(isInside('/a/root', '/a'), false)
})

test('the manifest itself is bounded and checked before it is read', async (t) => {
  const root = await makeTree({ 'manifest.json': manifest({ good: GOOD }) })
  t.after(() => cleanup(root))
  await writeFile(join(root, 'manifest.json'), manifest({ good: GOOD }))

  const report = await packContext({
    manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared',
    limits: { maxManifestBytes: 8 },
  })
  assert.equal(findingFor(report, 'manifest-too-large').severity, 'error')
  assert.equal(report.status, 'incomplete')
})
