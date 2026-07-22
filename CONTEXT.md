# Pi Subagents

Language for the small internal Pi extension that lets one conversation start and observe independent agent conversations.

## Language

**Orchestrator agent**:
The Pi agent conversation that delegates work to subagents, receives their pongs, and decides what happens next.
_Avoid_: Product, service, platform, mechanical controller

**Subagent**:
An independent Pi agent conversation started by the orchestrator agent and owned by its current session. Its conversation persists across turns, while its process exists only during an active turn.
_Avoid_: Worker service, task, job

**Clean start**:
A new subagent conversation that receives its explicit prompt but none of the orchestrator conversation history.
_Avoid_: Context fork, implicit inheritance

**Subagent extension**:
The mechanical Pi extension that connects the orchestrator agent to subagents and owns their process lifecycle, message transport, and status for the current session. It does not decide or interpret delegated work.
_Avoid_: Agent, daemon, orchestration platform, scheduler, workflow engine

**Steering**:
A new instruction queued for a running subagent and delivered at Pi's next safe boundary, before its next model call.
_Avoid_: Real-time chat, process interruption, follow-up

**Interruption**:
Aborting a subagent's current turn without deleting its conversation, so that conversation remains available for later instructions.
_Avoid_: Removal, reset, steering

**Start confirmation**:
The immediate response that a subagent process accepted its prompt and began an active turn. It does not wait for that turn to finish.
_Avoid_: Pong, completion

**Pong**:
The subagent extension's single deterministic notification that an accepted subagent turn completed, failed, or was interrupted. It includes the subagent's bounded final assistant message when one exists and a reference to the full conversation; its delivery never depends on the subagent producing that message.
_Avoid_: Model callback, polling, status check

**Live status**:
A compact Pi widget near the editor that shows current subagent activity without adding streaming updates to the orchestrator agent's conversation.
_Avoid_: Transcript message, progress polling, full output
