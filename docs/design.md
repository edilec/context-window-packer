# Design notes

## Why the tool refuses instead of trimming

The obvious behaviour for a packer that cannot fit its mandatory material is to
fit as much of it as it can. That is the behaviour this tool deliberately does
not have.

A prompt missing half its guardrails is not a smaller prompt, it is a different
one, and it is different in the direction nobody wants: the model answers
without the rules and the run looks like it worked. So the mandatory closure is
selected first, as a set, and if it does not fit the run produces
`mandatory-over-budget`, **no pack at all**, and exit 1. The operator then has a
real decision to make — a bigger window, less mandatory material, or a different
model — and the tool has not made it for them silently.

The same reasoning drives the incomplete rules. A manifest with one unreadable
segment could be packed from the segments that did read, and the result would
look complete. It would be a window that silently lost material. So any missing
evidence suppresses the pack entirely.

## Why a unit is indivisible and a citation is transitive

Both are the same idea: some material is only true in a group.

Half a table is worse than no table, because the numbers in it look whole. A
claim without its evidence is worse than no claim, because the model will stand
behind it anyway. Neither is a ranking problem, so neither is solved by
priorities: they are structural properties of the material, and the manifest
declares them.

The citation closure is transitive because the relation is. If a claim rests on
a summary and the summary rests on a table, dropping the table leaves the
summary unsupported and the claim resting on an unsupported summary.

Closure is computed breadth-first with a visited set, so a citation cycle
terminates. Cycles are legal — two claims can genuinely rest on each other — and
are reported as `citation-cycle` information so the operator knows why two units
are inseparable.

## Why there is no default token cost model

`declared` and `estimate` can disagree by a wide margin, and the disagreement
decides which segments are in the window. A run that does not say which one it
wants would be guessing at the one number that determines the answer.

The estimator exists because requiring a tokenizer would mean either a
dependency or a network call, and this tool has neither. It is documented in
full — `ceil(length / 4)` per alphanumeric run, 1 per other non-whitespace
character, whitespace free — precisely so that nobody mistakes it for a
tokenizer. The README says the same thing in the same words, and
`test/cost.test.mjs` pins the arithmetic character by character, so the
documentation and the behaviour cannot drift apart quietly.

Under `estimate`, a segment that also declares `tokens` is refused rather than
overridden. Silently ignoring a number the operator wrote down is how a
documented field becomes a decorative one.

## Why selection order and assembly order are different

Selection is `(priority, kind rank, unit name)`: you choose material by how much
it matters. Assembly is `(kind rank, priority, id)`: you lay it out by what it
is, so the instructions lead the window rather than landing wherever their
priority put them.

Two orders is one more than necessary and the asymmetry is deliberate. A single
order would force either "a low-priority instruction outranks a high-priority
claim for the budget" or "the guardrails appear in the middle of the evidence".

## Why first fit rather than an optimal packing

A knapsack solver would sometimes fit more tokens. It would also make the answer
depend on a search, and the thing this tool is for is explaining what was
dropped. "It did not fit in priority order, and here is what was left" is an
explanation an operator can act on. "The optimiser preferred a different subset"
is not.

First fit also has the property that raising the budget never removes a segment
that a smaller budget retained, which makes the tool's behaviour predictable
under the one change operators actually make.

## Why the pack is JSON rather than a joined string

The delimiter between segments is a property of the prompt format, and a segment
is untrusted text that may contain any delimiter you pick. Emitting
`--- id ---` separators would create a format that a document can forge. So the
pack destination carries JSON: ids, kinds, priorities, costs and text, in
assembly order, and the caller joins them however their format requires.

The text in that file is **verbatim**. It is the caller's own material on its
way back out, and sanitising it would corrupt the thing being packed. The report
is the sanitised surface; the pack file is not, and the README says so.

## What is guarded, and how

Each of these is a guarantee with a test that fails when the guarantee is
removed, rather than a test that checks a declaration about it:

