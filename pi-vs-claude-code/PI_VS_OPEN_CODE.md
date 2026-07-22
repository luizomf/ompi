# Pi Agent vs OpenCode — Customization & Control Comparison

> Pi v0.52+ vs OpenCode v1.1+ (Feb 2026)
>
> **Thesis:** Pi and OpenCode are both MIT-licensed, open-source, model-agnostic terminal coding agents. But they represent fundamentally different architectures. Pi is a **programmable platform** — a minimal harness with 25+ in-process TypeScript hooks that let you build your own agent experience. OpenCode is a **configurable product** — a full-featured Claude Code alternative with JSON-driven settings and a plugin system for extras. The distinction matters: Pi gives you control at the *runtime* level. OpenCode gives you control at the *configuration* level.

---

## The Core Architectural Split

| Dimension                 | Pi Agent                                                                                                                                                                                                                  | OpenCode                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it ships**         | 4 tools, ~200-token system prompt, 25+ extension events. Everything else is opt-in.                                                                                                                                       | 12+ tools, built-in sub-agents, Plan mode, LSP, web search, MCP, permissions, desktop app.                                                                                                                                             |
| **Extension model**       | In-process TypeScript. Extensions run in the same runtime as the agent loop. They can intercept, block, modify, and transform any event in real-time.                                                                     | Out-of-process plugins. JS/TS files in a config directory that subscribe to events and register tools.                                                                                                                                 |
| **Customization ceiling** | Effectively unlimited — you can replace the entire UI, override any tool, inject custom system prompts per-turn, build full overlay applications (Doom, Space Invaders, QA tools), and orchestrate multi-agent pipelines. | Bounded — you can add tools, hook into tool execution, customize compaction, and configure permissions via JSON. But you cannot modify the TUI, inject custom UI components, or intercept the input/agent lifecycle at the same depth. |
| **Philosophy**            | "If I don't need it, it won't be built. Build what you need."                                                                                                                                                             | "Ship a polished, complete product. Configure what you need."                                                                                                                                                                          |
| **Closest analogy**       | A race car chassis + engine. You design the body, aero, and electronics.                                                                                                                                                  | A production car with a tuning package. You adjust settings and bolt on accessories.                                                                                                                                                   |

---

## Extension / Plugin System — Deep Comparison

This is the single most important comparison between these two tools. Pi's extension system is architecturally different from OpenCode's plugin system — not just in API surface, but in *where code runs* and *what it can touch*.

### Architecture

| Feature           | Pi Extensions                                                                                                                                                                         | OpenCode Plugins                                                                                                                                                                 | Winner |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Runtime model     | **In-process** — extensions execute in the same Bun/Node.js runtime as the agent loop. Zero serialization overhead. Direct access to session state, UI context, and the event stream. | **Separate module** — plugins are loaded from `.opencode/plugins/` or npm. They receive a context object and return hook handlers. Communication happens through the SDK client. | Pi     |
| Build step        | None — TypeScript executed via jiti at runtime. Write `.ts`, run immediately.                                                                                                         | None — TypeScript supported natively via Bun loader.                                                                                                                             | Tie    |
| Composability     | Stack multiple extensions with `-e` flags: `pi -e ext1.ts -e ext2.ts`. Extensions can communicate via `pi.events` shared bus.                                                         | Multiple plugins loaded from directory. No built-in inter-plugin communication channel.                                                                                          | Pi     |
| Ephemeral testing | `pi -e npm:@foo/bar` — try a package without installing                                                                                                                               | Not possible — must add to config or plugin directory                                                                                                                            | Pi     |

### Event Coverage

This is where the gap is widest. Pi exposes 25+ typed events across 7 categories. OpenCode exposes ~20 events but skips critical lifecycle hooks.

