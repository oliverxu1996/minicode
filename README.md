# MiniCode

English | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

MiniCode is an opinionated coding agent that works directly in your repository. Give it a software task — fix a failing test, refactor a module, track down a bug — and it explores the code, makes changes, runs commands, and verifies its own work, while you watch and steer it in your terminal.

MiniCode is deliberately focused: it is a tool for getting software engineering work done, not a general-purpose AI assistant.

## What can it do?

Give MiniCode a task and it can:

- explore an unfamiliar repository — list, find, and search files and code;
- read files with line numbers and paging, and edit them with safe, diff-reviewed changes;
- create new files and run shell commands (tests, builds, git, anything);
- react to failing tests and broken builds — a failure is information, and MiniCode keeps repairing and re-verifying;
- work through multiple iterations on its own until the task is done or it needs you;
- show you everything it is doing, live, as streaming output in your terminal.

A typical task looks like this:

```text
You:  Fix the failing tests in this repository.

MiniCode:
  ▸ read src/math.ts
  ✓ read src/math.ts
  ▸ bash bun test math.test.ts
  ✓ bash bun test math.test.ts      ← observes the failure
  ▸ edit src/math.ts                ← repairs the code
  ✓ edit src/math.ts
  ▸ bash bun test math.test.ts
  ✓ bash bun test math.test.ts      ← verifies: all tests pass

  Fixed the add() function ... All tests pass.
```

You stay in control: interrupt at any time, or type a message mid-task to steer the agent in a different direction.

## Why MiniCode?

Coding agents spend a large share of their effort on exploration and execution — reading files, searching, re-reading, retrying — before ever changing a line of code. MiniCode is built around making that loop work well:

- the agent iterates against the real repository state, not a description of it;
- the coding loop is visible and steerable — you see what it does and can redirect it while it works;
- verification is part of the workflow: the agent is expected to run your tests and prove its changes, not just claim success;
- context is managed deliberately, so long sessions are summarized instead of silently overflowing.

MiniCode is intentionally focused on software development. It is not trying to be a general-purpose AI assistant.

## Quick start

Two ways to install MiniCode. Both run the same agent.

### Standalone binary (Linux x86_64)

Download `minicode-linux-x64` from the
[releases page](https://github.com/oliverxu1996/minicode/releases), then:

```sh
chmod +x minicode-linux-x64
cd ~/my-project
/path/to/minicode-linux-x64
```

The binary is self-contained: no Bun or Node installation is required. Linux
x86_64 is the only platform with a prebuilt binary today.

### npm

**Prerequisite:** [Bun](https://bun.sh) must be installed and available on PATH.

```sh
npm install -g @minicode/cli
cd ~/my-project
minicode
```

On first launch, use `/model` to configure a model, then type a task.

### Running from source

To develop MiniCode itself, run it from a checkout:

```sh
git clone https://github.com/oliverxu1996/minicode.git
cd minicode
bun install

# start MiniCode in your project
bun ./packages/cli/src/main.ts /path/to/your/project
```

On first launch no model is configured. Use `/model` to set one up — MiniCode asks for the protocol (`openai` or `anthropic`), the endpoint, a provider model name, and your API key. Context and output limits are given sensible defaults, with an optional *Configure limits…* step if you need to change them. The configuration is saved locally, and you can switch models later with `/model` or Ctrl+P.

Then type a task, press Enter, and watch it work.

## Configuring a model

MiniCode speaks two protocols, so it works with the official APIs and with any compatible endpoint:

| Protocol | Typical use |
| --- | --- |
| `anthropic` | Anthropic API and Anthropic-protocol endpoints |
| `openai` | OpenAI API and OpenAI-protocol compatible endpoints |

Model commands:

| Command | Purpose |
| --- | --- |
| `/model` | Select an existing model, or choose `Add model…` to configure a new one |
| Ctrl+P | Cycle through configured models |

`/model` is the single interactive model surface. Adding a model asks for the
protocol, endpoint, provider model, and API key, with sensible defaults for the
context and output limits (changeable through an optional `Configure limits…`
step).

Configuration is persisted locally under your config directory
(`~/.minicode/models.json`) — you can also edit that file directly.

## Working with the agent

While a task runs you see everything: the current iteration, each tool call with a live preview of its output, and the assistant's response as it streams in.

- **Steer**: type a message and press Enter while the agent works — it interrupts the current direction and follows your new instruction.
- **Queue**: press Alt+Enter to queue a follow-up that runs after the current task finishes.
- **Interrupt**: press Esc to abort the running task. Queued messages are returned to the editor so nothing is lost.
- **Expand**: press Ctrl+O to show full tool output instead of a short preview.

### Sessions

Your work is saved automatically. Exit and come back later — `--continue` picks up the most recent session in the workspace, and `--resume <id>` restores a specific one. Inside the TUI, `/session` opens an interactive manager for this workspace's sessions, where you can open, search, rename, delete, fork, clone, and browse related sessions.

If MiniCode is interrupted mid-task, the next start reconciles the interrupted work: finished steps are kept, unfinished ones are reported honestly, and you can continue where things stopped.

### Slash commands

| Command | Purpose |
| --- | --- |
| `/help` | List all commands |
| `/compact` | Manually summarize the context |
| `/copy` | Copy the last response to the clipboard |
| `/session` | Manage sessions in this workspace (open, search, rename, delete, fork, clone, related) |
| `/new` | Start a fresh session in the same workspace |
| `/model` | Select or add a model |
| `/trust` · `/reload` | Project resources |
| `/quit` | Exit |

## Project instructions

MiniCode reads instruction files from your repository root to understand your project's conventions before it starts:

- `AGENTS.override.md` — takes precedence when present
- `AGENTS.md`
- `CLAUDE.md`

The first file found is loaded into the agent's system prompt, so the agent follows your project's rules from the first message.

You can also add project-local **prompt templates** (`.minicode/prompts/*.md`) and **skills** (`.minicode/skills/<name>/SKILL.md`). Because these files can direct the agent, MiniCode asks you to trust them first (`/trust`) before it loads project-local ones. Global settings live in `~/.minicode/settings.json` and can be overridden per project in `.minicode/settings.json`.

## Scripting and automation

For non-interactive use — scripts, CI, code review pipelines:

```sh
# run one task and print the final response
minicode -p "explain what this project does" /path/to/project

# emit every runtime event as JSON lines (for tooling)
minicode --mode json -p "find all TODO comments" /path/to/project

# continue the most recent session in this workspace
minicode -c -p "now fix the issue you found" /path/to/project
```

## Status

**Status: early experimental development.** MiniCode is under active development. The current version is v0.1.0 — see [CHANGELOG.md](CHANGELOG.md) for what is included.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
