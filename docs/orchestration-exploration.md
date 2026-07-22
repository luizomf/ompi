# Pi Orchestration Exploration

Status: exploratory notes, not an implementation decision.

This document preserves findings about interactive Pi handoffs, visible workers,
subagents, and agent-to-agent communication so they do not need to be
rediscovered. Vendored extensions discussed here were inspected statically and
were not executed.

## Current local primitives

### Wormhole

A wormhole moves an interactive conversation to a fresh Pi process in another
tmux window while leaving the origin recoverable. A handoff file is the
continuation authority. The fresh process sends a callback to the origin and
must either begin the authorized next step or stop at an explicit user gate.

A tmux pane ID such as `%102` is an internal server-wide identifier. Moving or
reordering windows may change friendly indexes but does not change a living
pane ID. The ID becomes invalid when its pane or tmux server exits, so callback
endpoints must be captured immediately before each delegation or jump.

### Tmux worker

A tmux worker delegates independent work to a visible interactive Pi process in
another window. The worker writes a detailed report and sends a short callback
to the coordinator. The callback is only a pointer; the coordinator reads the
report before continuing.

Unlike a wormhole, a worker does not replace the coordinator. The two mechanisms
are complementary:

- wormhole: replace the active conversation with a fresh continuation;
- tmux worker: preserve the coordinator and delegate independent work.

The visible-window design is useful because the user can observe and interact
with either process. The same callback pattern can cross machines over SSH when
both hosts have appropriately scoped SSH access.

### Compaction versus explicit handoff

A manual `/compact` test summarized approximately 134k tokens into Pi's
structured goal, constraints, progress, decisions, next steps, context, and file
lists format. Pi also kept the recent part of the active split turn verbatim.
The resulting same-session continuation preserved enough context to answer
identity and immediate-history checks correctly.

Compaction and handoff solve different problems:

- **compaction** is the better default for continuing the same session and
  process with less context; it is automatic, preserves a recent tail, and
  leaves the full JSONL history available;
- **explicit handoff** is better for transferring authority to a fresh process;
  it can remove stale details, reference durable artifacts, state the new
  process's role, and prescribe an exact first action and callback.

The tested compact summary was strong but not a standalone transfer document.
Some checkpoint and "current work" statements became stale after later actions;
those actions remained available only because they were in Pi's retained recent
context. It also retained low-value operational details such as expired pane IDs
and old temporary paths. The curated wormhole handoff had better signal-to-noise
and a more precise transfer boundary.

Practical rule: compact first when the goal is only to recover context space;
use a handoff when changing process, window, agent role, machine, or authority.

## Observed reliability problem

Prompt-only orchestration can stop between stages. A completed worker may report
success, but the coordinator or replacement agent may fail to start the next
stage because continuation depends on the model remembering an instruction.

The important distinction is:

- **message delivery** tells an agent that something happened;
- **workflow control** decides, deterministically, what happens next.

A reliable loop should not make the finishing worker responsible for inventing
or remembering the next transition. A supervisor should own explicit state,
completion criteria, transitions, stop conditions, and human gates.

## Vendored extension findings

The files below belong to the untrusted reference snapshot in
`pi-vs-claude-code/`. They may be useful as design references but should not be
loaded without a separate compatibility and security review.

### `extensions/subagent-widget.ts`

This extension launches headless Pi subprocesses in the background. Each
subagent receives a persistent session file and can be created, continued,
listed, or removed. On normal process completion, the extension injects the
result into the parent with `deliverAs: "followUp"` and `triggerTurn: true`.
That mechanism automatically wakes the parent instead of requiring manual
polling.

Useful ideas:

- persistent conversation per subagent;
- asynchronous completion delivered as a follow-up;
- explicit create/continue/list/remove tools;
- live progress widgets.

Limitations and concerns:

- workers are headless rather than visible in tmux;
- controller state is in memory and is reset on session start or reload;
- persisted session files are not rediscovered into controller state;
- process-spawn errors do not follow the same parent wake-up path as normal
  process closure;
- there is no artifact-and-callback completion contract;
- subprocesses inherit the parent environment, which may include credentials.

### `extensions/agent-team.ts`

This extension turns the primary model into a dispatcher with only a
`dispatch_agent` tool. It launches named specialists as subprocesses and waits
for each dispatch to return. A specialist can be called repeatedly using its
session file.

Useful ideas:

- a small dispatcher interface;
- named specialist definitions;
- a synchronous tool result naturally resumes the parent agent loop;
- follow-up dispatches can target the same specialist conversation.

Limitations and concerns:

- choosing subsequent dispatches still depends on the model;
- project agent definitions are loaded as executable instructions without the
  confirmation boundary used by the current official example;
- session startup deletes `.pi/agent-sessions/*.json`, which conflicts with the
  stated persistence behavior and can affect other extensions using that
  directory;
- subprocesses are headless and inherit the environment;
- loaded agent tool lists can include powerful capabilities.

### `extensions/agent-chain.ts`

This extension implements a sequential pipeline in code. Each step is awaited,
and its output becomes the next step's input. This directly addresses the
between-stage continuation problem: the extension, rather than a model, owns
progress through the configured chain.

