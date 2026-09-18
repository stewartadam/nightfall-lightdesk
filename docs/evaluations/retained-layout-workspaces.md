# Retained layout workspaces

Layout slots retain one Dockview per visited slot. Unvisited slots allocate no views. Switching hides the outgoing workspace and exposes the retained target; resetting a slot recreates it from its saved layout. Removed or reassigned slots release their inactive workspaces, and loading a showfile clears inactive workspaces. An unassigned active arrangement stays visible until the next recall.

Workspace activity suspends panel shortcuts, commands, capability handlers and Properties registrations. It also pauses visualizer rendering and synchronization, timeline interpolation and timecode hydration, cue/sequence preview clocks, and high-frequency monitoring subscriptions. Backend playback continues while views are hidden. Shared showfile data remains authoritative.

## Browser measurement

Measured on macOS in Chromium using the repository's native-backend Playwright wrapper, on September 11, 2026. Each workspace contained the same simple timeline and an empty visualizer scene. The active visualizer continued rendering throughout the idle samples.

| Retained workspaces | Post-GC JS heap | DOM nodes | Main-thread task time |
| --- | ---: | ---: | ---: |
| 1 | 38.48 MiB | 3,275 | 38.29 ms/s |
| 2 | 39.50 MiB | 3,874 | 41.63 ms/s |
| 4 | 41.40 MiB | 5,032 | 42.55 ms/s |
| 4, after 20 switches | 41.70 MiB | 5,032 | 44.53 ms/s |

Cached activation took a median 6.2 ms and maximum 8.2 ms over 20 switches. The median interval through two animation-frame callbacks was 15.5 ms; this is a frame-boundary proxy, not a direct screen-presentation measurement.

Three extra workspaces added 2.93 MiB of JavaScript heap in this scenario. Repeated switching retained the same timeline DOM node and Dockview API, preserved a 347 px horizontal scroll offset, and did not increase the DOM count. An earlier run measured 42.4 ms/s with one workspace and 41.6 ms/s with four, so the short CPU samples do not establish a consistent increase. These results support retaining multiple Dockviews without introducing a separate panel reattachment cache.

The heap numbers exclude GPU allocations and worker heaps. Large fixture scenes, waveform data, long timelines, and many slots can retain substantially more memory than this fixture. This is a comparison of one versus multiple retained workspaces, not a benchmark against the previous remount implementation.

## Reproduction and behavior checks

```sh
npm run test:webui-playwright -- webui/e2e/layout-switcher.spec.ts --grep 'retains live timeline' --workers=1
```

The spec writes `workspace-performance.json` and a workspace screenshot under `test-results/playwright/`, and attaches the measurement to the Playwright report. It uses Chromium CDP post-GC heap/DOM metrics and two-second main-thread task-time samples. It also checks hidden visualizer suspension, timeline viewport retention after resizing, hidden time-display suspension during live playback, catch-up on return, and inactive slot reset. Playback is stopped at the end of the scenario.
