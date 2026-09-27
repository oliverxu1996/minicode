# MiniCode

[English](README.md) | 简体中文 | [한국어](README.ko.md) | [日本語](README.ja.md)

MiniCode 是一个专注的编码智能体，直接在你的代码仓库里工作。给它一个软件任务——修复失败的测试、重构一个模块、定位一个缺陷——它会阅读代码、进行修改、执行命令并自行验证结果，而你可以在终端里实时观察并随时调整它的方向。

MiniCode 刻意保持专注：它是用来完成软件工程工作的工具，而不是一个通用的 AI 助手。

## 它能做什么？

给 MiniCode 一个任务，它可以：

- 探索陌生的代码仓库——列出、查找、搜索文件和代码；
- 带行号、分页地阅读文件，并以安全的、带 diff 审查的方式修改它们；
- 创建新文件，执行 shell 命令（测试、构建、git，任何命令）；
- 应对失败的测试和损坏的构建——失败是一种信息，MiniCode 会持续修复并重新验证；
- 自主进行多轮迭代，直到任务完成或确实需要你的帮助；
- 在终端里实时展示它正在做的一切。

一个典型的任务是这样的：

```text
你：  修复这个仓库里失败的测试。

MiniCode:
  ▸ read src/math.ts
  ✓ read src/math.ts
  ▸ bash bun test math.test.ts
  ✓ bash bun test math.test.ts      ← 观察到失败
  ▸ edit src/math.ts                ← 修复代码
  ✓ edit src/math.ts
  ▸ bash bun test math.test.ts
  ✓ bash bun test math.test.ts      ← 验证：全部测试通过

  已修复 add() 函数……所有测试通过。
```

主动权始终在你手里：随时可以中断，也可以在任务进行中输入新的指示来调整它的方向。

## 为什么选择 MiniCode？

编码智能体会把大量精力花在探索和执行上——读文件、搜索、反复重读、反复重试——而这些往往发生在它真正改动一行代码之前。MiniCode 就是为了让这个循环顺畅运转而构建的：

- 智能体基于真实的仓库状态进行迭代，而不是基于对仓库的描述；
- 编码循环可见、可引导——你能看到它在做什么，并能在它工作的过程中改变方向；
- 验证是工作流的一部分：智能体应当运行你的测试来证明自己的修改，而不是口头宣称成功；
- 上下文被有意识地管理，长会话会被总结，而不是悄悄溢出。

MiniCode 刻意专注于软件开发，它并不打算成为一个通用的 AI 助手。

## 快速开始

