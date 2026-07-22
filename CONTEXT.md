# Pi Subagents

Language for the small internal Pi extension that lets one conversation start and observe independent agent conversations.

## Language

**Root agent**:
The Pi agent conversation from which subagents are started and to which their completion events return.
_Avoid_: Product, service, platform, coordinator

**Subagent**:
An independent Pi agent conversation started by the root agent and owned by its current session. Its conversation persists across turns, while its process exists only during an active turn.
_Avoid_: Worker service, task, job

**Supervisor**:
The session-scoped part of the extension that owns the running subagent processes and their status. It ends those processes when the root session ends while leaving their Pi conversation history intact.
_Avoid_: Daemon, orchestration platform, scheduler

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
The supervisor's single deterministic notification that an accepted subagent turn completed, failed, or was interrupted. It is queued for the root agent and triggers a turn without relying on either agent to remember a callback.
_Avoid_: Model callback, polling, status check

**Live status**:
A compact Pi widget near the editor that shows current subagent activity without adding streaming updates to the root agent's conversation.
_Avoid_: Transcript message, progress polling, full output
