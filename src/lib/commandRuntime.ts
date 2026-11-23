/** Mounted surfaces provide actions without putting views or DOM state into stores. */
export type RuntimeCommand = { run: () => void | Promise<unknown>; available?: () => boolean }
const handlers = new Map<string, RuntimeCommand[]>()

export function registerCommandHandlers(commands: Record<string, RuntimeCommand>): () => void {
  for (const [id, command] of Object.entries(commands)) handlers.set(id, [...(handlers.get(id) ?? []), command])
  return () => {
    for (const [id, command] of Object.entries(commands)) {
      const rest = (handlers.get(id) ?? []).filter(value => value !== command)
      if (rest.length) handlers.set(id, rest)
      else handlers.delete(id)
    }
  }
}
function handlerFor(id: string): RuntimeCommand | undefined {
  return [...(handlers.get(id) ?? [])].reverse().find(handler => !handler.available || handler.available())
}
export const runtimeCommandAvailable = (id: string): boolean => Boolean(handlerFor(id))
/** Capture the eligible surface before palette autofocus changes the source. */
export function captureRuntimeCommand(id: string): RuntimeCommand['run'] | undefined {
  const handler = handlerFor(id)
  return handler ? () => handlers.get(id)?.includes(handler) ? handler.run() : undefined : undefined
}
export function runRuntimeCommand(id: string): void | Promise<unknown> {
  return handlerFor(id)?.run()
}
