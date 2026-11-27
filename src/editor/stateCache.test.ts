// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { history, undoDepth } from '@codemirror/commands'
import { afterEach, expect, it, vi } from 'vitest'
import { palettes } from '../theme/palettes'
import * as cmTheme from '../theme/cmTheme'
import { currentThemeExtension, setEditorLook, themeCompartment, gitEditCompartment, gitEditLock } from './stateCache'

afterEach(() => { vi.restoreAllMocks(); setEditorLook(palettes.tide, 13, 'jetbrains') })
it('reconfigures weight and italic without losing dirty text or undo history', () => {
  const build = vi.spyOn(cmTheme, 'buildEditorTheme')
  setEditorLook(palettes.tide, 13, 'fira', 400, false)
  const initial = currentThemeExtension()
  expect(currentThemeExtension()).toBe(initial)
  let state = EditorState.create({ doc: 'original', extensions: [history(), themeCompartment.of(initial)] })
  state = state.update({ changes: { from: 0, insert: 'edited ' } }).state
  setEditorLook(palettes.tide, 13, 'fira', 700, true)
  const styled = currentThemeExtension()
  expect(styled).not.toBe(initial)
  expect(build).toHaveBeenLastCalledWith(palettes.tide, expect.objectContaining({ fontWeight: 700, fontItalic: true }))
  state = state.update({ effects: themeCompartment.reconfigure(styled) }).state
  expect(state.doc.toString()).toBe('edited original')
  expect(undoDepth(state)).toBe(1)
})

it('worktree integration locks editing temporarily without changing text or undo history', () => {
  let state = EditorState.create({ doc: 'base', extensions: [history(), gitEditCompartment.of([])] })
  state = state.update({ changes: { from: 0, insert: 'edit ' } }).state
  state = state.update({ effects: gitEditCompartment.reconfigure(gitEditLock(true)) }).state
  expect(state.facet(EditorState.readOnly)).toBe(true)
  state = state.update({ effects: gitEditCompartment.reconfigure(gitEditLock(false)) }).state
  expect(state.facet(EditorState.readOnly)).toBe(false)
  expect(state.doc.toString()).toBe('edit base')
  expect(undoDepth(state)).toBe(1)
})