Useful ideas:

- deterministic sequential transitions;
- explicit failure stop at the first failed process;
- original input and previous output are distinct template values;
- the parent sees one tool invocation for the complete chain.

Limitations and concerns:

- success is primarily process exit status, not validated artifacts or
  acceptance criteria;
- the sample review stage reports findings but does not necessarily route fixes
  back to the writer;
- subprocesses are headless;
- startup deletes chain session files despite documentation suggesting
  within-session persistence;
- the fixed pipeline does not model human gates or recovery states.

### `extensions/coms.ts`

This extension connects already-running Pi agents on one machine using Unix
sockets or Windows named pipes. A received prompt is injected as a follow-up
that triggers a turn. At agent end, the receiver's final assistant text is sent
back automatically.

This is agent-to-agent messaging, not process creation or workflow supervision.
It can remove manual callback plumbing between living peers, but another
mechanism still needs to launch agents and own the workflow.

### `extensions/coms-net.ts` and `scripts/coms-net-server.ts`

`coms-net` generalizes peer messaging through an HTTP/SSE hub and can connect
agents on different machines. It includes bearer-token authentication,
heartbeats, reply correlation, hop limits, and explicit warnings against
reply-driven ping-pong loops.

Useful ideas:

- network-transparent peer discovery and messaging;
- automatic receiver wake-up and automatic response return;
- hop limits and message IDs;
- stale/offline detection;
- local-only default binding and mandatory explicit token for non-loopback
  binding.

Limitations and concerns:

- it does not launch or supervise peers;
- plain HTTP exposes bearer tokens and message content to any network observer;
  an SSH tunnel or properly configured TLS transport is safer than direct LAN
  exposure;
- all peers sharing a token have broad access to the hub;
- the server console logs a preview of prompt bodies, even though extension
  audit entries omit bodies;
- concurrent inbound work requires careful response correlation;
- a shared hub adds another long-lived process and failure mode.

### `extensions/pi-pi.ts`

This is a specialized meta-agent that queries multiple ephemeral Pi-domain
experts in parallel. It demonstrates bounded parallel subprocess delegation but
is not a general conversation or workflow manager.

### `extensions/cross-agent.ts`

Despite its name, this extension imports commands, skills, and agent definitions
from other coding-agent directory layouts. It does not create or coordinate
subagents.

### `specs/agent-workflow.md`

The unimplemented "Chronicle" specification is conceptually close to the
reliability goal. It proposes a persistent supervisor state machine, explicit
transitions, snapshots, recovery, human intervention after repeated loops,
resource budgets, and cleanup routines.

It is useful as vocabulary and a source of constraints, but it is not working
code and should not be adopted wholesale without reducing it to current needs.

## Current official Pi capabilities

The installed Pi documentation includes an official subagent example under
`examples/extensions/subagent/`. Compared with the vendored implementations,
it has a clearer security and execution model:

- isolated single, parallel, and sequential chain modes;
- concurrency limits and abort propagation;
- structured usage and failure reporting;
- user-level agents by default;
- explicit confirmation before running project-controlled agents;
- output caps and preservation of full details.

Its workers are ephemeral and headless, so it does not replace visible tmux
workers or persistent peer conversations. It is nevertheless a safer reference
base than the older vendored implementations.

The current extension API also provides `ctx.newSession()`,
`ctx.switchSession()`, and replacement-session `withSession` callbacks. An
extension can create or switch conversation and send the kickoff through the
fresh context atomically. This is relevant to same-process conversation
replacement, although it does not create a new visible tmux window.

## Security observations

All orchestration extensions run with the user's full permissions. Child Pi
processes commonly inherit the parent's environment and may therefore inherit
API keys, SSH agent access, and other credentials. Agent prompts and tool lists
must be treated as executable policy.

The vendored snapshot also enables automatic `.env` loading in its own
`justfile`. This repository intentionally does not copy that behavior. No
vendored recipe or extension should be run merely because it exists locally.

## Tentative direction

No architecture has been selected. A promising minimal composition is:

1. keep tmux workers for visibility, user interaction, and SSH reachability;
2. give one coordinator or extension ownership of a finite workflow state;
3. require each worker to preserve a detailed report before callback;
4. make callback handling trigger the next transition in code, not by prompt
   memory;
5. encode stop conditions and human gates explicitly;
6. avoid a general distributed-agent platform until a concrete workflow
   requires it.

The key design goal is not "agents that can message each other." It is a small,
inspectable supervisor that cannot silently forget the next authorized step.

## Questions for later analysis

- Should workers remain interactive after completion, or should only selected
  tasks use persistent conversations?
- Should the supervisor live in a Pi extension, an external process, or the
  current coordinator prompt-and-skill layer?
- Is an artifact plus callback sufficient, or is a durable state ledger needed?
- How should callback authenticity and stale callback rejection work?
- Which transitions require explicit owner approval?
- Can SSH transport remain a thin tmux callback, avoiding a network hub?
- What is the smallest recovery mechanism after coordinator, worker, or tmux
  server restart?
