/** The splitter occupies four pixels inside the right-hand editor region. */
export function terminalAvailableHeight(regionHeight: number): number {
  return Math.max(120, regionHeight - 4)
}

export function dragTerminalHeight(savedHeight: number, maximized: boolean, delta: number, regionHeight: number) {
  const available = terminalAvailableHeight(regionHeight)
  const height = (maximized ? available : Math.min(savedHeight, available)) - delta
  return height >= available - 2
    ? { maximized: true, height: savedHeight }
    : { maximized: false, height: Math.max(120, Math.min(height, available)) }
}