| Guarantee | Guarded by |
| --- | --- |
| Mandatory material is never silently dropped | `test/acceptance.test.mjs` sweeps 301 budgets and asserts the only alternative to retention is a loud stop; `assertPackInvariants` re-checks every emitted pack |
| An over-budget mandatory set stops clearly | exit code 1 and `pack: null`, asserted as literals |
| Citations stay with claims | a 241-budget sweep asserting no retained segment lost a target |
| Atomic units are never split | a 241-budget sweep asserting two members of one unit are always both in or both out |
| Unknown evidence is never a pass | `test/incomplete.test.mjs` plus one outcome test per rule |
| Severity is not editable by hand | `test/severity-outcomes.test.mjs` writes every expectation as a literal at the assertion site and asserts exit codes |
| Ordering is by code unit | `test/ordering.test.mjs` uses ids that code-unit and collation order differently, and asserts the fixture actually distinguishes them |
| Control characters never reach output | `test/sanitisation.test.mjs` crosses five character classes with eight manifest surfaces, identifiers included |
| A parse failure never reproduces the document | `test/parse-failure.test.mjs`, including the `at position 1` case |
| Paths stay inside the root | `test/confinement.test.mjs` plants a real symlink |
| `--pack-out` never destroys a file it was not given | `test/destination.test.mjs`, one case per hole and one per legitimate destination |
| `--pack-out` never lands in the tree the run reads | `test/destination.test.mjs`, the direct, the `..` and the symlinked-parent spellings, plus the allowed destinations beside the root |

## What `--pack-out` is checked against

`--pack-out` is the one file this tool writes. The destination is a path the
operator names, and a path is not a file: what the path resolves to is a
separate question, and three different answers to it destroyed three different
files here before the guard was written. Every one of them exited 0 and reported
that the pack had been written.

| Refused | Why the obvious check misses it |
| --- | --- |
| A symbolic link at the destination | `realpath` resolves it, and resolving is the dangerous act. `lstat` refuses it before anything is opened, and the write then uses `O_NOFOLLOW` so a link planted between the check and the open is an error from the kernel rather than a write through it. |
| A hard link to an input | It has no target to resolve and shares no path with the input, so `realpath` and string comparison both call it a different file. It is the same file; only device plus inode sees that. |
| Any file this run read | Not only the manifest: every segment file that was opened, and the configuration file. The earlier guard compared the manifest alone, so naming a segment destroyed a document the run had just read. |
| A destination that is not a regular file | A directory or a device node at the destination is not a pack this tool wrote. |
| A destination whose resolved parent lands **inside** `--root` | The list of files a run read is not the same thing as the tree it reads. A sibling document this run never opened -- another manifest's evidence, a file the next edit will reference -- is destroyed by a `--pack-out` that names it, and a pack left in the tree is read back as material by the next run. The parent is resolved before it is judged, so a `..` segment or a symbolic link pointing back in is refused too, and the check runs before the destination's parent directories are created so a refusal leaves no trail inside the tree. |
| A destination whose resolved parent leaves a declared root | The copied guard's own `root` option, which is the *inverse* boundary and is left null by this CLI: outside `--root` the destination is deliberately unconfined, because a pack belongs anywhere the operator likes as long as it is not in the tree. `--help` says so. The check is still pinned by a unit case so the copy stays the guard rather than a subset of it. |

Refusing means exit 2 with nothing on stdout and nothing written: a
configuration that would destroy an input is not a configuration to carry on
with. The list of inputs is complete only once the run has finished, so the
check happens immediately before the write rather than at startup.

The root rule was missing for a release. `--pack-out` accepted a destination
inside `--root`, overwrote a document the run had not opened, and exited 0 with
`wrote 8 retained segment(s)` on stderr -- while this page argued that writing a
pack into the tree the next run reads was the thing to avoid. Naming a hazard is
not guarding it.

## Bounds

Limits are part of the contract rather than a safety net, so each is named in
the finding that reports it and each is reachable from the command line. The one
that matters most for correctness is `timeoutMs`: a time budget that expires
mid-loop returns **no selection at all**, because a pack assembled from a
partial reading is not a smaller answer, it is a wrong one.

`timeoutMs` accepts 0, which means no time at all. That is the only way to prove
from outside the process that the flag reaches the packing loop, and a
documented limit the command line never reaches is a defect this catalog has
already shipped once.
