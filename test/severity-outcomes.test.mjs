/**
 * Severity, pinned behaviourally.
 *
 * A frozen `ruleId -> severity` table is a good source of truth and a bad
 * guard: when the test also keeps its own expected-value map, the guarantee is
 * three declarations agreeing with each other and one coordinated edit passes.
 *
 * So every assertion here writes its expectation out as a literal at the
 * assertion site -- the severity string, the status string, the exit code, and
 * whether a pack came back -- and takes nothing from a table, a parameter or an
 * import. Flipping one row of RULE_SEVERITY cannot be made to pass by editing
 * the README and one map; it has to be argued with here, rule by rule, and for
 * the rules whose severity decides the verdict it cannot be argued with at all,
 * because an exit code is not editable.
 *
 * Every rule the tool can emit appears exactly once below. The closing test
 * asserts that, so a rule added without an outcome test fails the suite.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY } from '../src/index.mjs'
import { cleanup, findingFor, makeTree, manifest, runCli, runReport } from './helpers.mjs'

const covered = new Set()

/** Build a fixture, run the real CLI over it, and remember which rule was exercised. */
async function exercise(t, ruleId, files, args) {
  covered.add(ruleId)
  const root = await makeTree(files)
  t.after(() => cleanup(root))
  const result = runReport(root, args)
  return { ...result, root }
}

const GOOD = { kind: 'instruction', priority: 0, mandatory: true, tokens: 5, text: 'obey' }

