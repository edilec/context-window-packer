/**
 * The write guard on `--pack-out`, with one case per hole and one per
 * legitimate destination.
 *
 * This tool shipped all three holes open behind a guard that compared the real
 * path of the destination against the real path of the manifest. Every one of
 * the three exited 0 and reported that the pack had been written:
 *
 *   - a symbolic link at `--pack-out` destroyed a file outside the tree;
 *   - naming a segment file destroyed a document the same run had just read,
 *     because only the manifest was compared;
 *   - a hard link to the manifest destroyed the manifest, because it shares no
 *     path with it and `realpath` calls it a different file.
 *
 * The allowed cases are not optional: a guard that refuses every destination
 * passes all three cases above while making `--pack-out` useless.
 */

import assert from 'node:assert/strict'
import { link, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'

import { DestinationError, assertOutsideRoot, assertWritableDestination } from '../src/destination.mjs'
import { cleanup, makeTree, manifest, runCli } from './helpers.mjs'

const KEPT = 'NOTES-THE-USER-KEPT-HERE\n'
const SEGMENT = 'the segment text the user wrote\n'

const TREE = {
  'manifest.json': manifest({
    good: { kind: 'instruction', priority: 0, mandatory: true, tokens: 5, file: 'segments/background.md' },
  }),
  'segments/background.md': SEGMENT,
}

/** A fixture root, an output directory beside it, and somewhere a link can point. */
async function withTree(t) {
  const root = await makeTree(TREE)
  t.after(() => cleanup(root))
  const out = join(root, '..', `${root.split('/').pop()}-out`)
  const elsewhere = join(root, '..', `${root.split('/').pop()}-elsewhere`)
  await mkdir(out, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  t.after(() => cleanup(out))
  t.after(() => cleanup(elsewhere))
  return { root, out, elsewhere }
}

const pack = (root, destination) => runCli([
  '--manifest', join(root, 'manifest.json'), '--root', root, '--json',
  '--token-cost', 'declared', '--budget-tokens', '100', '--pack-out', destination,
])

test('hole 1: a symbolic link at --pack-out is refused, and the file it points at survives', async (t) => {
  const { root, out, elsewhere } = await withTree(t)
  const victim = join(elsewhere, 'notes.txt')
  await writeFile(victim, KEPT)
  await symlink(victim, join(out, 'packed.json'))

  const result = pack(root, join(out, 'packed.json'))
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout stays empty')
  assert.match(result.stderr, /symbolic link/)
  assert.equal(await readFile(victim, 'utf8'), KEPT, 'the file outside the tree is untouched')
})

test('hole 1b: a dangling link creates nothing where it points', async (t) => {
  const { root, out, elsewhere } = await withTree(t)
  await symlink(join(elsewhere, 'created-outside.json'), join(out, 'packed.json'))

  const result = pack(root, join(out, 'packed.json'))
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.deepEqual(await readdir(elsewhere), [], 'nothing was created outside the named path')
})

test('hole 2: a resolved parent outside the permitted root is refused by the guard itself', async (t) => {
  /**
   * This tool's CLI passes no root -- `--pack-out` names a file anywhere the
   * operator likes, deliberately, because writing a pack into the tree the next
   * run reads is the thing to avoid. The check is still part of the guard and
   * is still pinned here, so the copy stays the guard rather than drifting into
   * a subset of it: a lexical prefix test passes for `out/link/pack.json` where
   * `link` leaves the directory, and only resolving the parent sees it.
   */
  const { out, elsewhere } = await withTree(t)
  await symlink(elsewhere, join(out, 'link'))

  await assert.rejects(
    () => assertWritableDestination(join(out, 'link', 'pack.json'), { root: out }),
    (error) => error instanceof DestinationError && /outside the permitted root/.test(error.message),
  )
  await assert.rejects(
    () => assertWritableDestination(join(out, '..', 'escaped.json'), { root: out }),
    DestinationError,
  )
  await assert.doesNotReject(
    () => assertWritableDestination(join(out, 'pack.json'), { root: out }),
    'the same root still allows the destination inside it',
  )
})

test('hole 3: a hard link to an input is refused, and the input survives', async (t) => {
  const { root, out } = await withTree(t)
  const target = join(out, 'packed.json')
  await link(join(root, 'manifest.json'), target)

  const result = pack(root, target)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /same file as an input/)
  assert.equal(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).schemaVersion, '1')
})

