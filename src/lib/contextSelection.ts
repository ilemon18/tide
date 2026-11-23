/** UI observes only availability. Text is copied once when the user invokes an action. */
export function createSelectionRegistry<T>() {
  const readers = new Map<string, { read: () => T | null; hasSelection: () => boolean }>()
  const available = new Map<string, boolean>()
  const listeners = new Set<() => void>()
  const notify = (id: string) => {
    const next = readers.get(id)?.hasSelection() ?? false
    if ((available.get(id) ?? false) === next) return
    if (next) available.set(id, true)
    else available.delete(id)
    listeners.forEach(listener => listener())
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    has: (id: string) => available.get(id) ?? false,
    read: (id: string) => readers.get(id)?.read() ?? null,
    notify,
    register: (id: string, read: () => T | null, hasSelection: () => boolean) => {
      const entry = { read, hasSelection }
      readers.set(id, entry)
      notify(id)
      return () => {
        if (readers.get(id) !== entry) return
        readers.delete(id)
        notify(id)
      }
    },
  }
}
