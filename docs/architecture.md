# Architecture

FlashEdge is a deterministic CLI trading engine for Solana perpetual futures.

## System Layers

```
┌────────────────────────────────────────────────────────────┐
│                      CLI Layer                             │
│  terminal.ts → parser → AST → validation → command router  │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│                   Execution Layer                          │
│  health guard → circuit breaker → API build → validate     │
│  → sign → broadcast → confirm → telemetry                  │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│                 Infrastructure Layer                       │
│  RPC manager → TPU client → leader router → state cache    │
└────────────────────────────────────────────────────────────┘
```

## Core Modules

### src/client/ — Execution Engine
- `flash-client.ts` — Core: executeOpenPosition, executeClosePosition, executeAddCollateral, executeRemoveCollateral, executeCancelTriggerOrder, sendApiTransaction
- `simulation.ts` — Paper trading (no on-chain transactions)

### src/core/ — Reliability
- `api-health-guard.ts` — Pre-execution health gate with background refresh
- `execution-circuit-breaker.ts` — Self-protecting gate (40% failure / 5 consecutive)
- `execution-error.ts` — Structured errors with action, endpoint, errorCode

### src/data/ — Data Layer
- `flash-api.ts` — Flash API client with buildTransaction abstraction
- `prices.ts` — Flash API as sole price source

### src/observability/ — Telemetry
- `execution-tracker.ts` — Per-execution UUID, latency, success/failure
- `execution-store.ts` — Persistent history (100 entries, async writes)

## Design Decisions

| Decision | Rationale |
|---|---|
| API-only execution | Flash API handles routing, ALTs, CU server-side |
| Single execution path | Eliminates non-determinism from fallback branches |
| Structured errors | Machine-readable errorCode enables automated alerting |
| Fire-and-forget telemetry | queueMicrotask: never adds latency to trades |
| Adaptive timeout | p95-based adapts to real network conditions |
