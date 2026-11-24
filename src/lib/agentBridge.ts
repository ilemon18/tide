/**
 * Small callbacks between the tab store and agent store. Without this tiny module,
 * `store/tabs` would import `store/agent` while the agent store imports `store/tabs`.
 */
export const agentBridge = {
  /** A chat tab was really closed (not just removed from one pane of a split) */
  onTabClosed: (_chatId: string) => {},
  /** Close requests use this callback to protect a chat while its current turn is running. */
  isChatRunning: (_chatId: string) => false,
}