| Lifecycle Point                   | Pi Extension Event                                                                                                      | OpenCode Plugin Hook                                                 | Gap Analysis                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session starts**                | `session_start`                                                                                                         | `session.created`                                                    | Comparable                                                                                                                                                                |
| **User submits prompt**           | `input` — can **block**, transform text, or handle entirely                                                             | ❌ Not available                                                      | **Pi-only.** This is huge — Pi can gate all user input, inject context, redirect prompts, or prevent execution before the agent ever sees it. OpenCode has no equivalent. |
| **Before agent processes prompt** | `before_agent_start` — can modify system prompt, images, prompt text **per-turn**                                       | ❌ Not available                                                      | **Pi-only.** Dynamic system prompt injection on every turn. The purpose-gate extension uses this to inject session intent into every agent call.                          |
| **Agent turn lifecycle**          | `agent_start`, `agent_end`, `turn_start`, `turn_end`                                                                    | `session.idle` (only fires when agent finishes)                      | **Pi has 4x granularity.** OpenCode only knows when the agent is done, not when turns start/end within a session.                                                         |
| **Before tool executes**          | `tool_call` — block with reason, modify args, typed per-tool via `isToolCallEventType()`                                | `tool.execute.before` — can modify args, throw to block              | Both can intercept. Pi has typed narrowing per tool (bash, read, write, edit).                                                                                            |
| **After tool executes**           | `tool_result` — modify results, log, transform output                                                                   | `tool.execute.after` — react to results                              | Comparable                                                                                                                                                                |
| **Tool execution streaming**      | `tool_execution_start`, `_update`, `_end`                                                                               | ❌ Not available                                                      | **Pi-only.** Real-time streaming of tool output as it happens — critical for building live progress UIs.                                                                  |
| **Bash spawn intercept**          | `BashSpawnHook` — modify command, cwd, env vars **before the process spawns**                                           | `shell.env` — inject env vars into shell execution                   | Pi intercepts at process spawn level. OpenCode only injects env vars.                                                                                                     |
| **Message streaming**             | `message_start`, `message_update`, `message_end` — token-by-token access                                                | `message.part.updated`, `message.updated`                            | Both have message events; Pi is more granular with token-level streaming.                                                                                                 |
| **Model changed**                 | `model_select` (source: set/cycle/restore)                                                                              | ❌ Not available                                                      | **Pi-only.** React to model switches programmatically.                                                                                                                    |
| **Context window access**         | `context` — deep copy of all messages, can filter and prune                                                             | ❌ Not available                                                      | **Pi-only.** Direct manipulation of what's in the context window. No other tool offers this.                                                                              |
| **Before compaction**             | `session_before_compact` — can **replace compaction logic entirely**                                                    | `experimental.session.compacting` — inject context or replace prompt | Both can customize. Pi can replace the entire compaction flow; OpenCode can replace the prompt.                                                                           |
| **Session branching**             | `session_before_fork`, `session_fork`, `session_before_switch`, `session_switch`, `session_before_tree`, `session_tree` | ❌ Not applicable (no branching model)                                | **Pi-only.** Pi's JSONL tree session format supports forking/branching. OpenCode uses linear SQLite sessions.                                                             |
| **Permission events**             | Not applicable (YOLO by default)                                                                                        | `permission.asked`, `permission.replied`                             | OpenCode-only — but Pi can build equivalent or better permission systems via `tool_call` blocking.                                                                        |
| **LSP events**                    | Not built-in                                                                                                            | `lsp.client.diagnostics`, `lsp.updated`                              | OpenCode-only — native LSP integration.                                                                                                                                   |
| **File watcher**                  | Not built-in                                                                                                            | `file.watcher.updated`                                               | OpenCode-only.                                                                                                                                                            |
| **Todo events**                   | Not built-in                                                                                                            | `todo.updated`                                                       | OpenCode-only.                                                                                                                                                            |

**Summary: Pi has 8+ hook points that OpenCode simply doesn't expose**, including the critical `input`, `before_agent_start`, agent lifecycle, tool execution streaming, context window access, and session branching hooks. These aren't minor — they're the hooks you need to build fundamentally different agent behaviors.

