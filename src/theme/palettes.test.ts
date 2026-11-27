import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, palettes, type Palette, type ThemeId } from './palettes'

/**
 * These are the values Tide consumes from each upstream theme. Keep the source/version list in
 * palettes.ts in sync when refreshing a palette.
 */
const expected: Partial<
  Record<
    ThemeId,
    {
      ui?: Partial<Palette['ui']>
      syntax?: Partial<Palette['syntax']>
      terminal?: Partial<Palette['terminal']>
    }
  >
> = {
  'dark-modern': {
    ui: {
      panelAlt: '#313131',
      activityBar: '#181818',
      titleBar: '#181818',
      tabBar: '#181818',
      statusBar: '#181818',
    },
    syntax: { keyword: '#569cd6', keywordControl: '#c586c0', constant: '#569cd6' },
  },
  'light-modern': {
    ui: {
      panelAlt: '#ffffff',
      muted: '#616161',
      activityBar: '#f8f8f8',
      titleBar: '#f8f8f8',
      tabBar: '#f8f8f8',
      statusBar: '#f8f8f8',
    },
    syntax: {
      keyword: '#0000ff',
      keywordControl: '#af00db',
      constant: '#0000ff',
      property: '#001080',
      invalid: '#cd3131',
    },
  },
  light: {
    ui: { panel: '#f3f3f3', fg: '#000000', accent: '#007acc', selection: '#add6ff' },
    syntax: { keywordControl: '#af00db', constant: '#0000ff', property: '#001080' },
    terminal: { green: '#00bc00', brightGreen: '#14ce14', brightWhite: '#a5a5a5' },
  },
  monokai: {
    ui: { panelAlt: '#414339', hover: '#3e3d32', active: '#75715e', statusBar: '#414339' },
    syntax: { comment: '#88846f', invalid: '#f44747' },
    terminal: {
      black: '#333333',
      red: '#c4265e',
      green: '#86b42b',
      brightYellow: '#e2e22e',
      brightBlue: '#819aff',
      brightCyan: '#66d9ef',
    },
  },
  'solarized-dark': {
    ui: {
      panel: '#00212b',
      panelAlt: '#003847',
      fg: '#839496',
      activityBar: '#003847',
      tabBar: '#004052',
      statusBar: '#00212b',
    },
    syntax: {
      type: '#cb4b16',
      variable: '#268bd2',
      operator: '#839496',
      attribute: '#93a1a1',
    },
    terminal: {
      foreground: '#839496',
      brightBlack: '#002b36',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightCyan: '#93a1a1',
    },
  },
  'solarized-light': {
    ui: {
      panelAlt: '#ddd6c1',
      fg: '#657b83',
      activityBar: '#ddd6c1',
      tabBar: '#d9d2c2',
      statusBar: '#eee8d5',
    },
    syntax: { type: '#cb4b16', operator: '#839496', attribute: '#93a1a1' },
    terminal: { foreground: '#657b83', black: '#073642', brightBlack: '#002b36' },
  },
  dracula: {
    ui: {
      muted: '#6272a4',
      warning: '#ffb86c',
      activityBar: '#343746',
      titleBar: '#21222c',
      tabBar: '#191a21',
      statusBar: '#191a21',
    },
    syntax: { operator: '#f8f8f2', property: '#f8f8f2' },
  },
  'one-dark': {
    ui: {
      panelAlt: '#1d1f23',
      muted: '#495162',
      active: '#2c313a',
      tabBar: '#21252b',
      statusBar: '#21252b',
    },
    syntax: { comment: '#7f848e', property: '#e06c75', invalid: '#f44747' },
    terminal: { black: '#3f4451', red: '#e05561', green: '#8cc265', brightWhite: '#e6e6e6' },
  },
  'github-dark': {
    ui: {
      panel: '#010409',
      fg: '#e6edf3',
      accent: '#1f6feb',
      activityBar: '#0d1117',
      tabBar: '#010409',
      statusBar: '#0d1117',
    },
    syntax: { type: '#7ee787', variable: '#e6edf3', property: '#e6edf3', invalid: '#ffa198' },
    terminal: { foreground: '#e6edf3', cursor: '#2f81f7', brightWhite: '#ffffff' },
  },
  'github-light': {
    ui: {
      panelAlt: '#ffffff',
      tabBar: '#f6f8fa',
      statusBar: '#ffffff',
    },
    syntax: { type: '#116329', variable: '#1f2328', property: '#1f2328', invalid: '#82071e' },
    terminal: { foreground: '#1f2328', selectionBackground: '#add6ff' },
  },
  nord: {
    ui: {
      panel: '#2e3440',
      panelAlt: '#3b4252',
      border: '#3b4252',
      muted: '#4c566a',
      activityBar: '#2e3440',
      statusBar: '#3b4252',
    },
    syntax: { property: '#d8dee9' },
  },
  'tokyo-night': {
    ui: {
      panelAlt: '#14141b',
      border: '#101014',
      fg: '#a9b1d6',
      muted: '#515670',
      activityBar: '#16161e',
      tabBar: '#16161e',
      statusBar: '#16161e',
    },
    syntax: {
      comment: '#51597d',
      type: '#0db9d7',
      punctuation: '#a9b1d6',
      attribute: '#bb9af7',
      invalid: '#ff5370',
    },
    terminal: {
      background: '#16161e',
      foreground: '#787c99',
      green: '#73daca',
      white: '#787c99',
      brightWhite: '#acb0d0',
    },
  },
  'catppuccin-mocha': {
    ui: {
      border: '#585b70',
      hover: '#252535',
      activityBar: '#11111b',
      tabBar: '#11111b',
      statusBar: '#11111b',
    },
    syntax: {
      comment: '#9399b2',
      operator: '#94e2d5',
      tag: '#89b4fa',
      attribute: '#f9e2af',
      property: '#cdd6f4',
      heading: '#f38ba8',
    },
    terminal: { brightRed: '#f37799', brightGreen: '#89d88b', brightWhite: '#bac2de' },
  },
  'catppuccin-latte': {
    ui: {
      border: '#acb0be',
      hover: '#d9dce4',
      activityBar: '#dce0e8',
      tabBar: '#dce0e8',
      statusBar: '#dce0e8',
    },
    syntax: {
      comment: '#7c7f93',
      operator: '#179299',
      tag: '#1e66f5',
      attribute: '#df8e1d',
      property: '#4c4f69',
      heading: '#d20f39',
    },
    terminal: { brightRed: '#de293e', brightGreen: '#49af3d', brightWhite: '#bcc0cc' },
  },
  'gruvbox-dark': {
    ui: { panel: '#282828', active: '#32302f', statusBar: '#282828' },
    syntax: {
      function: '#fabd2f',
      variable: '#83a598',
      tag: '#8ec07c',
      property: '#689d6a',
      heading: '#fe8019',
      invalid: '#cc241d',
    },
    terminal: { black: '#3c3836' },
  },
  'rose-pine': {
    ui: { panel: '#191724', panelAlt: '#232034', activityBar: '#191724', statusBar: '#191724' },
    syntax: {
      keyword: '#31748f',
      function: '#eb6f92',
      tag: '#9ccfd8',
      attribute: '#c4a7e7',
      property: '#e0def4',
    },
    terminal: { cursor: '#6e6a86', green: '#31748f', blue: '#9ccfd8' },
  },
  'rose-pine-dawn': {
    ui: { panel: '#faf4ed', panelAlt: '#f9f2ea', activityBar: '#faf4ed', statusBar: '#faf4ed' },
    syntax: {
      keyword: '#286983',
      function: '#b4637a',
      type: '#56949f',
      tag: '#56949f',
      attribute: '#907aa9',
    },
    terminal: { cursor: '#9893a5', black: '#f2e9e1' },
  },
  'one-light': {
    ui: {
      panel: '#eaeaeb',
      panelAlt: '#ffffff',
      muted: '#9d9d9f',
      accent: '#526fff',
      activityBar: '#fafafa',
      tabBar: '#eaeaeb',
    },
    syntax: { property: '#e45649', heading: '#e45649' },
    terminal: { green: '#00bc00', brightGreen: '#14ce14', brightWhite: '#a5a5a5' },
  },
  'xcode-light': {
    ui: { selection: '#a4cdff' },
    syntax: {
      keyword: '#9b2393',
      comment: '#5d6c79',
      variable: '#326d74',
      attribute: '#815f03',
      heading: '#000000',
    },
    terminal: { cursor: '#000000' },
  },
}

