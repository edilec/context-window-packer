/**
 * Control characters, on every surface an untrusted string can reach.
 *
 * Stripping C0 and the line/paragraph separators is not sanitising: four tools
 * in this catalog did exactly that and let the C1 range through, where U+0085
 * (NEL) and U+009B (8-bit CSI) forge lines and open escape sequences in a human
 * report, and U+202E reverses displayed text.
 *
 * The forbidden set is written out here as numbers rather than imported, so
 * this file and `src/text.mjs` are two independent statements of it rather than
 * one statement checked against itself. And the surfaces below are deliberately
 * not just the excerpt field: a segment id, a unit name, a kind, a citation
 * target, an unknown key (which becomes a JSON Pointer), a schemaVersion and a
 * declared path all arrive from the same untrusted manifest.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { formatReport, packContext, sanitize } from '../src/index.mjs'
import { cleanup, makeTree, manifest, runCli } from './helpers.mjs'

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

const FORBIDDEN = [
  ...range(0x0000, 0x001f), // C0
  0x007f, // DEL
  ...range(0x0080, 0x009f), // C1, including U+0085 NEL and U+009B CSI
  0x2028, 0x2029, // line and paragraph separators
  0x200e, 0x200f, ...range(0x202a, 0x202e), ...range(0x2066, 0x2069), // bidi controls
]

const CLASSES = {
  c0: [0x0009, 0x000a, 0x000d, 0x001b],
  del: [0x007f],
  c1: [0x0085, 0x009b],
  lineSeparators: [0x2028, 0x2029],
  bidi: [0x202e, 0x2066],
}

function offendingCodePoints(text) {
  const found = new Set()
  for (const character of String(text)) {
    const code = character.codePointAt(0)
    if (FORBIDDEN.includes(code)) found.add(code)
  }
  return [...found]
}

/**
 * Every string the report carries, keys included.
 *
 * Scanning the serialised JSON would not work: `JSON.stringify` escapes a
 * control character inside a value, so a leaked newline arrives at the consumer
 * as the two characters backslash-n and no scan of the serialised text can see
 * it -- while the newlines the serialiser puts *between* lines are structure,
 * not content, and would make every such scan fail. The values are what is
 * untrusted, so the values are what is checked.
 */
function everyString(value, into = []) {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) everyString(item, into)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.push(key)
      everyString(item, into)
    }
  }
  return into
}

function offendingInReport(report) {
  const found = new Set()
  for (const text of everyString(report)) for (const code of offendingCodePoints(text)) found.add(code)
  return [...found].sort((left, right) => left - right)
}

/**
 * The human report's line count, derived from the report's own structure.
 *
 * This is the forged-line check: one line per finding, a blank line, the
 * summary line, the pack line, and an incomplete note when there is one. A
 * sanitised string that still held a newline would push the count up, and a
 * U+0085 or U+2028 would do the same on a terminal or in a JavaScript consumer.
 */
function expectedLineCount(report) {
  return report.findings.length + 3 + (report.summary.unexamined > 0 ? 1 : 0) + 1
}

/** Every surface a manifest can push a string onto, as a manifest-building function. */
const SURFACES = {
  'segment id': (hostile) => manifest({ good: GOOD, [`bad${hostile}id`]: { kind: 'context', priority: 9, tokens: 1, text: 'x' } }),
  'unit name': (hostile) => manifest({ good: GOOD, odd: { kind: 'context', priority: 9, tokens: 1, text: 'x', unit: `u${hostile}` } }),
  kind: (hostile) => manifest({ good: GOOD, odd: { kind: `k${hostile}`, priority: 9, tokens: 1, text: 'x' } }),
  'citation target': (hostile) => manifest({ good: GOOD, odd: { kind: 'claim', priority: 9, tokens: 1, text: 'x', cites: [`t${hostile}`] } }),
  'unknown manifest key': (hostile) => JSON.stringify({ schemaVersion: '1', [`k${hostile}`]: 1, segments: { good: GOOD } }),
  'unknown segment key': (hostile) => manifest({ good: GOOD, odd: { kind: 'context', priority: 9, tokens: 1, text: 'x', [`k${hostile}`]: 1 } }),
  schemaVersion: (hostile) => JSON.stringify({ schemaVersion: `1${hostile}`, segments: { good: GOOD } }),
  'declared path': (hostile) => manifest({ good: GOOD, odd: { kind: 'context', priority: 9, tokens: 1, file: `../out${hostile}.md` } }),
}

const GOOD = { kind: 'instruction', priority: 0, mandatory: true, tokens: 5, text: 'obey' }

for (const [className, samples] of Object.entries(CLASSES)) {
  for (const code of samples) {
    test(`${className} U+${code.toString(16).padStart(4, '0').toUpperCase()} never reaches the report, from any surface`, async (t) => {
      const hostile = String.fromCodePoint(code)
      for (const [surface, build] of Object.entries(SURFACES)) {
        const root = await makeTree({ 'manifest.json': build(hostile) })
        t.after(() => cleanup(root))
        const report = await packContext({
          manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared',
        })
        // Something must actually be reported about the hostile value,
        // otherwise this test would pass on a tool that said nothing at all.
        assert.ok(report.findings.length > 0, `${surface} produced no finding to sanitise`)
        assert.deepEqual(offendingInReport(report), [], `${surface} leaked into the JSON report`)
        assert.equal(
          formatReport(report).split('\n').length,
          expectedLineCount(report),
          `${surface} forged a line in the human report`,
        )
      }
    })
  }
}

test('a segment id carrying a newline cannot forge a line in the human report', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      good: GOOD,
      'x\nERROR   forged.md/0 fake-rule this line was written by the manifest': {
        kind: 'context', priority: 9, tokens: 1, text: 'x',
      },
    }),
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  const human = formatReport(report)
  assert.equal(human.split('\n').some((line) => line.startsWith('ERROR   forged.md')), false)
  assert.match(human, /segment-id-invalid/)
})

test('the process boundary is sanitised too, not only the library', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({ good: GOOD, [`bad${String.fromCodePoint(0x0085)}id`]: { kind: 'context', priority: 9, tokens: 1, text: 'x' } }),
  })
  t.after(() => cleanup(root))

  const result = runCli(['--manifest', join(root, 'manifest.json'), '--root', root, '--json', '--token-cost', 'declared', '--budget-tokens', '100'])
  assert.equal(result.status, 2)
  assert.deepEqual(offendingInReport(JSON.parse(result.stdout)), [])
})

test('sanitize bounds its output and marks the cut', () => {
  assert.equal(sanitize('x'.repeat(200)).length, 163)
  assert.ok(sanitize('x'.repeat(200)).endsWith('...'))
  assert.equal(sanitize('a  b\tc'), 'a b c')
  assert.throws(() => sanitize('x', 0), TypeError)
})
