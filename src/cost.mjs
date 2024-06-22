/**
 * How a segment's token cost is decided.
 *
 * This tool is a packer, not a tokenizer. There are exactly two cost models and
 * the run must name one; there is no default, because "how many tokens is this"
 * decides every retention verdict and guessing it silently is the defect this
 * catalog keeps paying for.
 *
 * - `declared` -- every segment carries its own integer `tokens`, produced by
 *   whatever tokenizer the caller's model actually uses. A segment without a
 *   count is missing evidence: the run goes `incomplete` and no pack is
 *   produced. It is never treated as free.
 * - `estimate` -- the built-in heuristic below counts for every segment, and a
 *   segment that also declares `tokens` is refused rather than silently
 *   overridden.
 */

export const TOKEN_COST_MODELS = Object.freeze(['declared', 'estimate'])

/** Characters of an alphanumeric run the heuristic charges one token for. */
export const CHARS_PER_TOKEN = 4

/**
 * Split into alphanumeric runs and single other characters. Whitespace is free.
 *
 * Kept as a source constant rather than an inline literal so the documented
 * rule and the executed rule are the same text.
 */
const PIECES = /[A-Za-z0-9]+|[^\sA-Za-z0-9]/gu
const ALPHANUMERIC = /^[A-Za-z0-9]+$/

/**
 * A deterministic *estimate* of the tokens a piece of text costs.
 *
 * The rule, in full: every run of ASCII letters and digits costs
 * `ceil(length / 4)`; every other non-whitespace character costs 1; whitespace
 * costs nothing. That is it.
 *
 * **This is not byte-pair encoding and it is not any model's tokenizer.** It
 * has no vocabulary, no merge table and no special tokens, so it will disagree
 * with a real tokenizer -- usually by a few per cent on English prose, by more
 * on code, identifiers and unusual scripts. It exists so a manifest can be
 * packed without a vocabulary file and without a network call, both of which
 * this tool refuses to have. When the number has to be exact, count with your
 * own tokenizer and run in `declared` mode; that is what `declared` is for.
 *
 * It is, however, stable: the same text always costs the same, on every
 * machine, with no locale or ICU data involved.
 */
export function estimateTokens(text) {
  let tokens = 0
  for (const match of String(text).matchAll(PIECES)) {
    const piece = match[0]
    tokens += ALPHANUMERIC.test(piece) ? Math.ceil(piece.length / CHARS_PER_TOKEN) : 1
  }
  return tokens
}