test('citation-cycle is info: the run still passes and still exits 0', async (t) => {
  const { report, status } = await exercise(t, 'citation-cycle', {
    'manifest.json': manifest({
      'claim-a': { kind: 'claim', priority: 1, tokens: 5, cites: ['claim-b'], text: 'a' },
      'claim-b': { kind: 'claim', priority: 2, tokens: 5, cites: ['claim-a'], text: 'b' },
    }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'citation-cycle').severity, 'info')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.notEqual(report.pack, null)
})

test('citation-depth-exceeded is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'citation-depth-exceeded', {
    'manifest.json': manifest({
      a: { kind: 'claim', priority: 1, tokens: 1, cites: ['b'], text: 'a' },
      b: { kind: 'claim', priority: 2, tokens: 1, cites: ['c'], text: 'b' },
      c: { kind: 'evidence', priority: 3, tokens: 1, text: 'c' },
    }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100', '--max-citation-depth', '1'])

  assert.equal(findingFor(report, 'citation-depth-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('citation-unresolved is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'citation-unresolved', {
    'manifest.json': manifest({
      good: GOOD,
      claim: { kind: 'claim', priority: 1, tokens: 1, cites: ['nowhere'], text: 'a' },
    }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'citation-unresolved').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('mandatory-over-budget is an error that fails the run and exits 1', async (t) => {
  const { report, status } = await exercise(t, 'mandatory-over-budget', {
    'manifest.json': manifest({ big: { ...GOOD, tokens: 500 } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '10'])

  assert.equal(findingFor(report, 'mandatory-over-budget').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(status, 1)
  assert.equal(report.pack, null)
})

test('manifest-malformed is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'manifest-malformed', {
    'manifest.json': '[]',
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'manifest-malformed').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('manifest-not-json is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'manifest-not-json', {
    'manifest.json': '{"schemaVersion": "1",',
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'manifest-not-json').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('manifest-not-utf8 is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'manifest-not-utf8', {
    'manifest.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'manifest-not-utf8').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('manifest-schema-unsupported is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'manifest-schema-unsupported', {
    'manifest.json': JSON.stringify({ schemaVersion: '2', segments: { good: GOOD } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'manifest-schema-unsupported').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('manifest-too-large is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'manifest-too-large', {
    'manifest.json': manifest({ good: GOOD }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100', '--max-manifest-bytes', '4'])

  assert.equal(findingFor(report, 'manifest-too-large').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('manifest-unknown-key is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'manifest-unknown-key', {
    'manifest.json': JSON.stringify({ schemaVersion: '1', segment: {}, segments: { good: GOOD } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'manifest-unknown-key').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('manifest-unreadable is an error that makes the run incomplete and exits 2', async (t) => {
  covered.add('manifest-unreadable')
  const root = await makeTree({ 'manifest.json': manifest({ good: GOOD }) })
  t.after(() => cleanup(root))

  const result = runCli([
    '--manifest', join(root, 'absent.json'), '--root', root, '--json',
    '--token-cost', 'declared', '--budget-tokens', '100',
  ])
  const report = JSON.parse(result.stdout)
  assert.equal(findingFor(report, 'manifest-unreadable').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(result.status, 2)
  assert.equal(report.pack, null)
})

test('no-segments is a warning, and the incomplete flag alone keeps it off a green build', async (t) => {
  const { report, status } = await exercise(t, 'no-segments', {
    'manifest.json': manifest({}),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  // Severity says warning, so error counting cannot be what refuses this run.
  assert.equal(findingFor(report, 'no-segments').severity, 'warning')
  assert.equal(report.summary.errors, 0)
  // Remove 'no-segments' from INCOMPLETE_RULES and these three lines fail:
  // status becomes "pass", the exit code becomes 0, and an empty manifest is a
  // green build.
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('path-escapes-root is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'path-escapes-root', {
    'manifest.json': manifest({
      good: GOOD,
      outside: { kind: 'context', priority: 9, tokens: 1, file: '../secret.md' },
    }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'path-escapes-root').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-cost-conflict is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-cost-conflict', {
    'manifest.json': manifest({ good: { kind: 'instruction', priority: 0, tokens: 5, text: 'obey' } }),
  }, ['--token-cost', 'estimate', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-cost-conflict').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-cost-unknown is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-cost-unknown', {
    'manifest.json': manifest({ good: { kind: 'instruction', priority: 0, text: 'obey' } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-cost-unknown').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-dropped is info: a run that drops optional material still passes and exits 0', async (t) => {
  const { report, status } = await exercise(t, 'segment-dropped', {
    'manifest.json': manifest({
      good: GOOD,
      extra: { kind: 'context', priority: 9, tokens: 400, text: 'long' },
    }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-dropped').severity, 'info')
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.notEqual(report.pack, null)
})

test('segment-file-not-utf8 is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-file-not-utf8', {
    'manifest.json': manifest({
      good: GOOD,
      broken: { kind: 'context', priority: 9, tokens: 1, file: 'broken.md' },
    }),
    'broken.md': new Uint8Array([0xc3, 0x28]),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-file-not-utf8').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-file-too-large is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-file-too-large', {
    'manifest.json': manifest({
      good: GOOD,
      big: { kind: 'context', priority: 9, tokens: 1, file: 'big.md' },
    }),
    'big.md': 'x'.repeat(200),
  }, ['--token-cost', 'declared', '--budget-tokens', '100', '--max-segment-bytes', '10'])

  assert.equal(findingFor(report, 'segment-file-too-large').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-file-unreadable is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-file-unreadable', {
    'manifest.json': manifest({
      good: GOOD,
      absent: { kind: 'context', priority: 9, tokens: 1, file: 'absent.md' },
    }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-file-unreadable').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-id-invalid is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-id-invalid', {
    'manifest.json': manifest({ good: GOOD, 'not a valid id': { kind: 'context', priority: 9, tokens: 1, text: 'x' } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-id-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-kind-unknown is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-kind-unknown', {
    'manifest.json': manifest({ good: GOOD, odd: { kind: 'footnote', priority: 9, tokens: 1, text: 'x' } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-kind-unknown').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-malformed is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-malformed', {
    'manifest.json': manifest({ good: GOOD, odd: { kind: 'context', priority: 'high', tokens: 1, text: 'x' } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-malformed').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-source-missing is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-source-missing', {
    'manifest.json': manifest({ good: GOOD, odd: { kind: 'context', priority: 9, tokens: 1 } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-source-missing').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-text-too-large is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-text-too-large', {
    'manifest.json': manifest({ good: GOOD, long: { kind: 'context', priority: 9, tokens: 1, text: 'x'.repeat(50) } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100', '--max-text-chars', '10'])

  assert.equal(findingFor(report, 'segment-text-too-large').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('segment-unknown-key is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'segment-unknown-key', {
    'manifest.json': manifest({ good: GOOD, odd: { kind: 'context', priority: 9, tokens: 1, text: 'x', weight: 3 } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'segment-unknown-key').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('time-budget-exceeded is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'time-budget-exceeded', {
    'manifest.json': manifest({ good: GOOD }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100', '--timeout-ms', '0'])

  assert.equal(findingFor(report, 'time-budget-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('too-many-citations is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'too-many-citations', {
    'manifest.json': manifest({
      good: GOOD,
      'e-one': { kind: 'evidence', priority: 8, tokens: 1, text: 'one' },
      'e-two': { kind: 'evidence', priority: 8, tokens: 1, text: 'two' },
      claim: { kind: 'claim', priority: 9, tokens: 1, cites: ['e-one', 'e-two'], text: 'x' },
    }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100', '--max-citations', '1'])

  assert.equal(findingFor(report, 'too-many-citations').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('too-many-segments is an error that makes the run incomplete and exits 2', async (t) => {
  const { report, status } = await exercise(t, 'too-many-segments', {
    'manifest.json': manifest({ good: GOOD, other: { kind: 'context', priority: 9, tokens: 1, text: 'x' } }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100', '--max-segments', '1'])

  assert.equal(findingFor(report, 'too-many-segments').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(status, 2)
  assert.equal(report.pack, null)
})

test('unit-exceeds-budget is a warning: the run still passes and still exits 0', async (t) => {
  const { report, status } = await exercise(t, 'unit-exceeds-budget', {
    'manifest.json': manifest({
      good: GOOD,
      huge: { kind: 'context', priority: 9, tokens: 5000, text: 'long' },
    }),
  }, ['--token-cost', 'declared', '--budget-tokens', '100'])

  assert.equal(findingFor(report, 'unit-exceeds-budget').severity, 'warning')
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.status, 'pass')
  assert.equal(status, 0)
  assert.notEqual(report.pack, null)
})

test('every rule the tool can emit has an outcome test above', () => {
  const declared = Object.keys(RULE_SEVERITY).sort()
  const exercised = [...covered].sort()
  assert.deepEqual(exercised, declared)
})
