# Changelog

All notable changes to MiniCode will be documented in this file.

## [Unreleased]

Nothing yet.

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
