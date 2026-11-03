# 2. Single-threaded ECS executor, with parallelism inside heavy systems

- Status: Accepted
- Date: 2026-11-02

## Context

The engine runs its Bevy schedules on the single-threaded executor, because `bevy_ecs` is built without the `multi_threaded` feature. The browser demo runs on `wasm32`, which has no threads, so it uses the single-threaded executor whatever the native build does.

Bevy's multi-threaded executor runs systems in parallel when their data access does not conflict. Whether it would make the native engine faster was tested with a prototype:

- `bevy_ecs/multi_threaded` was enabled in `app-runtime`.
- Compute pool threads entered the Tokio runtime. The websocket host calls `tokio::spawn` from a system, which panics on a thread outside the runtime.
- Frames were uncapped so that throughput, not the 44 fps cap, was measured.
- Both builds came from the same commit and ran the same scenarios on the sample showfile in a 4-core container:
  - Idle: nothing playing.
  - Load: 15 clips and 2 timelines running.
  - Heavy: the load scenario plus 34 step FX across 17 groups.

| Scenario | Single-threaded: fps / process CPU | Multi-threaded: fps / process CPU |
| --- | --- | --- |
| Idle | 195 fps / 78% | 126 fps / 110% |
| Load | 60 fps / 101% | 44 fps / 125% |
| Heavy | 43 fps / 103% | 39 fps / 144% |

The multi-threaded executor was slower in every scenario and used 25–45% more CPU:

- The schedules hold hundreds of small systems. Dispatching each to a thread and synchronizing between them costs more than running them in parallel saves.
- The expensive systems, the compositor and the FX and flow painters, all write `Layer` and `Parameter` data, so they conflict and run one after another anyway.

Bevy's ambiguity detection also reported 2,495 pairs of conflicting systems with no defined order in `Update` and 249 in `Render`. Most `Update` pairs involve command tracking and command result messages. Under the multi-threaded executor, command handlers would run in a different order from frame to frame, and the same input could produce different output.

## Decision

Keep the single-threaded executor on every target. Do not enable `bevy_ecs/multi_threaded`.

When a system is expensive enough to need more than one core, parallelize its work inside the system:

- Use `orx-parallel`, which the FX painter already uses to render attributes in parallel.
- Split work into independent chunks that do not touch the ECS `World`, such as per-fixture, per-attribute or per-universe work.
- Keep results deterministic: combine chunk results in input order, or combine them with an operation whose result does not depend on order.
- Keep a sequential path for `wasm32`.
- Parallelize only work that measurements show is large enough to repay the cost of spreading it across threads.

## Consequences

- System order stays deterministic. The same show and the same inputs produce the same output on every frame and every machine.
- Systems do not need `before`, `after` or `ambiguous_with` constraints just to make the executor safe.
- An idle engine stays on one thread, which keeps CPU use low on laptops and small show machines.
- Parallelism is opt-in per system. Each place that uses it carries its own `wasm32` fallback and must justify itself with a measurement.
- A system that waits on a long parallel job still blocks the frame. Work that does not need to finish within a frame belongs in a background task instead.
- Revisit this decision if per-system dispatch gets much cheaper in a future Bevy release, or if the frame grows several independent heavy systems that no longer conflict on the same components. Repeat the uncapped comparison and the ambiguity report before changing executors.