### UI Customization

This is the other dimension where Pi is in a different category entirely.

| Feature        | Pi Extensions                                                                                                                                            | OpenCode Plugins                                              | Winner |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| Custom header  | `ctx.ui.setHeader()` — replace the logo and keybinding hints with any content                                                                            | ❌ Not possible                                                | Pi     |
| Custom footer  | `ctx.ui.setFooter()` — git branch, token stats, cost tracking, tool counters, anything                                                                   | ❌ Not possible                                                | Pi     |
| Status line    | `ctx.ui.setStatus()` — themed colors, turn tracking, custom data                                                                                         | ❌ Not possible                                                | Pi     |
| Widgets        | `ctx.ui.setWidget(key, renderFn)` — persistent UI panels above/below the editor. Used for subagent progress, task lists, tool counters, purpose display. | ❌ Not possible                                                | Pi     |
| Overlays       | Full overlay applications — session replay timeline, game overlays (Doom), QA tools                                                                      | ❌ Not possible                                                | Pi     |
| Dialogs        | `ctx.ui.select()`, `confirm()`, `input()`, `editor()` — interactive prompts with custom rendering                                                        | ❌ Not available to plugins (only built-in permission dialogs) | Pi     |
| Custom editors | vim modal editor, emacs bindings, rainbow editor — all via extensions                                                                                    | ❌ Not possible                                                | Pi     |
| Notifications  | `ctx.ui.notify()` from any handler                                                                                                                       | `osascript` or desktop app notifications via plugin           | Both   |
| Theme system   | 51 color tokens, hot-reload, dark/light, custom themes via packages                                                                                      | Theme customization via `tui.json`                            | Pi     |

**OpenCode's TUI is polished but closed.** It's built with Bubble Tea (Go) and the Ink React renderer, and it looks great out of the box. But you can't inject custom UI components, widgets, or overlays into it from a plugin. What you see is what you get.

**Pi's TUI is a canvas.** The extensions API gives you full control over every UI surface — header, footer, status line, widgets above/below the editor, fullscreen overlays, and interactive dialogs. The pi-vs-claude-code repo demonstrates this with 16 extensions that completely transform the agent experience.

### Registration APIs

| What you can register         | Pi                                                                    | OpenCode                                                  |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Custom tools                  | `pi.registerTool()` — in-process, streaming results, custom rendering | `tool()` helper in plugins — Zod schema, execute function | Tie |
| Override built-in tools       | Register tool with same name → replaces built-in                      | Plugin tool with same name → takes precedence             | Tie |
| Custom slash commands         | `pi.registerCommand()` + prompt templates in `.pi/prompts/`           | Markdown files in `.opencode/commands/`                   | Tie |
| Custom CLI flags              | `pi.registerFlag()` — adds flags to the `pi` CLI                      | ❌ Not possible                                            | Pi  |
| Custom keyboard shortcuts     | `pi.registerShortcut()`                                               | Configurable via `tui.json` keybinds (JSON, not code)     | Pi  |
| Custom providers              | `pi.registerProvider()` with OAuth support                            | JSON config in `opencode.json` with npm AI SDK packages   | Pi  |
| Persistent extension state    | `pi.appendEntry()` — survives restarts, stored in session JSONL       | ❌ Not available to plugins                                | Pi  |
| Inter-extension communication | `pi.events` shared event bus                                          | ❌ Not available                                           | Pi  |

---

## What OpenCode Does Better (And Why It Still Matters)

The thesis isn't "Pi is better." It's "Pi is more controllable." OpenCode has real advantages that come from its product-first approach:

