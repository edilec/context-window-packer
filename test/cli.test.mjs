/**
 * The command line: streams, exit codes, and the one file this tool writes.
 *
 * Exit 2 has two shapes and they are not interchangeable. A configuration error
 * means the run never had a subject, so stdout stays empty; an input that could
 * not be read means the run had a subject and failed to get evidence about it,
 * so stdout carries an `incomplete` report naming which input. Both are pinned
 * here, because a consumer piping stdout has to handle the empty case.
 */

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'

import { cleanup, makeTree, manifest, runCli, runReport } from './helpers.mjs'

const GOOD = { kind: 'instruction', priority: 0, mandatory: true, tokens: 5, text: 'obey the rules' }

/**
 * A pack destination beside the root rather than inside it.
 *
 * `--pack-out` may not land in the tree the run reads: a pack written there is
 * read back as material by the next run, and it overwrites whatever file it
 * names on the way. `test/destination.test.mjs` pins the refusal; these cases
 * only need a destination that is not refused.
 */
function outsideRoot(root, t) {
  const directory = join(root, '..', `${basename(root)}-cli-out`)
  t.after(() => cleanup(directory))
  return join(directory, 'packed.json')
}
const TREE = {
  'manifest.json': manifest({
    good: GOOD,
    claim: { kind: 'claim', priority: 4, tokens: 5, cites: ['note'], text: 'a claim' },
    note: { kind: 'evidence', priority: 6, tokens: 5, text: 'the note' },
    bulky: { kind: 'context', priority: 9, tokens: 400, text: 'bulk' },
  }),
}

test('--help exits 0 and documents the exit codes and the cost models', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--token-cost MODEL/)
  assert.match(result.stdout, /Exit codes:/)
  assert.match(result.stdout, /declared/)
  assert.match(result.stdout, /estimate/)
  assert.equal(result.stderr, '')
})

test('exit 2, first shape: a configuration error writes nothing to stdout', () => {
  const result = runCli(['--manifest'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--manifest requires a value/)
})

test('exit 2, second shape: an unreadable input writes an incomplete report to stdout', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const result = runCli([
    '--manifest', join(root, 'absent.json'), '--root', root, '--json',
    '--token-cost', 'declared', '--budget-tokens', '100',
  ])
  assert.equal(result.status, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].location.file, 'absent.json', 'the consumer needs to know which input was not read')
})

test('stdout carries the report and stderr carries the diagnostics', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const result = runCli(['--manifest', join(root, 'manifest.json'), '--root', root, '--json', '--token-cost', 'declared', '--budget-tokens', '100'])
  assert.equal(result.status, 0)
  assert.doesNotThrow(() => JSON.parse(result.stdout), 'stdout must pipe straight into a JSON parser')
  assert.match(result.stderr, /budget 100 token\(s\) from --budget-tokens/)
  assert.match(result.stderr, /cost model declared from --token-cost/)
})

test('without --json stdout carries the human summary instead', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const result = runCli(['--manifest', join(root, 'manifest.json'), '--root', root, '--token-cost', 'declared', '--budget-tokens', '100'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /segment\(s\) resolved in/)
  assert.match(result.stdout, /Retained 3 segment\(s\)/)
})

test('--pack-out writes the retained segments with their text, to a separate destination', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  const destination = outsideRoot(root, t)

  const result = runCli([
    '--manifest', join(root, 'manifest.json'), '--root', root, '--json',
    '--token-cost', 'declared', '--budget-tokens', '100', '--pack-out', destination,
  ])
  assert.equal(result.status, 0)

  const written = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(written.tool, 'context-window-packer')
  assert.equal(written.usedTokens, 15)
  assert.deepEqual(written.segments.map((entry) => entry.id), ['good', 'claim', 'note'])
  assert.equal(written.segments[0].text, 'obey the rules', 'the packed material is verbatim, not a report excerpt')
})

test('--pack-out refuses to name the manifest', async (t) => {
  // The manifest lies inside the root by construction, so the root rule reaches
  // this destination before the identity comparison does. Both refusals matter
  // and both are pinned: the identity one by the hard-link cases in
  // test/destination.test.mjs, whose destinations sit outside the root and can
  // only be caught by device and inode.
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const result = runCli([
    '--manifest', join(root, 'manifest.json'), '--root', root,
    '--token-cost', 'declared', '--budget-tokens', '100', '--pack-out', join(root, 'manifest.json'),
  ])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /the tree this run reads/)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).schemaVersion, '1')
})

test('nothing is written to --pack-out when no pack was produced', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  const destination = outsideRoot(root, t)

  const result = runCli([
    '--manifest', join(root, 'manifest.json'), '--root', root,
    '--token-cost', 'declared', '--budget-tokens', '1', '--pack-out', destination,
  ])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /nothing was written/)
  await assert.rejects(() => readFile(destination, 'utf8'))
})

test('the configuration file supplies the budget and the cost model, and says so on stderr', async (t) => {
  const root = await makeTree({
    ...TREE,
    'packer.config.json': JSON.stringify({ schemaVersion: '1', tokenCost: 'declared', budgetTokens: 100 }),
  })
  t.after(() => cleanup(root))

  const result = runCli(['--manifest', join(root, 'manifest.json'), '--root', root, '--json', '--config', join(root, 'packer.config.json')])
  assert.equal(result.status, 0)
  assert.match(result.stderr, /from the configuration file/)
})

test('an unreadable or malformed configuration file is a configuration error', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  await writeFile(join(root, 'bad.json'), '{ "schemaVersion": "1", ')

  const missing = runCli(['--manifest', join(root, 'manifest.json'), '--root', root, '--config', join(root, 'absent.json')])
  assert.equal(missing.status, 2)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /--config is not usable/)

  const malformed = runCli(['--manifest', join(root, 'manifest.json'), '--root', root, '--config', join(root, 'bad.json')])
  assert.equal(malformed.status, 2)
  assert.equal(malformed.stdout, '')
  assert.match(malformed.stderr, /not valid JSON/)
})

test('the root defaults to the directory holding the manifest', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const withRoot = runReport(root, ['--token-cost', 'declared', '--budget-tokens', '100'])
  const withoutRoot = runCli(['--manifest', join(root, 'manifest.json'), '--json', '--token-cost', 'declared', '--budget-tokens', '100'])
  assert.equal(withoutRoot.status, 0)
  assert.equal(withoutRoot.stdout, withRoot.stdout)
})