describe('theme palettes', () => {
  it('keeps all theme ids and the default theme stable', () => {
    expect(DEFAULT_THEME).toBe('tide')
    expect(Object.keys(palettes)).toHaveLength(21)
  })

  it('keeps custom themes visually self-contained', () => {
    for (const id of ['tide', 'eyecare'] as const) {
      const p = palettes[id]
      expect(p.ui.activityBar).toBe(p.ui.panel)
      expect(p.ui.titleBar).toBe(p.ui.panel)
      expect(p.ui.tabBar).toBe(p.ui.panel)
      expect(p.ui.statusBar).toBe(p.ui.panel)
      expect(p.syntax.keywordControl).toBeTruthy()
      expect(p.syntax.constant).toBeTruthy()
    }
  })

  it.each(Object.entries(expected))('%s matches its upstream projection', (id, want) => {
    const p = palettes[id as ThemeId]
    expect(p.ui).toMatchObject(want.ui ?? {})
    expect(p.syntax).toMatchObject(want.syntax ?? {})
    expect(p.terminal).toMatchObject(want.terminal ?? {})
  })

  it('gives every official terminal a complete ANSI palette', () => {
    const ansi = [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
      'brightWhite',
    ] as const
    for (const p of Object.values(palettes)) {
      for (const key of [...ansi, 'background', 'foreground', 'cursor', 'selectionBackground'] as const) {
        expect(p.terminal[key], `${p.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })
})
