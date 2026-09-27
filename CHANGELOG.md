# Changelog

All notable changes to MiniCode will be documented here.

## [Unreleased]

- Initial project setup.
- Initial model catalog domain with provider and model metadata.
- Read-only `ModelCatalog` providing provider and model lookup.
- Initial workspace TypeScript configuration targeting ES2022.
- `@minicode/model` package: `ModelManager` for model configuration with
  atomic local JSON persistence, `Model` for normalized invocation over the
  `openai` and `anthropic` protocols, normalized errors and stream events,
  and transient-failure retry.
- Canonical structured message model: assistant messages carry text and
  tool-call parts, tool messages carry results correlated by `toolCallId`
  with text/JSON/`tool_error` outputs — preserving call↔result correlation
  across OpenAI and Anthropic wire protocols.
- `@minicode/agent` becomes the Runtime home of the 75/25 context-budget
  helper (`contextBudget`), per the Runtime-owned context-policy boundary.
- MiniCode v0.1 Coding Agent runtime: `MiniCode` root with autonomous
  `run()` over a durable session store, an agent loop with tool-ledger
  crash recovery, reactive compaction against the 75/25 context budget,
  doom-loop/max-iteration guards, and the coding toolset (read, write,
  edit, grep, find, ls, bash) with output truncation and history pruning.
