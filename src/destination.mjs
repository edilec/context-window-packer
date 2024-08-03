/**
 * The write guard: refuse a `--pack-out` destination that would write somewhere
 * the caller did not name, or over something this run is reading.
 *
 * Copied into this package rather than imported: zero dependencies means there
 * is no shared library to put it in, and a guard that lives somewhere else is a
 * guard this package cannot prove it runs. The proof is
 * `test/destination.test.mjs`, which has one case per hole plus the legitimate
 * destinations that must still be allowed -- a guard that refuses everything
 * passes a data-loss test while making `--pack-out` useless.
 *
 * `root` is left null by this tool's CLI and the check is still written and
 * still tested. `--pack-out` names a file anywhere the operator likes -- it is
 * emphatically not confined to the input root, because writing a pack into the
 * tree the next run reads is the thing to avoid -- so there is no boundary for
 * a resolved parent to escape. The other two checks do the work here, and the
 * root check is pinned by a unit case so the copy stays the guard rather than
 * drifting into a subset of it.
 */

import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/** Raised when a destination cannot be written to safely. The caller exits 2. */
export class DestinationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

/**
 * Refuse an output destination that would write somewhere the caller did not
 * name, or over something the caller is reading.
 *
 * Three distinct holes, and each needs its own check because no one of them
 * catches the others:
 *
 * 1. A SYMLINK AT THE DESTINATION writes wherever the link points, which may be
 *    anywhere on the machine. `realpath` on the destination does not help --
 *    it resolves the link, and resolving is precisely the dangerous act. The
 *    link is refused on sight, by `lstat`, before anything is opened.
 * 2. A SYMLINKED PARENT does the same thing one level up, so the parent is
 *    resolved and checked against the root rather than compared lexically.
 *    Lexical comparison passes for `root/link/out` where `link` leaves the root.
 * 3. A HARD LINK TO AN INPUT has no target to resolve and shares no path with
 *    it, so realpath and string comparison both say it is a different file. It
 *    is the same file. Only device plus inode sees that.
 *
 * Measured across this catalog: ten tools accepted a destination that destroyed
 * a file they were never asked to touch, and four exited 0 reporting success.
 * This tool was one of them, three times over. Its previous guard compared the
 * real path of the destination against the real path of the manifest, which
 * caught one spelling of one of the three: a symbolic link at `--pack-out`
 * destroyed a file outside the tree, naming a segment file destroyed a
 * document the same run had just read, and a hard link to the manifest
 * destroyed the manifest -- every one of them exiting 0 and reporting that the
 * pack had been written.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], root = null, label = '--pack-out' } = options
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} is a symbolic link. Writing through it would put the output wherever `
      + `the link points, which is not the path you named, so it is refused. `
      + `Name the real destination.`,
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} exists and is not a regular file.`)
  }

  let parent
  try {
    parent = await realpath(dirname(target))
  } catch {
    throw new DestinationError(`${label} names a directory that does not exist.`)
  }

  if (root !== null) {
    const base = await realpath(resolve(root))
    if (parent !== base && !parent.startsWith(base + sep)) {
      throw new DestinationError(
        `${label} resolves to ${parent}, which is outside the permitted root. `
        + `A link or a ".." segment on the way there does not widen it.`,
      )
    }
  }

  if (existing === null) return target

  // Same file as an input? Compare identity, not paths.
  for (const input of inputs) {
    let source
    try {
      source = await stat(input)
    } catch {
      continue
    }
    if (source.dev === existing.dev && source.ino === existing.ino) {
      throw new DestinationError(
        `${label} is the same file as an input (they share device ${existing.dev} and `
        + `inode ${existing.ino}, so a hard link does not make them different files). `
        + `This tool never rewrites what it reads.`,
      )
    }
  }
  return target
}
