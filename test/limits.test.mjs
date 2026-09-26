/**
 * Every documented limit, enforced from the command line.
 *
 * A documented limit the CLI never wires through is a defect this catalog has
 * already shipped: a config key was accepted and silently ignored because no
 * clock ever reached the walk. So each limit below is driven as a flag, not as
 * a library argument, and each one is checked to actually change the verdict.
 *
 * The other half is refusing what was not documented. A one-character typo in a
 * limit name must not turn a real failure into a green run.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, validateConfig, validateLimits } from '../src/index.mjs'
import { cleanup, findingsFor, makeTree, manifest, runCli, runReport } from './helpers.mjs'

const GOOD = { kind: 'instruction', priority: 0, mandatory: true, tokens: 1, text: 'obey' }

const TREE = {
  'manifest.json': manifest({
    good: GOOD,
    a: { kind: 'claim', priority: 1, tokens: 1, cites: ['b'], text: 'a' },
    b: { kind: 'claim', priority: 2, tokens: 1, cites: ['c'], text: 'b' },
    c: { kind: 'evidence', priority: 3, tokens: 1, file: 'c.md' },
  }),
  'c.md': 'evidence text, several words long',
}

/** flag -> the rule that flag makes fire, one entry per documented limit. */
const CASES = [
  ['--max-citation-depth', '1', 'citation-depth-exceeded'],
  ['--max-citations', '1', 'too-many-citations'],
  ['--max-manifest-bytes', '10', 'manifest-too-large'],
  ['--max-segment-bytes', '2', 'segment-file-too-large'],
  ['--max-segments', '2', 'too-many-segments'],
  ['--max-text-chars', '2', 'segment-text-too-large'],
  ['--timeout-ms', '0', 'time-budget-exceeded'],
]

test('every documented limit is reachable from the command line and changes the verdict', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))

  const wide = await makeTree({
    'manifest.json': manifest({
      good: GOOD,
      e1: { kind: 'evidence', priority: 8, tokens: 1, text: 'one' },
      e2: { kind: 'evidence', priority: 8, tokens: 1, text: 'two' },
      claim: { kind: 'claim', priority: 9, tokens: 1, cites: ['e1', 'e2'], text: 'x' },
    }),
  })
  t.after(() => cleanup(wide))

  // Both fixtures pass with the default limits, so every failure below is the
  // flag's doing and not the fixture's.
  for (const subject of [root, wide]) {
    const clean = runReport(subject, ['--token-cost', 'declared', '--budget-tokens', '100'])
    assert.equal(clean.status, 0)
    assert.equal(clean.report.status, 'pass')
  }

  for (const [flag, value, ruleId] of CASES) {
    // Two citations exist only in the wider fixture, so --max-citations is
    // driven against that one; every other limit bites on TREE.
    const subject = flag === '--max-citations' ? wide : root
    const { report, status } = runReport(subject, ['--token-cost', 'declared', '--budget-tokens', '100', flag, value])

    assert.ok(findingsFor(report, ruleId).length > 0, `${flag} ${value} did not produce ${ruleId}`)
    assert.equal(report.status, 'incomplete', `${flag} ${value} did not make the run incomplete`)
    assert.equal(status, 2, `${flag} ${value} did not exit 2`)
    assert.equal(report.pack, null)
  }
})

test('the limit flags cover every documented limit, with nothing left unwired', () => {
  const flagged = CASES.map(([flag]) => flag.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()))
  assert.deepEqual(flagged.sort(), Object.keys(DEFAULT_LIMITS).sort())
})

test('a misspelled limit is refused rather than ignored', () => {
  assert.throws(() => validateLimits({ maxSegment: 1 }), /Unknown limit "maxSegment"/)
  assert.throws(() => validateLimits({ maxSegments: 0 }), /integer of 1 or more/)
  assert.throws(() => validateLimits({ timeoutMs: -1 }), /integer of 0 or more/)
  assert.equal(validateLimits({ timeoutMs: 0 }).timeoutMs, 0, 'zero is a legal time budget and means no time at all')
  assert.deepEqual(validateLimits(), DEFAULT_LIMITS)
})

test('a misspelled configuration key is refused rather than ignored', () => {
  assert.throws(() => validateConfig({ schemaVersion: '1', tokenCosts: 'declared' }), /Unknown configuration key "tokenCosts"/)
  assert.throws(() => validateConfig({ schemaVersion: '2' }), /Unsupported configuration schemaVersion/)
  assert.throws(() => validateConfig({ schemaVersion: '1', limits: { maxSegment: 2 } }), /Unknown limit/)
  assert.deepEqual(validateConfig({ schemaVersion: '1' }).tokenCost, null)
})

test('an unknown flag and a repeated flag are configuration errors with an empty stdout', async (t) => {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  const base = ['--manifest', join(root, 'manifest.json'), '--root', root, '--token-cost', 'declared', '--budget-tokens', '100']

  const unknown = runCli([...base, '--max-segmentz', '3'])
  assert.equal(unknown.status, 2)
  assert.equal(unknown.stdout, '', 'a run that never had a subject reports nothing')
  assert.match(unknown.stderr, /Unknown option "--max-segmentz"/)

  const repeated = runCli([...base, '--budget-tokens', '5'])
  assert.equal(repeated.status, 2)
  assert.equal(repeated.stdout, '')
  assert.match(repeated.stderr, /--budget-tokens was given more than once/)

  const missing = runCli(['--manifest', join(root, 'manifest.json'), '--budget-tokens', '10'])
  assert.equal(missing.status, 2)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /token cost model is required/)
})

test('a limit given on the command line overrides the same limit in the configuration file', async (t) => {
  const root = await makeTree({
    ...TREE,
    'packer.config.json': JSON.stringify({ schemaVersion: '1', tokenCost: 'declared', budgetTokens: 100, limits: { maxSegments: 500 } }),
  })
  t.after(() => cleanup(root))

  const fromConfig = runReport(root, ['--config', join(root, 'packer.config.json')])
  assert.equal(fromConfig.report.status, 'pass')

  const overridden = runReport(root, ['--config', join(root, 'packer.config.json'), '--max-segments', '2'])
  assert.equal(overridden.report.status, 'incomplete')
  assert.equal(overridden.status, 2)
})