**前提条件：** [Bun](https://bun.sh) 必须已安装并在 PATH 中可用。

全局安装 MiniCode，然后在你的项目中启动：

```sh
npm install -g minicode
cd ~/my-project
minicode
```

首次启动时没有配置模型，使用 `/login` 完成配置，然后输入任务。

### 从源码运行

要开发 MiniCode 本身，可以从检出运行：

```sh
git clone https://github.com/oliverxu1996/minicode.git
cd minicode
bun install

# 在你的项目中启动 MiniCode
bun ./packages/agent/src/tui/main.ts /path/to/your/project
```

首次启动时没有配置任何模型。使用 `/login` 完成配置——MiniCode 会依次询问协议（`openai` 或 `anthropic`）、endpoint、提供商的模型名称、你的 API key 以及 token 上限。配置会保存在本地，之后可以随时用 `/model` 或 Ctrl+P 切换模型。

然后输入一个任务，按下回车，看它开始工作。

## 配置模型

MiniCode 支持两种协议，因此既可以对接官方 API，也可以对接任何兼容的 endpoint：

| 协议 | 典型用途 |
| --- | --- |
| `anthropic` | Anthropic API 及 Anthropic 协议兼容的 endpoint |
| `openai` | OpenAI API 及 OpenAI 协议兼容的 endpoint |

模型相关命令：

| 命令 | 用途 |
| --- | --- |
| `/login` | 交互式配置模型 |
| `/model [id]` | 切换当前使用的模型 |
| `/logout` | 移除已配置的模型 |
| Ctrl+P | 在已配置的模型之间循环切换 |

配置保存在你的配置目录下
（`$XDG_CONFIG_HOME/minicode/models.json`，默认 `~/.config/minicode/models.json`）——你也可以直接编辑这个文件。

## 与智能体协作

任务运行时你能看到一切：当前的迭代轮次、每一次工具调用及其输出的实时预览，以及流式输出的助手回复。

- **引导（Steer）**：在智能体工作时输入消息并回车——它会中断当前方向，转而执行你的新指示。
- **排队（Queue）**：按 Alt+Enter 将后续任务排队，在当前任务完成后自动运行。
- **中断**：按 Esc 中止正在运行的任务。已排队的消息会退回编辑器，不会丢失。
- **展开**：按 Ctrl+O 查看完整的工具输出，而不是简短预览。

### 会话

你的工作会自动保存。退出之后随时可以回来——`--continue` 继续该工作区中最近的会话，`--resume <id>` 恢复指定的会话，TUI 内的 `/resume` 会列出所有会话。会话可以命名（`/name`）、查看信息（`/session`）、从较早的消息分叉（`/fork`）、复制（`/clone`），并在分支之间导航（`/tree`）。

如果 MiniCode 在任务中途被中断，下次启动时会自动对中断的工作进行调和：已完成的步骤会保留，未完成的会被如实报告，你可以从停止的地方继续。

### 斜杠命令

| 命令 | 用途 |
| --- | --- |
| `/help` | 列出所有命令 |
| `/compact` | 手动压缩上下文 |
| `/copy` | 复制上一条智能体回复到剪贴板 |
| `/export [path]` | 将会话导出为 JSONL |
| `/import <path>` | 从 JSONL 文件导入会话 |
| `/name <title>` | 为当前会话命名 |
| `/session` | 显示会话信息与统计 |
| `/new` · `/resume` · `/fork` · `/clone` · `/tree` | 会话生命周期与导航 |
| `/login` · `/logout` · `/model` | 模型配置 |
| `/trust` · `/reload` | 项目资源 |
| `/hotkeys` | 显示所有快捷键 |
| `/quit` | 退出 |

## 项目指令

MiniCode 会读取仓库根目录下的指令文件，在开始工作之前了解你项目的约定：

- `AGENTS.override.md` — 存在时优先使用
- `AGENTS.md`
- `CLAUDE.md`

找到的第一个文件会被加载进智能体的系统提示词，因此从第一条消息开始，智能体就会遵循你项目的规则。

你还可以添加项目本地的**提示词模板**（`.minicode/prompts/*.md`）和**技能**（`.minicode/skills/<name>/SKILL.md`）。由于这些文件能够引导智能体的行为，MiniCode 会先请你信任它们（`/trust`），然后才会加载项目本地的内容。全局配置位于 `~/.config/minicode/settings.json`，并可在项目的 `.minicode/settings.json` 中覆盖。

## 脚本与自动化

面向非交互场景——脚本、CI、代码审查流水线：

```sh
# 运行一个任务并打印最终回复
bun ./packages/agent/src/tui/main.ts -p "解释这个项目是做什么的" /path/to/project

# 将每个运行时事件输出为 JSON 行（供工具处理）
bun ./packages/agent/src/tui/main.ts --mode json -p "找出所有 TODO 注释" /path/to/project

# 继续该工作区中最近的会话
bun ./packages/agent/src/tui/main.ts -c -p "现在修复你发现的问题" /path/to/project
```

## 当前状态

**状态：早期实验开发阶段。** MiniCode 仍在积极开发中，尚未正式发布。当前基线版本为 v0.1.0——包含的内容见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

Apache License 2.0——详见 [LICENSE](LICENSE)。
