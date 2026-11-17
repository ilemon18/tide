/**
 * One-way callback from the tab store to the agent store. Without this tiny module,
 * `store/tabs` would import `store/agent` while the agent store imports `store/tabs`.
 */
export const agentBridge = {
  /** A chat tab was really closed (not just removed from one pane of a split) */
  onTabClosed: (_chatId: string) => {},
}
