import { invoke } from '@tauri-apps/api/core'
import type { Locale } from '../i18n/types'
import { hasMessage, t } from '../i18n'

export type WorkspaceInfo = { root: string; name: string; isGitRepo: boolean }

export type DirEntryInfo = {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  ignored: boolean
}

export type DirPage = {
  entries: DirEntryInfo[]
  total: number
  hasMore: boolean
  truncated: boolean
}

export type FilePayload = {
  content: string
  size: number
  mtime: number
  binary: boolean
}

export type SavedFile = { size: number; mtime: number }
export type FileStat = { size: number; mtime: number }

export type FileHit = { path: string }
/** Quick-open file index; truncated = hit the limit, so the index is incomplete */
export type FileIndexPage = { files: FileHit[]; truncated: boolean }

export type PathInfo = { isDir: boolean; isFile: boolean; name: string }
export type StartTarget = { roots: string[]; file: string | null }

export type GitFile = { path: string; status: string }

export type GitBranch = {
  /** Local branches use short names (main), remote ones carry the remote (origin/main) */
  name: string
  kind: 'local' | 'remote'
  current: boolean
  upstream: string
  sha: string
  /** Last commit time (unix seconds) */
  time: number
  /** Last commit subject */
  subject: string
}

export type GitBranches = {
  current: string
  detached: boolean
  branches: GitBranch[]
}

/** merge | cherry-pick | revert | rebase */
export type GitOperationKind = 'merge' | 'cherry-pick' | 'revert' | 'rebase' | 'am'

export type GitOperation = {
  kind: GitOperationKind
  label: string
  canSkip: boolean
}

export type GitDiscardResult = {
  restored: string[]
  deleted: string[]
  error: CodedError | null
}

export type GitStatus = {
  isRepo: boolean
  branch: string
  head: string
  ahead: number
  behind: number
  staged: GitFile[]
  changes: GitFile[]
  untracked: GitFile[]
  /** Conflicted files; status is the two-letter XY: UU / AA / DU / UD / AU / UA / DD */
  conflicts: GitFile[]
  operation: GitOperation | null
  pendingMessage: string
  error: string | null
}

/** Mono font: bundled JetBrains Mono / Fira Code / IBM Plex Mono / Source Code Pro, or the system mono stack */
export type MonoFont = 'jetbrains' | 'fira' | 'ibm-plex' | 'source-code' | 'system'

export type Settings = {
  schemaVersion: number
  /** UI language: en (default) | zh-CN | ja | es */
  locale: Locale
  theme: string
  /** File icon set: material | minimal | none */
  iconTheme: string
  /** Code/terminal font */
  fontFamily: MonoFont
  /** UI font size; sidebar, panels and status bar scale with it */
  uiFontSize: number
  fontSize: number
  terminalFontSize: number
  /** Terminal scrollback lines */
  terminalScrollback: number
  tabSize: number
  autoSave: boolean
  wordWrap: boolean
  /** Strip trailing whitespace on save */
  trimTrailingWhitespace: boolean
  /** Ensure files end with a newline on save */
  insertFinalNewline: boolean
  /** Draw indent guides in the editor */
  indentGuides: boolean
  /** Draw ligatures such as == and => as one glyph (off by default) */
  ligatures: boolean
  /** When to format: off | manual | onSave */
  formatMode: 'off' | 'manual' | 'onSave'
  /** Formatter: auto (pick by extension) | prettier | rustfmt | gofmt | black */
  formatTool: 'auto' | 'prettier' | 'rustfmt' | 'gofmt' | 'black'
  showHidden: boolean
  /** Folders holding no files (just one subfolder each) draw as a single row; on by default */
  compactFolders: boolean
  inlineBlame: boolean
  terminalWebgl: boolean
  /** Lightweight mode: smaller caches, fewer background jobs, off by default */
  lightweightMode: boolean
  /** Built-in agent service: title-bar entry, explorer double-click, chat tabs */
  agentEnabled: boolean
  /** Provider / model / effort new chats start with; empty = auto or the CLI default */
  agentDefaultProvider: string
  agentDefaultModel: string
  agentDefaultEffort: string
  sidebarWidth: number
  panelHeight: number
  sidebarVisible: boolean
  panelVisible: boolean
}

