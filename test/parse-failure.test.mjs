/**
 * The JSON parse-failure helper.
 *
 * V8 embeds the offending input in its own error message, so interpolating
 * `error.message` walks the manifest onto stdout and stderr past every
 * redactor. Truncation does not help: the quoted copy is at the front, and the
 * quoted window can be taken from the middle of a long document.
 *
 * The case that matters most is `at position 1`. A helper that looks for the
 * offset before recognising the quoting shape finds that phrase INSIDE the
 * quoted span and slices the document straight back out. Nineteen of
 * thirty-eight tools in this catalog shipped that bug; every group that wrote
 * this test found it, and the ones that applied the sketch verbatim did not.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { packContext, parseFailureDetail } from '../src/index.mjs'
import { cleanup, findingFor, makeTree } from './helpers.mjs'

function detailFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return parseFailureDetail(error)
  }
  throw new Error('the document parsed, so there is nothing to describe')
}

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  const detail = detailFor('at position 1')
  assert.equal(detail.includes('at position 1'), false)
  assert.equal(detail.includes('"'), false)
  assert.match(detail, /^unexpected token /)
})

test('a credential-only document is never reproduced', () => {
  // The AWS documentation example key: it has to look like a credential for
  // this to prove anything, and it is a published placeholder, not a secret.
  const detail = detailFor('AKIAIOSFODNN7EXAMPLE')
  assert.equal(detail.includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.equal(detail.includes('"'), false)
})

test('a long document with a sensitive prefix is never reproduced', () => {
  const document = `password=hunter2 ${'filler '.repeat(400)}`
  const detail = detailFor(document)
  assert.equal(detail.includes('password'), false)
  assert.equal(detail.includes('hunter2'), false)
  assert.equal(detail.includes('"'), false)
})

test('a quoted span containing a newline is still recognised', () => {
  // Without the `s` flag the quoting pattern silently fails to match here and
  // the helper falls through to the offset branch, which is the leak.
  const detail = detailFor('a\nb"secret-value"\n')
  assert.equal(detail.includes('secret-value'), false)
  assert.equal(detail.includes('"'), false)
})

test('the genuinely safe positional form still yields position, line and column', () => {
  const detail = detailFor('{"alpha": 1,\n"beta" 2}')
  assert.match(detail, /at position \d+/)
  assert.match(detail, /line \d+ column \d+/)
  assert.equal(detail.includes('alpha'), false)
  assert.equal(detail.includes('beta'), false)
})

test('an empty document keeps its own diagnostic', () => {
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
})

test('a message the helper has never seen falls back rather than quoting', () => {
  assert.equal(
    parseFailureDetail(new Error('Something new from a future V8 that "quotes the input" anyway')),
    'the document could not be parsed as JSON',
  )
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})

test('an unparseable manifest is reported without reproducing it', async (t) => {
  const root = await makeTree({ 'manifest.json': 'AKIAIOSFODNN7EXAMPLE' })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 10, tokenCost: 'declared' })
  const finding = findingFor(report, 'manifest-not-json')
  assert.equal(JSON.stringify(report).includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.equal(report.status, 'incomplete')
  assert.match(finding.message, /not valid JSON/)
})
