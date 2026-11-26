export type DiffMarkKind = 'add' | 'mod' | 'del'

export interface DiffMark {
  /** First new-side line of the change (1-based) */
  from: number
  /** Last new-side line of the change (1-based, inclusive) */
  to: number
  kind: DiffMarkKind
}

/**
 * Derive change positions from a full-context unified patch: consecutive `+` lines are an add
 * (a `-` in the same group makes it a modification); only `-` lines are a pure delete, placed
 * just before the line after the deletion. `lines` is the new file's line count.
 *
 * The backend asks git for `-U100000`, so hunk line numbers on the new side are editor line
 * numbers and no frontend diff algorithm is needed.
 */
export function parseDiffMarks(patch: string): { marks: DiffMark[]; lines: number } {
  const marks: DiffMark[] = []
  let newLine = 0
  let adds: number[] = []
  let dels = 0
  let inHunk = false

  const flush = () => {
    if (adds.length > 0) {
      marks.push({ from: adds[0], to: adds[adds.length - 1], kind: dels > 0 ? 'mod' : 'add' })
    } else if (dels > 0) {
      const at = Math.max(1, newLine)
      marks.push({ from: at, to: at, kind: 'del' })
    }
    adds = []
    dels = 0
  }

  for (const line of patch.split('\n')) {
    if (!line) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      flush()
      newLine = Number(hunk[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    // "\ No newline at end of file" is not a content line
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      adds.push(newLine)
      newLine += 1
    } else if (line.startsWith('-')) {
      dels += 1
    } else {
      // Context line (starts with a space in a unified diff)
      flush()
      newLine += 1
    }
  }
  flush()
  return { marks, lines: Math.max(0, newLine - 1) }
}
