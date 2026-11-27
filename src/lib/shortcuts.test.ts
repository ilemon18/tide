import { describe, expect, it } from 'vitest'
import { COMMANDS } from './commandRegistry'
import { assignShortcuts, formatBinding, formatModifiers, isReservedShortcut, normalizeOverrides,
  normalizeShortcut, overridesEqual, resolveShortcuts, shortcutConflicts, shortcutFromEvent,
  shortcutIdentity, shortcutModifiers } from './shortcuts'

describe.each([true, false])('shortcut ownership (mac=%s)', mac => {
  it('uses Shift+A for Agent and leaves select-all to native controls', () => {
    const resolved = resolveShortcuts({}, mac)
    expect(resolved['agent.ask']).toEqual(['Mod+Shift+a'])
    expect(isReservedShortcut('Mod+a', mac)).toBe(true)
    expect(isReservedShortcut('Mod+Shift+a', mac)).toBe(false)
    const identities = Object.values(resolved).flat().map(key => shortcutIdentity(key, mac))
    expect(new Set(identities).size).toBe(identities.length)
    expect(new Set(COMMANDS.map(command => command.id)).size).toBe(COMMANDS.length)
  })

  it('persists replacement of defaults and preserves other bindings after reload', () => {
    const first = assignShortcuts('agent.ask', ['Mod+Shift+p'], {}, mac)
    expect(first['view.commands']).toEqual([])
    const loaded = normalizeOverrides(JSON.parse(JSON.stringify(first)))
    expect(resolveShortcuts(loaded, mac)['view.commands']).toEqual([])
    expect(resolveShortcuts(loaded, mac)['agent.ask']).toEqual(['Mod+Shift+p'])
    const second = assignShortcuts('agent.ask', ['f2'], loaded, mac)
    expect(second['tree.rename']).toEqual(['Mod+r'])
    expect(resolveShortcuts(second, mac)['tree.rename']).toEqual(['Mod+r'])
  })

  it('detects conflicts even when actions are unavailable and reserves editing strokes', () => {
    expect(shortcutConflicts('agent.ask', ['Mod+r'], {}, mac)).toEqual(['tree.rename'])
    for (const key of ['a', 'c', 'v', 'x', 'z', 'y']) {
      expect(assignShortcuts('agent.ask', ['Mod+' + key], {}, mac)['agent.ask']).toEqual([])
    }
  })

  it('matches exact modifiers and normalizes shifted punctuation and Option letters', () => {
    const event = { key: '{', code: 'BracketLeft', metaKey: mac, ctrlKey: !mac, shiftKey: true, altKey: false }
    expect(shortcutFromEvent(event, mac)).toBe('Mod+Shift+[')
    expect(shortcutFromEvent({ ...event, key: '\u03a9', code: 'KeyZ', metaKey: false, ctrlKey: false,
      shiftKey: false, altKey: true }, mac)).toBe('Alt+z')
    expect(shortcutIdentity('Mod+Shift+[', mac)).not.toBe(shortcutIdentity('Mod+[', mac))
  })
})

it('treats Ctrl and Mod as the same physical stroke only on Ctrl platforms', () => {
  expect(shortcutIdentity('Mod+g', false)).toBe(shortcutIdentity('Ctrl+g', false))
  expect(shortcutIdentity('Mod+g', true)).not.toBe(shortcutIdentity('Ctrl+g', true))
  const next = assignShortcuts('agent.ask', ['Ctrl+g'], {}, false)
  expect(next['view.quickOpen']).toEqual(['Mod+p'])
})

it.each([true, false])('opens files with P and G while leaving line jumps in the same picker (mac=%s)', mac => {
  const resolved = resolveShortcuts({}, mac)
  const bindings = resolved['view.quickOpen'].map(key => shortcutIdentity(key, mac))
  expect(bindings).toContain(shortcutIdentity('Mod+p', mac))
  expect(bindings).toContain(shortcutIdentity('Mod+g', mac))
  expect(bindings).toContain('Ctrl+g')
  expect(resolved['view.gotoLine']).toEqual([])
  const reassigned = assignShortcuts('agent.ask', ['Mod+g'], {}, mac)
  expect(resolveShortcuts(reassigned, mac)['view.quickOpen'].map(key => shortcutIdentity(key, mac)))
    .not.toContain(shortcutIdentity('Mod+g', mac))
})

it('normalizes damaged fields independently, preserves explicit removals and unknown ids', () => {
  expect(normalizeOverrides(null)).toEqual({})
  const next = normalizeOverrides({ future: ['Mod+Shift+q'], 'file.save': [], invalid: 4,
    mixed: ['Mod+s', 7, 'nonsense'], broken: ['bad'] })
  expect(next).toEqual({ future: ['Mod+Shift+q'], 'file.save': [], mixed: ['Mod+s'] })
  expect(resolveShortcuts(next).future).toBeUndefined()
  expect(overridesEqual({ a: ['Mod+s'], b: [] }, { b: [], a: ['Mod+s'] })).toBe(true)
  expect(overridesEqual({}, { 'file.save': [] })).toBe(false)
})

it('rejects unmodified typing and formats platform-appropriate labels', () => {
  for (const value of ['a', 'Shift+a', 'Control+a', 'Mod+Mod+s', 'escape', 'Shift+enter']) {
    expect(normalizeShortcut(value)).toBeNull()
  }
  expect(formatBinding('Mod+Shift+a', true)).toBe('⌘⇧A')
  expect(formatBinding('Mod+Shift+a', true, { spaced: true })).toBe('⌘ ⇧ A')
  expect(formatBinding('Mod+Shift+a', false)).toBe('Ctrl+Shift+A')
})

it('formats partial modifier previews for the recording field', () => {
  const command = { key: 'Meta', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
  expect(formatModifiers(shortcutModifiers(command, true), true)).toBe('⌘')
  const commandShift = { ...command, key: 'Shift', shiftKey: true }
  expect(formatModifiers(shortcutModifiers(commandShift, true), true)).toBe('⌘ ⇧')
  expect(formatModifiers(shortcutModifiers({ ...command, metaKey: false, ctrlKey: true }, false), false))
    .toBe('Ctrl')
})
