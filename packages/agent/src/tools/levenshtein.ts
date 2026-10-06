/**
 * Levenshtein edit distance between two strings, with unit insertion,
 * deletion and substitution costs.
 *
 * Shared by the edit tool's fuzzy matchers (scoring how closely a block
 * matches) and the read tool's "did you mean" suggestions. Both need the same
 * standard metric, so it lives in one place rather than as two private copies.
 */
export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const prev = new Uint32Array(b.length + 1)
  const curr = new Uint32Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = a[i] === b[j] ? prev[j] : 1 + Math.min(prev[j], curr[j], prev[j + 1])
    }
    const tmp = prev
    prev.set(curr)
    curr.set(tmp)
  }
  return prev[b.length]
}