/** How the selected tool handles the current file (shown in the status bar) */
export type FormatToolStatus = {
  /** Matched rule, e.g. `*.tsx`; null = this tool does not handle the file */
  rule: string | null
  label: string
  available: boolean
  /** project | bundled | system */
  source: string
}

export type FormatResult = {
  /** Formatted text; null if not run or failed */
  text: string | null
  changed: boolean
  /** project | bundled | system */
  source: string
  error: string | null
  /** true = no prettier in the project, the frontend should use the bundled one */
  fallback: boolean
}

export type RecentWorkspace = { path: string; name: string; openedAt: number }
/** Last opened files; restores the editing session after a restart */
export type SavedTab = { rel: string; line: number; col: number }
export type Session = {
  recent: RecentWorkspace[]
  lastWorkspace: string | null
  roots: string[]
  activeRoot: string | null
  /**
   * Folders that were expanded, per root id. Restored in one go so the explorer paints in its old shape
   * instead of expanding level by level after the window is already visible. The backend carries this in its
   * flattened `extra` map, so no Rust change is needed.
   */
  expanded?: Record<string, string[]>
  /** The next three are maintained by saveOpenTabs alone; saveSession ignores them */
  tabs?: SavedTab[]
  openRoot?: string | null
  activeTab?: string | null
}

export type SearchOptions = {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
  scope: string | null
  /** Only search files matching these globs (comma / space separated) */
  include?: string | null
  /** Skip files matching these globs */
  exclude?: string | null
  maxResults: number
}

export type SearchMatch = {
  line: number
  /** Match offset within the line (1-based) */
  column: number
  length: number
  preview: string
  /** Match start / visible length inside preview */
  previewStart: number
  previewLength: number
}
export type SearchFile = { file: string; matches: SearchMatch[] }
export type SearchResponse = {
  files: SearchFile[]
  total: number
  scanned: number
  truncated: boolean
}
export type ReplaceResponse = { replacedFiles: number; replacedMatches: number }

export type BlameRange = {
  startLine: number
  lineCount: number
  /** Line number of the range's first line in the commit that introduced it */
  origLine: number
  sha: string
  author: string
  authorTime: number
  summary: string
  uncommitted: boolean
}

export type BlameResult = {
  disabled: boolean
  reason: string | null
  lineCount: number
  ranges: BlameRange[]
  latest: BlameRange | null
  root: string
  rel: string
}

export type CommitFile = {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

export type CommitDetail = {
  sha: string
  shortSha: string
  author: string
  email: string
  authorTime: number
  commitTime: number
  subject: string
  body: string
  files: CommitFile[]
  additions: number
  deletions: number
  fileDiff: string
  merge: boolean
}

/**
 * Structured backend errors: Rust always serializes `{ code, params }`, where `code` is a stable
 * error code (with a message in the catalog) and `params` are interpolation values.
 * `code === 'message'` means raw text (git / formatter output) and is not translated.
 */
export type CodedError = { code: string; params: Record<string, string> }

function codedError(e: unknown): CodedError | null {
  if (!e || typeof e !== 'object') return null
  const code = (e as { code?: unknown }).code
  if (typeof code !== 'string' || !code) return null
  const raw = (e as { params?: unknown }).params
  const params: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      params[key] = value === null || value === undefined ? '' : String(value)
    }
  }
  return { code, params }
}

/** Error code; use it to branch on kind, e.g. drop the cache when the dir is gone */
export function errorCode(e: unknown): string | null {
  return codedError(e)?.code ?? null
}

/** Single place to extract an error message */
export function errorText(e: unknown): string {
  const coded = codedError(e)
  if (coded) {
    // Output from external tools: show as-is
    if (coded.code === 'message') return coded.params.message ?? ''
    const key = `error.${coded.code}`
    if (hasMessage(key)) return t(key, coded.params)
    // Code missing from the catalog (old backend / not translated yet): prefer the backend text
    return coded.params.message || t('common.unknownError')
  }
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return t('common.unknownError')
}


