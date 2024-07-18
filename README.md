# Context Window Packer

Decide which of a set of document segments fit a context window, and say exactly
what was left out and why.

- **Repository:** [edilec/context-window-packer](https://github.com/edilec/context-window-packer)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## What it does

You give it a **manifest**: a JSON file that names each segment of material you
might put in a prompt, what kind of thing it is, how important it is, whether it
is mandatory, which other segments it cites, and where its text comes from. You
give it a token budget. It tells you what fits.

The answer is not a summary and not a compression. Nothing is rewritten and
nothing is truncated: a segment is either in the window or it is not, and every
segment that is not gets a finding explaining why.

## Why it exists

Prompt assembly usually ends up as a loop that appends strings until a counter
passes a threshold. That loop has three failure modes that are invisible until
something goes wrong in production:

1. **The system instructions get trimmed.** They were appended last, or they
   were long, so the truncation ate them. The model then answers without the
   rules it was supposed to obey, and nothing in the log says so.
2. **A claim survives and its evidence does not.** The model is now asked to
   stand behind an assertion whose support is outside the window, which is
   exactly the shape that produces confident fabrication.
3. **Half a table arrives.** The loop cut at a character count, so three rows of
   a five-row table are in the window and the totals are wrong rather than
   missing.

This tool makes all three structurally impossible, and refuses the job rather
than doing any of them quietly:

- **Mandatory material is selected first**, together with everything it cites.
  If it does not fit, you get `mandatory-over-budget`, **no pack at all**, and
  exit 1. There is no arrangement of inputs where a pack comes back with a
  mandatory segment missing.
- **Citations travel with claims.** Selection works on the transitive closure of
  the citation graph, so a claim and its evidence are retained together or
  dropped together.
- **Atomic units are indivisible.** Segments sharing a `unit` name are one
  piece: all of them, or none.

The approach is informed by two upstream projects, neither of which is a
dependency and neither of which has any code here. [openai/tiktoken][tiktoken]
is why token cost is an explicit, named, caller-supplied quantity rather than a
character count divided by four and hoped over; [microsoft/LLMLingua][llmlingua]
is why "what was dropped and why" is a first-class output rather than a log
line. Nothing is installed, nothing is fetched, and nothing is copied.

[tiktoken]: https://github.com/openai/tiktoken
[llmlingua]: https://github.com/microsoft/LLMLingua

## Quick start

```bash
# Pack the worked example and write the retained segments out
node bin/context-window-packer.mjs \
  --manifest examples/brief/manifest.json \
  --config examples/packer.config.json \
  --pack-out build/example-pack.json

# The same run as machine-readable JSON
node bin/context-window-packer.mjs \
  --manifest examples/brief/manifest.json \
  --token-cost estimate --budget-tokens 240 --json

# A manifest whose mandatory instructions do not fit: exits 1
node bin/context-window-packer.mjs \
  --manifest examples/over-budget/manifest.json \
  --token-cost declared --budget-tokens 256

# Everything: lint, tests, both examples, packaging
npm run check
```

## The manifest

```json
{
  "schemaVersion": "1",
  "segments": {
    "guardrails": {
      "kind": "instruction",
      "priority": 0,
      "mandatory": true,
      "file": "segments/guardrails.md"
    },
    "claim-latency": {
      "kind": "claim",
      "priority": 10,
      "cites": ["evidence-latency-p50", "evidence-latency-p99"],
      "text": "Tail latency in eu-west is materially worse than in us-east."
    },
    "evidence-latency-p50": {
      "kind": "evidence",
      "priority": 40,
      "unit": "latency-table",
      "file": "segments/latency-p50.md"
    }
  }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | `instruction`, `claim`, `evidence` or `context`. Decides assembly order. |
| `priority` | yes | Integer 0-1000. **Lower is more important** and is packed first. |
| `mandatory` | no | `true` means this segment is never dropped. Default `false`. |
| `unit` | no | Atomic unit name. Segments sharing one are retained or dropped together. Defaults to the segment's own id. |
| `cites` | no | Segment ids this one rests on. Retaining this segment retains all of them, transitively. |
| `text` | one of | The segment's text, inline. |
| `file` | one of | A path, relative to the root, holding the segment's text. |
| `tokens` | in `declared` mode | The segment's cost, from your own tokenizer. |

Segment ids and unit names are 1-64 characters of letters, digits, dot, dash or
underscore, starting with a letter or digit.

## How the choice is made

1. Segments are grouped into **units**. A unit's cost is the sum of its members;
   its priority and kind rank are its members' lowest; it is mandatory if any
   member is.
2. The **mandatory closure** is taken: every mandatory unit plus everything it
   cites, transitively. If that costs more than the budget the run stops with
   `mandatory-over-budget`, emits no pack, and exits 1.
3. Remaining units are offered the rest of the budget in `(priority, kind rank,
   unit name)` order, each with the part of its closure not already selected. A
   unit whose closure does not fit is dropped and the next unit is still offered
   what is left.
4. Retained segments are assembled in `(kind rank, priority, id)` order, so the
   instructions lead the window. Selection goes by importance; assembly goes by
   role.

This is **first fit in priority order, not an optimal knapsack** — see
non-goals.

## Token cost: two models, no default

There is no default cost model, because the two can disagree by a wide margin
and the disagreement is the whole verdict.

- `--token-cost declared` — every segment carries an integer `tokens`, counted by
  whatever tokenizer your model actually uses. A segment without one is
  **missing evidence**: the run goes `incomplete` and produces no pack. It is
  never treated as free.
- `--token-cost estimate` — the built-in heuristic counts. The rule, in full: a
  run of ASCII letters and digits costs `ceil(length / 4)`; every other
  non-whitespace character costs 1; whitespace costs nothing. A segment that
  also declares `tokens` is refused rather than silently overridden.

**The estimator is not byte-pair encoding and it is not any model's tokenizer.**
It has no vocabulary, no merge table and no special tokens, so it will disagree
with a real tokenizer — usually by a few per cent on English prose, by more on
code, identifiers and unusual scripts. It exists so a manifest can be packed
without a vocabulary file and without a network call, both of which this tool
refuses to have. When the number must be exact, count with your own tokenizer
and use `declared`.

## Rules

Every finding takes its severity from one frozen table in `src/index.mjs`. An
unknown rule id throws rather than defaulting.

| Rule | Severity | Incomplete | Meaning |
| --- | --- | :---: | --- |
| `citation-cycle` | info | | Units cite each other in a loop, so they travel together. Legal. |
| `citation-depth-exceeded` | error | yes | A citation chain is longer than `maxCitationDepth`. |
| `citation-unresolved` | error | yes | A `cites` entry names no surviving segment. |
| `mandatory-over-budget` | error | | The mandatory closure does not fit. **No pack; exit 1.** |
| `manifest-malformed` | error | yes | The manifest, or its `segments` key, is not a JSON object. |
| `manifest-not-json` | error | yes | The manifest did not parse. |
| `manifest-not-utf8` | error | yes | The manifest is not valid UTF-8. |
| `manifest-schema-unsupported` | error | yes | `schemaVersion` is not `"1"`. |
| `manifest-too-large` | error | yes | Above `maxManifestBytes`; not read. |
| `manifest-unknown-key` | error | yes | A top-level key this tool does not define. |
| `manifest-unreadable` | error | yes | The manifest could not be opened. |
| `no-segments` | warning | yes | Nothing was resolved. A pass on no evidence is not a pass. |
| `path-escapes-root` | error | yes | A segment path leaves the root, lexically or through a link. |
| `segment-cost-conflict` | error | yes | `tokens` declared under `estimate`, which would ignore it. |
| `segment-cost-unknown` | error | yes | No `tokens` under `declared`. Never treated as free. |
| `segment-dropped` | info | | This segment did not fit. Names the cost and what was left. |
| `segment-file-not-utf8` | error | yes | A segment file is not valid UTF-8. |
| `segment-file-too-large` | error | yes | Above `maxSegmentBytes`; not read. |
| `segment-file-unreadable` | error | yes | A segment file could not be opened, or is not a regular file. |
| `segment-id-invalid` | error | yes | A segment id breaks the identifier rule. |
| `segment-kind-unknown` | error | yes | `kind` is not one of the four. |
| `segment-malformed` | error | yes | A field has the wrong type or is out of range. |
| `segment-source-missing` | error | yes | Neither `text` nor `file`, or both. |
| `segment-text-too-large` | error | yes | Above `maxTextChars`. |
| `segment-unknown-key` | error | yes | A segment key this tool does not define. |
| `time-budget-exceeded` | error | yes | `timeoutMs` expired. No partial pack is produced. |
| `too-many-citations` | error | yes | Above `maxCitations` on one segment. |
| `too-many-segments` | error | yes | Above `maxSegments`. |
| `unit-exceeds-budget` | warning | | A unit costs more than the entire budget; no freeing would help. |

"Incomplete" means the rule marks the run `incomplete`, suppresses the pack
entirely, and exits 2 — whatever else the run found.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | The manifest was read and everything mandatory fits. | the report |
| `1` | The manifest was read and the mandatory material does not fit. | the report |
| `2` | Invalid usage or configuration — the run never had a subject. | **empty** |
| `2` | Evidence missing, undecodable or bounded out. | an `incomplete` report |

A consumer piping stdout must handle the empty case. Emitting a fake report for
a run that never started would be worse.

stdout carries exactly one of the two renderings of the report and nothing else;
stderr carries diagnostics — where the budget came from, whether a pack was
written, whether the run was incomplete.

## Limits

Every limit is enforced, overridable from the command line, and named in the
finding when it is reached. Exceeding one is an `incomplete` result with no
pack — never a quietly shorter window.

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxCitationDepth` | `--max-citation-depth` | 8 |
| `maxCitations` | `--max-citations` | 20 |
| `maxManifestBytes` | `--max-manifest-bytes` | 1048576 |
| `maxSegmentBytes` | `--max-segment-bytes` | 262144 |
| `maxSegments` | `--max-segments` | 500 |
| `maxTextChars` | `--max-text-chars` | 200000 |
| `timeoutMs` | `--timeout-ms` | 10000 |

`timeoutMs` accepts 0, and 0 means no time at all: the first check fires. That
is how the flag is proved to be wired through from the outside.

An unknown limit name, an unknown configuration key and an unknown command-line
option are all refused rather than ignored. A one-character typo must not turn a
real failure into a green run.

## Non-goals

This tool deliberately does not:

- **Tokenize.** The estimator is a documented heuristic. Exact counts come from
  your tokenizer, through `declared`.
- **Compress, summarise or rewrite.** Segments go in whole or not at all. There
  is no paraphrasing, no sentence dropping and no truncation of a segment.
- **Solve the knapsack optimally.** Selection is first fit in priority order. A
  cleverer packing could sometimes fit more tokens; it would also make the
  answer depend on a search whose result is hard to explain, and "explain what
  was dropped" is the point.
- **Rank or score material.** Priorities come from the manifest. It does not
  decide what matters; see `context-priority-ranker` for that job.
- **Assemble the final prompt string.** `--pack-out` emits JSON with the
  retained segments and their text, in assembly order. Joining them is yours,
  because the delimiter is a property of your prompt format and a document that
  could forge a delimiter is exactly the input this tool expects.
- **Read or embed anything on the network.** There is no fetching, no provider
  call, no telemetry, at any time, including in the tests.
- **Write anything except `--pack-out`.** It is read-only otherwise, and it
  refuses a `--pack-out` that names the manifest.
- **Count what your model will actually charge you.** Token cost here is the
  cost of the material. Prompt templating, tool schemas, chat framing and the
  model's own reply are not in the manifest and are not counted.

## Layout

- `src/text.mjs` — decoding, ordering, sanitising, the parse-failure helper
- `src/cost.mjs` — the two cost models
- `src/manifest.mjs` — manifest shape and validation
- `src/pack.mjs` — units, citation closure, the packing decision, the invariants
- `src/index.mjs` — the rule table, limits, the entry point, the report
- `bin/context-window-packer.mjs` — the command line
- `docs/design.md` — the decisions behind the above
- `examples/` — a manifest that packs, and one that cannot

## Verification

```bash
npm run check   # lint, tests, both examples, npm pack --dry-run
```

The suite is written against the guarantees above rather than around them.
`test/acceptance.test.mjs` sweeps three hundred budgets and asserts that a
mandatory segment is either retained or the run stopped loudly, that no retained
segment ever lost a citation, and that an atomic unit is never split.
`test/severity-outcomes.test.mjs` drives every rule through the real command
line and asserts the exit code, so a severity cannot be flipped by editing a
table. `test/ordering.test.mjs` uses ids whose code-unit order differs from
collation order and asserts the exact emitted sequence.

## License

MIT. See [LICENSE](./LICENSE).