| Feature                        | Why OpenCode Wins                                                                                                                         | Pi's Alternative                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Batteries included**         | 12+ tools, LSP, web search, MCP, permissions, todo tracking — zero configuration needed. You install and start coding.                    | You build what you need with extensions, or install pi packages. Higher ceiling, higher floor.                       |
| **Built-in Plan mode**         | Tab to switch between Build (full access) and Plan (read-only). No setup.                                                                 | No plan mode. "Just tell the agent to think." Or build it with an extension.                                         |
| **Native MCP support**         | stdio and remote MCP servers configured in JSON. First-class integration.                                                                 | Not built-in by design (argues 7-14K token overhead). Available via extensions.                                      |
| **Permission system**          | Granular allow/deny/ask with glob patterns per tool, per agent, per command pattern. `.env` files denied by default. Doom loop detection. | YOLO by default. The damage-control extension builds equivalent functionality — but you have to build or install it. |
| **LSP integration**            | go-to-definition, find references, hover, document symbols, call hierarchy — all built in.                                                | Not available. Would need to be built as an extension.                                                               |
| **Client/server architecture** | TUI is one client. Desktop app, VS Code extension, web UI, and mobile are others. `opencode serve` exposes an HTTP API.                   | Terminal only. RPC mode over stdin/stdout for programmatic access, but no multi-client architecture.                 |
| **Desktop app**                | Native app for macOS, Windows, Linux.                                                                                                     | No.                                                                                                                  |
| **GitHub/GitLab integration**  | Comment `@opencode` on issues/PRs. GitLab Duo OAuth.                                                                                      | Via bash.                                                                                                            |
| **Massive community**          | 104K stars, 735 contributors, 9,200+ commits. Issues get fixed fast.                                                                      | ~8.9K stars (pi-mono), solo maintainer + approved contributors. Smaller but passionate community.                    |
| **Organizational config**      | `.well-known/opencode` endpoint for enterprise defaults.                                                                                  | Not available.                                                                                                       |

---

## Concrete Examples: What Pi's Control Enables

These aren't theoretical. They're actual extensions in the pi-vs-claude-code repo.

### 1. Purpose Gate (Input Interception + Dynamic System Prompts + Custom Widgets)
Forces the engineer to declare session intent before any work begins. Uses `input` to block all prompts until purpose is set, `before_agent_start` to inject purpose into the system prompt on every turn, and `setWidget` to display it persistently.

**Could OpenCode do this?** Partially. You could create a custom agent with a specific prompt, but you can't block user input, you can't inject per-turn system prompts, and you can't add a persistent widget to the UI.

### 2. Damage Control (Safety Auditing via tool_call Interception)
Intercepts every tool call, checks against YAML-defined rules (dangerous bash patterns, zero-access paths, read-only paths, no-delete paths), and blocks or prompts for confirmation. Uses typed narrowing (`isToolCallEventType`) to extract tool-specific args.

**Could OpenCode do this?** Partially — OpenCode's `tool.execute.before` can throw to block tool calls, and the built-in permission system covers common cases. But Pi's version is fully programmable with custom rules and custom UI (confirm dialogs, status line updates, persistent logging via `appendEntry`).

### 3. Subagent Widget (Multi-Agent Orchestration with Live UI)
`/sub` spawns background Pi processes as sub-agents. Each gets its own persistent session file, live-streaming progress widget, and independent model. `/subcont` continues a subagent's conversation. Widgets stack in the UI showing real-time status.

**Could OpenCode do this?** OpenCode has built-in subagents (@general, custom agents), but you can't add live-updating widgets to the UI, you can't show streaming progress from multiple agents simultaneously, and you can't continue a specific subagent's conversation across turns.

### 4. Agent Team (Dispatcher Orchestration with Grid Dashboard)
The primary agent becomes a pure dispatcher — it reads your prompt, picks a specialist from a YAML roster, and delegates via a `dispatch_agent` tool. A grid dashboard widget shows all agents and their status.

**Could OpenCode do this?** OpenCode has custom agents, but the dispatcher pattern with a grid dashboard UI and real-time status widgets isn't possible through plugins.

