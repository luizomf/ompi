---
status: accepted
---

# Keep durable transitions behind a SQLite-backed module

The queue keeps state-transition invariants behind one deep domain module backed concretely by SQLite, rather than adding a generic storage adapter or repository layer. Domain commands own atomic state changes, event append, leases, idempotency, occurrence uniqueness, retries, and Dead Letters; tests exercise those behaviors against temporary SQLite databases. A storage seam should be extracted only when a second durable backend creates observable variation, because a thin facade would hide SQL syntax without localizing the semantics that dominate replacement cost.