/** A local agent CLI found on this machine */
export type AgentProviderInfo = {
  id: string
  name: string
  /** Absolute binary path; null when not installed */
  command: string | null
  version: string | null
  installed: boolean
  /** False = detected, but this version of Tide cannot drive it yet */
  supported: boolean
}

export type AgentModelInfo = {
  id: string
  label: string
  /** Reasoning levels this model accepts; empty = use the catalog's list */
  efforts: string[]
  defaultEffort: string
}

export type AgentCatalog = {
  provider: string
  models: AgentModelInfo[]
  /** Levels offered for the CLI default model and custom ids */
  efforts: string[]
  defaultModel: string
}

/** A file or folder mentioned in a prompt (workspace-relative) */
export type AgentMention = { rel: string; isDir: boolean }

export type AgentQuestionOption = { label: string; description: string }

/** Where a skill was found: the open project, or the user's own CLI config */
export type AgentSkillSource = 'project' | 'user'

export type AgentSkillInfo = {
  name: string
  description: string
  /** Workspace-relative for project skills, absolute for user-level skills */
  path: string
  source: AgentSkillSource
}

export type AgentTurnRequest = {
  chatId: string
  root: string
  provider: string
  /** CLI session to resume; null on the first turn */
  sessionId: string | null
  model: string | null
  effort: string | null
  prompt: string
  mentions: AgentMention[]
  /** Planning turns and their question-answer follow-ups cannot modify the workspace. */
  readOnly: boolean
}

/** Provider-reported usage for one assistant turn. `null` cost means the provider omitted it. */
export type AgentUsage = {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  costUsd: number | null
}

/** One provider-neutral stream event; text and tool items are keyed by id */
export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'textDelta'; itemId: string; text: string }
  | { kind: 'thinking'; itemId: string; text: string }
  | { kind: 'toolStart'; itemId: string; title: string }
  | { kind: 'toolDetail'; itemId: string; detail: string }
  | { kind: 'toolEnd'; itemId: string; ok: boolean; output: string | null }
  | {
      kind: 'question'
      itemId: string
      header: string
      question: string
      multiSelect: boolean
      options: AgentQuestionOption[]
    }
  | { kind: 'questionInvalid'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'usage'; usage: AgentUsage }
  | { kind: 'done'; ok: boolean; cancelled: boolean; code: number | null }

export type AgentEventPayload = { chatId: string; event: AgentEvent }

/** A chat tab restored through agent/tabs.json */
export type AgentTabRef = { id: string; root: string }
export type AgentTabs = { tabs: AgentTabRef[]; active: string | null }

/** Token estimate breakdown */
export type TokenEstimate = {
  total: number
  breakdown: Array<{ kind: 'prompt' | 'file'; label: string; tokens: number }>
}