test('a segment file this run read is an input too, not just the manifest', async (t) => {
  // The previous guard compared the destination against the manifest alone, so
  // naming a segment file destroyed a document the same run had just read and
  // exited 0 saying the pack was written.
  //
  // A segment always lies inside the root -- confinement refuses one that does
  // not -- so the root rule reaches this destination first and names the tree
  // rather than the file. What is asserted here is that it is refused and that
  // the document survives. The identity comparison that catches a segment under
  // a name of its own is pinned by the hard-link case below, whose destination
  // sits outside the root and can only be caught by device and inode.
  const { root } = await withTree(t)
  const segment = join(root, 'segments', 'background.md')

  const result = pack(root, segment)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(await readFile(segment, 'utf8'), SEGMENT, 'the segment is byte-identical')
})

test('a hard link to a segment file is refused as well', async (t) => {
  const { root, out } = await withTree(t)
  const target = join(out, 'packed.json')
  await link(join(root, 'segments', 'background.md'), target)

  const result = pack(root, target)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(join(root, 'segments', 'background.md'), 'utf8'), SEGMENT)
})

test('a destination that is a directory is refused', async (t) => {
  const { root, out } = await withTree(t)
  await mkdir(join(out, 'packed.json'))
  const result = pack(root, join(out, 'packed.json'))
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /not a regular file/)
})

test('allowed: a fresh destination is written, including one whose directory does not exist yet', async (t) => {
  const { root, out } = await withTree(t)
  const destination = join(out, 'nested', 'packed.json')

  const result = pack(root, destination)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /wrote 1 retained segment\(s\)/)
  const written = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(written.tool, 'context-window-packer')
  assert.equal(written.segments[0].text, SEGMENT)
})

test('allowed: writing over this tool\'s own previous pack', async (t) => {
  const { root, out } = await withTree(t)
  const destination = join(out, 'packed.json')

  assert.equal(pack(root, destination).status, 0)
  const first = await readFile(destination, 'utf8')
  assert.equal(pack(root, destination).status, 0, 'a second run is not refused')
  assert.equal(await readFile(destination, 'utf8'), first, 'and produces the same bytes')
})

test('allowed: a destination reached through a linked ancestor', async (t) => {
  // The false refusal is a defect too, and this is the shape that produces it:
  // on macOS every temporary directory sits under a symbolic link, so a guard
  // that refuses a linked ancestor refuses the ordinary case.
  const { root, out } = await withTree(t)
  const linked = join(out, 'linked')
  await symlink(out, linked)

  const result = pack(root, join(linked, 'packed.json'))
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await readdir(out)).includes('packed.json'), true)
})

test('allowed: other files beside the destination are left alone', async (t) => {
  const { root, out } = await withTree(t)
  const bystander = join(out, 'somebody-elses-notes.txt')
  await writeFile(bystander, KEPT)

  assert.equal(pack(root, join(out, 'packed.json')).status, 0)
  assert.equal(await readFile(bystander, 'utf8'), KEPT)
})

test('the identity comparison is the one a stat makes', async (t) => {
  // Pins the comparison rather than the message: a hard link shares the device
  // and inode of the file it links to, which is the only thing separating it
  // from an unrelated path.
  const { root, out } = await withTree(t)
  const source = join(root, 'manifest.json')
  const hard = join(out, 'hard.json')
  await link(source, hard)

  const [a, b] = [await stat(source), await stat(hard)]
  assert.equal(a.dev === b.dev && a.ino === b.ino, true)
  await assert.rejects(() => assertWritableDestination(hard, { inputs: [source] }), /same file as an input/)
  await assert.doesNotReject(() => assertWritableDestination(hard, { inputs: [] }))
})
/**
 * The opposite boundary: `--pack-out` may be anywhere EXCEPT inside the tree
 * this run reads.
 *
 * Three of the four holes above are about a destination that is one of the
 * files the run opened. This one is about a file it did not: a sibling document
 * in the same tree, belonging to another manifest or waiting to be referenced
 * by the next edit. The tool destroyed one at exit 0 with
 * `wrote 8 retained segment(s)` on stderr, because the only thing the guard
 * compared the destination against was the list of files this particular run
 * happened to read.
 *
 * Refusing it also gives the resolved-parent check something real to enforce
 * here, which is why the lexical and the symlinked spellings each get a case.
 */

