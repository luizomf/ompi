# Pi Subagents

Language for the small internal Pi extension that lets one conversation start and observe independent agent conversations.

## Language

**Root agent**:
The Pi agent conversation from which subagents are started and to which their completion events return.
_Avoid_: Product, service, platform, coordinator

**Subagent**:
An independent Pi agent conversation started by the root agent and owned by its current session.
_Avoid_: Worker service, task, job

**Supervisor**:
The session-scoped part of the extension that owns the running subagent processes and their status. It ends those processes when the root session ends while leaving their Pi conversation history intact.
_Avoid_: Daemon, orchestration platform, scheduler

**Steering**:
A new instruction queued for a running subagent and delivered at Pi's next safe boundary, before its next model call.
_Avoid_: Real-time chat, process interruption, follow-up
