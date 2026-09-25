# Authoring lessons

Each step has a `content` array, rendered in the order written:

```ts
content: [
  { type: "text", text: "The Programmer holds live lighting instructions." },
  { type: "prerequisite", panels: ["ProgrammerGrid"] },
  {
    type: "action",
    title: "Type this command, then press Enter:",
    body: "Set the selected fixtures to full intensity.",
    command: "@ 100",
  },
  { type: "text", text: "Look at the values in the Programmer." },
  { type: "details", title: "Learn more", text: "Additional explanation." },
]
```

- **Text** blocks contain explanatory copy.
- **Action** blocks have an optional `title`, a `body`, and an optional copyable `command`.
- **Prerequisite** blocks show buttons for missing or hidden panels. Content after the first unmet prerequisite stays hidden. Each required panel must be visible and expanded at least once during the step; panels can share a tab group. Use `sampleTimeline: true` to require timeline 1 specifically.
- **Details** blocks provide expandable supporting text.
- **Stop-playback** blocks (`{ type: "stop-playback" }`) render a button that stops every timeline and playback instance; it is disabled when nothing is running.

Prerequisites can appear anywhere, including between actions. Text can appear before or after any action. Navigation remains available while prerequisites are pending.

Use `{command-palette-shortcut}` or `{clear-shortcut}` in text, action titles, or action bodies to render the platform-specific keycaps. Keep step-level `target`, `focusTarget`, `highlightClipId`, and `observe` settings outside the content array.

Sample objects have session-specific UIDs, so target them by user-facing ID with `targetClip`, `targetSequence`, `targetFx`, `targetPatchFixture`, or `targetTimelineAction` instead of a hard-coded `target` selector.

Steps with `observe` advance automatically: the guide shows a checkmark briefly, then moves on, and the forward button reads **Skip**. Steps without `observe` show **Continue**. Most observations only fire on a change after the step opens; `sample-panels`, `sequence-editor`, `panel-hidden`, `panel-closed`, `playback-idle`, and `timeline-action-selected` also complete immediately if already satisfied.