test('a destination inside the root is refused, and the sibling document it named survives', async (t) => {
  const { root } = await withTree(t)
  const bystander = join(root, 'segments', 'another-managers-notes.md')
  await writeFile(bystander, KEPT)

  const result = pack(root, bystander)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout stays empty')
  assert.match(result.stderr, /the tree this run reads/)
  assert.equal(await readFile(bystander, 'utf8'), KEPT, 'a file this run never read is still untouched')
})

test('a ".." segment back into the root is refused, and creates nothing there', async (t) => {
  const { root, out } = await withTree(t)
  const destination = join(out, '..', basename(root), 'packed.json')

  const result = pack(root, destination)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal((await readdir(root)).includes('packed.json'), false, 'nothing was written into the root')
})

test('a symlinked parent pointing into the root is refused, where a lexical check passes', async (t) => {
  const { root, out } = await withTree(t)
  await symlink(root, join(out, 'link'))
  const destination = join(out, 'link', 'packed.json')

  // The reason the parent is resolved rather than compared: the path the
  // operator typed contains no part of the root at all.
  assert.equal(destination.startsWith(await realpath(root)), false, 'a prefix test would see nothing wrong')

  const result = pack(root, destination)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal((await readdir(root)).includes('packed.json'), false)
})

test('a parent that does not exist yet is resolved before it is judged, and no directory is created', async (t) => {
  // The CLI creates the destination's parent, so the parent is usually absent
  // at the moment it has to be judged. Falling back to the lexical path there
  // would be a lexical check wearing a resolved check's uniform -- and it would
  // also leave a trail of new directories inside the tree.
  const { root, out } = await withTree(t)
  await symlink(root, join(out, 'link'))

  const result = pack(root, join(out, 'link', 'new', 'deep', 'packed.json'))
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal((await readdir(root)).includes('new'), false, 'not even a directory was created in the root')
})

test('allowed: a sibling directory whose name merely starts with the root\'s is not inside it', async (t) => {
  // `withTree` names the output directory `<root>-out` on purpose: a prefix
  // test without a separator refuses it, which would be a false refusal of the
  // ordinary case.
  const { root, out } = await withTree(t)
  assert.equal(out.startsWith(root), true, 'the two names really do share a prefix')

  const result = pack(root, join(out, 'packed.json'))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(await readFile(join(out, 'packed.json'), 'utf8')).tool, 'context-window-packer')
})

test('allowed: a symbolically linked parent outside the root is still followed', async (t) => {
  // Outside the root the destination is unconfined, which `--help` says. The
  // refusal is about the root, not about links in general.
  const { root, out, elsewhere } = await withTree(t)
  await symlink(elsewhere, join(out, 'linkout'))

  const result = pack(root, join(out, 'linkout', 'packed.json'))
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await readdir(elsewhere)).includes('packed.json'), true)
})

test('assertOutsideRoot compares resolved parents, not spellings', async (t) => {
  const { root, out } = await withTree(t)
  const realRoot = await realpath(root)
  await symlink(root, join(out, 'link'))

  await assert.rejects(
    () => assertOutsideRoot(join(realRoot, 'packed.json'), root),
    (error) => error instanceof DestinationError && /the tree this run reads/.test(error.message),
  )
  await assert.rejects(() => assertOutsideRoot(join(out, 'link', 'packed.json'), root), DestinationError)
  await assert.rejects(() => assertOutsideRoot(join(out, '..', basename(realRoot), 'packed.json'), root), DestinationError)
  await assert.doesNotReject(
    () => assertOutsideRoot(join(out, 'packed.json'), root),
    'a destination outside the root is the ordinary case and must still be allowed',
  )
})
