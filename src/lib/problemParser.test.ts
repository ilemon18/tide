import { describe, expect, it } from 'vitest'
import { parseProblems } from './problemParser'

describe('parseProblems', () => {
  it('parses compiler and lint locations', () => {
    const problems = parseProblems(
      '\u001b[31msrc/main.ts:12:4: error TS2322: bad type\u001b[0m\nlib/app.ts(4,2): warning: old API',
      '/repo',
      'build',
    )
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatchObject({ rel: 'src/main.ts', line: 12, column: 4, severity: 'error' })
    expect(problems[1]).toMatchObject({ rel: 'lib/app.ts', line: 4, column: 2, severity: 'warning' })
  })

  it('parses Rust arrow locations and filters unsafe paths', () => {
    const problems = parseProblems('--> src/lib.rs:8:9\nerror: expected item\n--> ../outside.rs:1:1\nerror: ignored', '/repo', 'cargo')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ rel: 'src/lib.rs', line: 8, column: 9 })
  })

  it('deduplicates and bounds diagnostics', () => {
    const output = Array.from({ length: 520 }, (_, index) => `src/${index}.ts:1:1: error ${index}`).join('\n')
    expect(parseProblems(output, '/repo', 'test')).toHaveLength(500)
    expect(parseProblems('src/a.ts:1:1: error same\nsrc/a.ts:1:1: error same', '/repo', 'test')).toHaveLength(1)
  })

  it('parses the standard Rust message before its arrow and ignores source gutters', () => {
    const output = 'warning: unused variable: value\n  --> src/lib.rs:4:7\n   |\n4  | let value = 1;\n   |     ^^^^^\n\nerror[E0308]: mismatched types\n  --> src/main.rs:9:2\n'
    expect(parseProblems(output, '/repo', 'cargo')).toMatchObject([
      { rel: 'src/lib.rs', line: 4, column: 7, severity: 'warning', message: 'warning: unused variable: value' },
      { rel: 'src/main.rs', line: 9, column: 2, severity: 'error', message: 'error[E0308]: mismatched types' },
    ])
  })

  it('accepts tsc pretty output, Windows separators and subdirectory tasks', () => {
    expect(parseProblems('src\\main.ts:12:4 - error TS2322: bad type', '/repo', 'build', 'packages/app')).toMatchObject([
      { rel: 'packages/app/src/main.ts', line: 12, column: 4 },
    ])
  })

  it.each(['/tmp/outside.ts', 'C:/outside.ts', 'C:outside.ts', '\\\\server\\share.ts', '../outside.ts', 'src/../outside.ts', 'https://host/file.ts'])('rejects unsafe diagnostic path %s', path => {
    expect(parseProblems(path + ':1:1: error ignored', '/repo', 'build')).toEqual([])
  })

  it('rejects zero/overflow coordinates and escaping working directories', () => {
    expect(parseProblems('src/a.ts:0:1: error bad\nsrc/b.ts:1:0: error bad\nsrc/c.ts:9007199254740992:1: error bad', '/repo', 'build')).toEqual([])
    expect(parseProblems('src/a.ts:1:1: error bad', '/repo', 'build', '../outside')).toEqual([])
  })

  it('strips terminal hyperlinks around a diagnostic', () => {
    expect(parseProblems('\u001b]8;;https://example.com\u0007src/a.ts\u001b]8;;\u0007:2:3: error bad', '/repo', 'build')).toMatchObject([{ rel: 'src/a.ts', line: 2, column: 3 }])
  })
})
