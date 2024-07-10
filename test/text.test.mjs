/**
 * The decoding and ordering primitives.
 *
 * The decoding test is the one that matters: a tool in this catalog inferred
 * "not UTF-8" from a U+FFFD in decoded text, and then disabled that guard for a
 * file that legitimately contained one. The decoder has to decide, and the
 * decoded text never gets a vote.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { byCodeUnit, decodeUtf8, escapePointerSegment, packContext } from '../src/index.mjs'
import { cleanup, makeTree, manifest } from './helpers.mjs'

test('byCodeUnit orders by UTF-16 code unit, which is not collation order', () => {
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'Z'), 1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(byCodeUnit('README', 'assets'), -1)
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('decoding is strict, and a legitimate U+FFFD is not a decoding failure', () => {
  const replacement = new TextEncoder().encode('a � b')
  const decoded = decodeUtf8(replacement)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text, 'a � b')

  assert.equal(decodeUtf8(new Uint8Array([0xc3, 0x28])).ok, false)
  assert.equal(decodeUtf8(new Uint8Array([0xff])).reason, 'not-utf8')
})

test('a segment file that legitimately contains U+FFFD is read, not refused', async (t) => {
  const root = await makeTree({
    'manifest.json': manifest({
      note: { kind: 'evidence', priority: 1, tokens: 3, file: 'note.md' },
    }),
    'note.md': 'the replacement character � appears in this file on purpose',
  })
  t.after(() => cleanup(root))

  const report = await packContext({ manifest: join(root, 'manifest.json'), root, budgetTokens: 100, tokenCost: 'declared' })
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.pack.retained.map((entry) => entry.id), ['note'])
})

test('pointer segments are escaped per RFC 6901 and then sanitised', () => {
  assert.equal(escapePointerSegment('a/b'), 'a~1b')
  assert.equal(escapePointerSegment('a~b'), 'a~0b')
  assert.equal(escapePointerSegment('a~/b'), 'a~0~1b')
  assert.equal(escapePointerSegment('plain'), 'plain')
})
