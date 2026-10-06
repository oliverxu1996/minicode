# MiniCode

An opinionated coding agent that works directly in your repository. Give it a
software task — fix a failing test, refactor a module, track down a bug — and
it explores the code, makes changes, runs commands, and verifies its own work
in an interactive terminal UI.

## Install

[Bun](https://bun.sh) must be installed and available on PATH.

```sh
npm install -g @minicode/cli
cd my-project
minicode
```

On first launch no model is configured — use `/model` to set one up
(protocol `openai` or `anthropic`, endpoint, model name, API key), then type a
task. `/model` also adds, edits, and removes models; context/output limits are
defaulted and only exposed under an optional *Configure limits…* step.

## Scripting

```sh
minicode -p "run the tests and report failures"   # print mode
minicode --mode json -p "find TODO comments"      # JSON event stream
minicode -c -p "now fix what you found"           # continue last session
```

## Project instructions

`AGENTS.md` (or `CLAUDE.md`) in the repository root is loaded into the
agent's system prompt. `.minicode/settings.json`, `.minicode/prompts/*.md`
and `.minicode/skills/<name>/SKILL.md` add project settings, prompt
templates, and skills (loaded after `/trust`).

Configuration and sessions live under your user config directory
(`~/.minicode/`) — never inside
this package.

See the repository README for the full product documentation.
