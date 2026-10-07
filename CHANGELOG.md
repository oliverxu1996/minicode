# Changelog

All notable changes to MiniCode will be documented in this file.

## [Unreleased]

### Added

- An empty transcript now opens with a large `MINICODE` block wordmark and the
  descriptor "an opinionated coding agent", followed by the existing keyboard
  hints. The hero is a true empty state: it is centered as a group in the
  transcript viewport — horizontally, and vertically within the available
  transcript height (never against the whole terminal, so it cannot overlap the
  composer/footer) — and it renders only while the session has no conversation
  messages. The first submitted message replaces it outright, so the
  conversation never appears beneath persistent branding and the hero cannot be
  reached again through scrollback; `/new` or a switch to an empty session
  brings it back. It scales to the terminal (5-row wordmark, then 3-row, then a
  single-line fallback) and never blocks the composer, which stays focused and
  usable immediately.

### Changed

- Prompt templates are now discovered live. The editor's `/` autocomplete and
  template invocation read `.minicode/prompts/*.md` (and `~/.minicode/prompts/`)
  from disk as needed, so a template added, edited, or removed while MiniCode
  is running takes effect immediately with no manual refresh. Prompt contents
  were already resolved from disk at invocation time.
- Project-local prompts (`.minicode/prompts/*.md`) and skills
  (`.minicode/skills/<name>/SKILL.md`) now load unconditionally. The
  per-project trust decision was removed, so no consent step is required
  before these resources reach the model. Global resources under
  `~/.minicode/` are unchanged.
- `/model` is now a single command with no subcommands or argument forms. It
  opens one picker that selects an existing configured model or offers
  `Add model…`, which launches the guided configuration wizard. Model
  selection still activates and persists through the runtime `ModelManager`;
  Ctrl+P still cycles configured models. The `add`, `edit <id>`,
  `remove <id>`, direct `<model-id>` activation, and `Configure models…`
  forms are gone, and `/help` no longer advertises arguments.
- `/session` is now the single interactive session-management surface. It
  opens a workspace-scoped manager for the current session's `cwd`, where
  sessions can be opened/switched, searched, renamed, deleted, forked,
  cloned, and browsed by lineage. `/new` remains the direct way to create a
  session. Session management is blocked while a task or compaction is
  running. `--resume <id>` and `--continue` are unchanged.

### Removed

- Slash command `/reload`. Prompt templates are discovered live, `AGENTS.md` /
  `CLAUDE.md` and agent-facing resources load on every run, so there is nothing
  left to refresh manually.
- Slash command `/trust` and the project-trust mechanism behind it
  (`isProjectTrusted`, `trustProject`, and the `projectTrusted` settings
  key). Existing `.minicode/settings.json` files that still contain
  `projectTrusted` remain valid; the key is simply ignored.
- Slash commands `/import` and `/export`. Session portability is not a
  current product need; sessions are still persisted and recovered through
  `--continue`, `--resume`, and `/session`.
- Slash command `/hotkeys`. The always-visible header and `/help` already
  describe the keyboard shortcuts.
- Slash commands `/login` and `/logout`. They were never authentication —
  they configured and removed local models. `/model` is now the sole model
  surface (select or add).
- Slash commands `/resume`, `/name`, `/tree`, `/fork`, and `/clone`. Their
  capabilities now live inside the `/session` manager; they are not retained
  as aliases.

## [0.1.0] - 2026-09-27

First working MiniCode coding-agent baseline: point the terminal UI at a
repository, describe a task, and the agent explores the code, edits files,
runs tests, and repairs failures until the work is verified.

### Added

#### Core

- Coding-agent runtime: `MiniCode` root with autonomous task execution over
  durable, auto-persisted sessions stored as atomic JSON snapshots.
- Agent loop with repeated model/tool interaction, maximum-iteration and
  repeated-call (doom-loop) guards, and deterministic finish reasons.
- Tool execution ledger with explicit `pending → running → succeeded/failed`
  lifecycle, crash-safe checkpoint ordering, and deterministic recovery of
  interrupted runs (safe reissue of idempotent tools, explicit
  unknown-outcome reporting otherwise).
- Orphan-process supervision and a recovery note for the model after
  interrupted sessions.
- Reactive context compaction against a fixed 75/25 input/output budget
  split, plus serialization-time pruning of old tool outputs.
- Runtime events (`RunEvent`) covering iterations, tool calls, results,
  progress, compaction, retries, recovery, and run completion.

#### Model layer

- `ModelManager` for model configuration with atomic local JSON persistence.
- `Model` invocation over `openai` and `anthropic` protocol endpoints with
  normalized streaming events, tool calls, usage, finish reasons, and errors.
- Transient-failure retry with backoff, provider-overload detection, and
  cancellation propagation.
- Canonical structured message model: assistant tool-call parts and tool
  results correlated by `toolCallId`, with text/JSON/error outputs.

#### Coding tools

- `read`, `write`, `edit` (whitespace/fuzzy-tolerant replacement with diffs),
  `grep`, `find`, `ls`, and `bash` tools with output truncation, binary
  detection, and live streaming output for long-running commands.

#### Terminal UI

- Interactive main-screen terminal UI: streaming markdown assistant output,
  tool call/result rendering with live progress, working spinner, status
  footer (model, context usage, workspace), input editor with history,
  multiline input, and `@file` path completion with content embedding.
- Interaction semantics: Enter submits (and steers a running task),
  Alt+Enter queues follow-ups, Esc interrupts, Ctrl+C/Ctrl+D exit,
  Ctrl+O toggles tool output, Ctrl+P cycles models.
- Slash commands: `/help`, `/model`, `/login`, `/logout`, `/new`, `/resume`,
  `/name`, `/session`, `/compact`, `/copy`, `/export`, `/import`, `/trust`,
  `/reload`, `/fork`, `/clone`, `/tree`, `/hotkeys`, `/quit`.
- Session replay on load; session persistence survives interruption.

#### Non-interactive

- Print mode (`-p`) and JSON event mode (`--mode json`) for single-shot and
  scripted usage.
- Session continuation flags (`--continue`, `--resume`).

#### Project & resources

- Project instruction loading (`AGENTS.md` / `CLAUDE.md`) into the system
  prompt.
- Global and project settings with deterministic deep-merge precedence.
- Prompt templates and skills as user/project resources, gated behind an
  explicit project-trust decision for project-local content.