export const api = {
  // ---- File system ----
  openFolder: (path: string) => invoke<WorkspaceInfo>('open_folder', { path }),
  closeFolder: (root: string) => invoke<void>('close_folder', { root }),
  readDir: (root: string, rel: string, offset: number, limit: number) =>
    invoke<DirPage>('read_dir', { root, rel, offset, limit }),
  /** Deepest folder of a single-child chain starting at `rel` (folder compaction in the tree) */
  resolveDirChain: (root: string, rel: string, showHidden: boolean, maxDepth: number) =>
    invoke<string>('resolve_dir_chain', { root, rel, showHidden, maxDepth }),
  readFile: (root: string, rel: string) => invoke<FilePayload>('read_text_file', { root, rel }),
  /** Raw image bytes; the backend returns them over binary IPC straight into a Blob */
  readImage: (root: string, rel: string) =>
    invoke<ArrayBuffer>('read_image_file', { root, rel }),
  statFile: (root: string, rel: string) => invoke<FileStat>('stat_file', { root, rel }),
  writeFile: (root: string, rel: string, content: string) =>
    invoke<SavedFile>('write_text_file', { root, rel, content }),
  createEntry: (root: string, rel: string, kind: 'file' | 'dir') =>
    invoke<void>('create_entry', { root, rel, kind }),
  renameEntry: (root: string, from: string, to: string) =>
    invoke<void>('rename_entry', { root, from, to }),
  deleteEntry: (root: string, rel: string) => invoke<void>('delete_entry', { root, rel }),
  listFiles: (root: string, limit: number) => invoke<FileIndexPage>('list_files', { root, limit }),
  pathInfo: (path: string) => invoke<PathInfo>('path_info', { path }),
  startTarget: () => invoke<StartTarget>('start_target'),
  revealInFinder: (root: string, rel: string) => invoke<void>('reveal_in_finder', { root, rel }),

  // ---- Git ----
  gitStatus: (root: string) => invoke<GitStatus>('git_status', { root }),
  gitDiff: (root: string, rel: string, staged: boolean) =>
    invoke<string>('git_diff', { root, rel, staged }),
  /** For side-by-side diff: patch with the whole file as context */
  gitDiffFull: (root: string, rel: string, staged: boolean) =>
    invoke<{ patch: string; binary: boolean; truncated: boolean }>('git_diff_full', {
      root,
      rel,
      staged,
    }),
  gitStage: (root: string, paths: string[]) => invoke<void>('git_stage', { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>('git_unstage', { root, paths }),
  gitDiscardChanges: (root: string, trackedPaths: string[], untrackedPaths: string[]) =>
    invoke<GitDiscardResult>('git_discard_changes', { root, trackedPaths, untrackedPaths }),
  gitDiscard: (root: string, paths: string[], fromIndex = false) =>
    invoke<void>('git_discard', { root, paths, fromIndex }),
  gitCommit: (root: string, message: string) => invoke<string>('git_commit', { root, message }),
  /** Undo the last commit (soft reset); returns that commit's message */
  gitUndoCommit: (root: string) => invoke<string>('git_undo_commit', { root }),
  gitPull: (root: string) => invoke<string>('git_pull', { root }),
  gitPush: (root: string) => invoke<string>('git_push', { root }),
  gitFetch: (root: string) => invoke<string>('git_fetch', { root }),
  gitBlame: (root: string, rel: string) => invoke<BlameResult>('git_blame', { root, rel }),
  gitCommitDetail: (
    root: string,
    sha: string,
    rel: string | null,
    line?: number | null,
    origLine?: number | null,
  ) =>
    invoke<CommitDetail>('git_commit_detail', {
      root,
      sha,
      rel,
      line: line ?? null,
      origLine: origLine ?? null,
    }),
  gitBranches: (root: string) => invoke<GitBranches>('git_branches', { root }),
  gitCheckout: (root: string, branch: string, kind: string) =>
    invoke<string>('git_checkout', { root, branch, kind }),
  /** Create a branch from the current HEAD and switch to it */
  gitBranchCreate: (root: string, branch: string) =>
    invoke<string>('git_branch_create', { root, branch }),
  gitUnmerged: (root: string, rel: string) => invoke<boolean>('git_unmerged', { root, rel }),
  gitContinue: (root: string, message: string | null) =>
    invoke<string>('git_continue', { root, message }),
  gitAbort: (root: string) => invoke<string>('git_abort', { root }),
  gitSkip: (root: string) => invoke<string>('git_skip', { root }),
  gitConflictReset: (root: string, rel: string) =>
    invoke<void>('git_conflict_reset', { root, rel }),

  // ---- Window ----
  /** Focus the next Tide window in label order, wrapping at the end */
  cycleWindow: () => invoke<void>('cycle_window'),
  /** true = no new window was opened, an existing one was focused instead */
  newWindow: (path?: string | null) => invoke<boolean>('new_window', { path: path ?? null }),
  /**
   * Atomically claim the project before opening it. true = the project lives in (or is being
   * opened by) another window, which the backend already focused; false = open it here.
   */
  claimProject: (path: string) => invoke<boolean>('claim_project', { path }),
  /** Release the claim: give the project back on cancel or failed open */
  releaseProjectClaim: (path: string) => invoke<void>('release_project_claim', { path }),

  // ---- Search ----
  searchFiles: (root: string, query: string, options: SearchOptions) =>
    invoke<SearchResponse>('search_files', { root, query, options }),
  replaceInFiles: (
    root: string,
    query: string,
    options: SearchOptions,
    replacement: string,
    files: string[],
  ) =>
    invoke<ReplaceResponse>('replace_in_files', { root, query, options, replacement, files }),
  /** Replace one match: line / column use the 1-based character convention search_files reports */
  replaceMatch: (
    root: string,
    rel: string,
    query: string,
    options: SearchOptions,
    replacement: string,
    line: number,
    column: number,
  ) =>
    invoke<ReplaceResponse>('replace_match', {
      root,
      rel,
      query,
      options,
      replacement,
      line,
      column,
    }),

  // ---- Terminal ----
  ptyOpen: (root: string | null, rel: string | null, cols: number, rows: number) =>
    invoke<string>('pty_open', { root, rel, cols, rows }),
  ptyWrite: (id: string, data: string) => invoke<void>('pty_write', { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows }),
  ptyClose: (id: string) => invoke<void>('pty_close', { id }),

  // ---- Settings ----
  loadSettings: () => invoke<Settings>('load_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),
  loadSession: () => invoke<Session>('load_session'),
  saveSession: (session: Session) => invoke<void>('save_session', { session }),
  /** Whether the selected tool handles the current file and which copy it uses (status bar) */
  formatToolStatus: (root: string, rel: string, tool: string) =>
    invoke<FormatToolStatus>('format_tool_status', { root, rel, tool }),
  /** Format: text in, formatted text out (no disk writes); fallback = use bundled Prettier */
  formatText: (root: string, rel: string, tool: string, text: string) =>
    invoke<FormatResult>('format_text', { root, rel, tool, text }),
  /** The project's Prettier config (JSON form, null if absent) */
  prettierConfig: (root: string, rel: string) =>
    invoke<unknown | null>('prettier_config', { root, rel }),
  /** Update only the last opened files, not layout fields (avoids clobbering saveSession) */
  saveOpenTabs: (root: string | null, tabs: SavedTab[], active: string | null) =>
    invoke<void>('save_open_tabs', { root, tabs, active }),
  rememberRecent: (path: string, name: string) =>
    invoke<RecentWorkspace[]>('remember_recent', { path, name }),
  removeRecent: (path: string) => invoke<RecentWorkspace[]>('remove_recent', { path }),

  // ---- Agent ----
  agentProviders: (force = false) => invoke<AgentProviderInfo[]>('agent_providers', { force }),
  agentModels: (provider: string, force = false) =>
    invoke<AgentCatalog>('agent_models', { provider, force }),
  agentSkills: (root: string) => invoke<AgentSkillInfo[]>('agent_skills', { root }),
  agentSend: (request: AgentTurnRequest) => invoke<void>('agent_send', { request }),
  agentCancel: (chatId: string) => invoke<void>('agent_cancel', { chatId }),
  /** Transcripts are opaque frontend JSON; the backend only checks the id and the size */
  agentChatSave: (id: string, body: string) =>
    invoke<void>('agent_chat_save', { id, body }),
  agentChatLoad: (id: string) => invoke<string | null>('agent_chat_load', { id }),
  agentChatDelete: (id: string) => invoke<void>('agent_chat_delete', { id }),
  agentTabsSave: (tabs: AgentTabRef[], active: string | null) =>
    invoke<void>('agent_tabs_save', { tabs, active }),
  agentTabsLoad: () => invoke<AgentTabs>('agent_tabs_load'),
  /** Estimate token count for mentions + prompt */
  agentEstimateTokens: (root: string, mentions: AgentMention[], prompt: string) =>
    invoke<TokenEstimate>('agent_estimate_tokens', { root, mentions, prompt }),
}