### 5. Theme Cycler (Full TUI Theming)
Ctrl+X/Ctrl+Q keyboard shortcuts cycle through custom themes. `/theme` command opens a selector. Hot-reload with 51 color tokens.

**Could OpenCode do this?** OpenCode has themes via `tui.json`, but no keyboard shortcuts for cycling and no extension-level theme registration.

---

## The OpenCode Clone Thesis

You asked whether OpenCode is more of a "Claude Code copycat." The evidence supports this framing. Here's what Claude Code ships vs. what OpenCode ships vs. what Pi ships:

| Feature               | Claude Code                    | OpenCode                            | Pi                               |
| --------------------- | ------------------------------ | ----------------------------------- | -------------------------------- |
| Built-in sub-agents   | ✅ Native Task tool, 7 parallel | ✅ General subagent + custom agents  | ❌ Build with extensions          |
| Plan mode             | ✅ Built-in plan mode           | ✅ Tab to switch to Plan agent       | ❌ "Just tell the agent to think" |
| Permission system     | ✅ 5 modes, deny-first          | ✅ allow/deny/ask with glob patterns | ❌ YOLO by default                |
| MCP support           | ✅ Native, first-class          | ✅ Native, stdio + remote            | ❌ Not built-in                   |
| Web search            | ✅ Built-in                     | ✅ Built-in (Exa AI)                 | ❌ Build with extensions          |
| LSP integration       | ❌ Not built-in                 | ✅ Native                            | ❌ Not built-in                   |
| IDE extensions        | ✅ VS Code, JetBrains           | ✅ VS Code                           | ❌ Terminal only                  |
| Desktop app           | ✅ Desktop app                  | ✅ Desktop app (beta)                | ❌ Terminal only                  |
| AGENTS.md / CLAUDE.md | ✅ CLAUDE.md                    | ✅ AGENTS.md                         | ✅ AGENTS.md (or CLAUDE.md)       |
| Slash commands        | ✅ .claude/commands/            | ✅ .opencode/commands/               | ✅ .pi/prompts/ + extensions      |
| Skills                | ✅ Agent Skills standard        | ✅ SKILL.md loading                  | ✅ Agent Skills standard          |
| Session sharing       | ✅ /export to HTML              | ✅ /share creates link               | ✅ /export to HTML                |
| GitHub Actions bot    | ✅ Native                       | ✅ @opencode bot                     | ❌ Not built-in                   |
| Todo tracking         | ✅ Built-in                     | ✅ Built-in                          | ❌ Build with extensions          |

OpenCode systematically reproduced Claude Code's feature set, added LSP support and a desktop app, swapped the single-provider lock-in for model-agnostic support, and open-sourced it under MIT. It's a very good execution of this strategy.

Pi rejected the feature set entirely and built a minimal, extensible harness that trusts the engineer to compose their own agent experience. It's a different bet — that the right set of primitives (events, UI APIs, tool registration, session branching) is more valuable than a pre-built feature set.

---

## Summary: The Decision Framework

**Choose Pi if you are building a custom agent workflow** — you want to control input interception, dynamic system prompts, UI components, multi-agent orchestration with live dashboards, safety auditing with custom rules, or anything that requires programmatic control over the agent loop. Pi's extensions are code that runs inside the agent. The ceiling is whatever you can build in TypeScript.

**Choose OpenCode if you want a production-ready Claude Code replacement** — you need LSP, MCP, permissions, Plan mode, sub-agents, web search, GitHub integration, a desktop app, and a massive community shipping updates daily. OpenCode's plugin system handles common customization needs (tool hooks, custom tools, notifications, compaction), and the JSON-driven config covers agent definitions, permissions, and provider setup without writing code.

**The one-line version:** Pi is a platform. OpenCode is a product. Both are open source. The question is whether you want to *build* your experience or *configure* an existing Claude Code like experience.