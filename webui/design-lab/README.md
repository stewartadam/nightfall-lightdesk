# Nightfall design lab

Open `/design-lab.html` on the worktree's Vite development server. This development-only entry runs independently of the backend and uses local sample data.

The left **Components** index opens or focuses one Dockview demo panel per reusable widget. Selecting an already open demo preserves its values and never creates a duplicate. Closed demos can be reopened from the index.

The default layout has component demos on the left and **Properties** on the right. Properties holds the accent picker, density, **Rounded corners** toggle, and **Reset layout** controls. Data grid opens from the component index when needed.

Focused Dockview regions use a lighter grey outer frame and an accent tab highlight. The tab-content divider stays neutral. This shared styling applies in the app, designer, and detached windows.

The lab renders application widgets:

- **Animations** previews content sweeps from all four edges, fade-in, and zoom-in. The previews and shared tabs use `tw-animate-css` through `playContentEntrance`. Controls adjust duration, delay, easing, slide distance, starting opacity, and starting zoom for the next replay. Buttons restart in-flight previews; reduced-motion preferences show the content immediately.

- `components/widgets/data-grid`: the production TanStack grid with 120 keyed sample cues, grouped **Cue details** and **Timing** headers alongside standalone **Tracking**, virtual scrolling, frozen columns, selection, column resizing, paste/edit handling, and Preline cell editors.
- `components/widgets/advanced-select`: the production Preline wrapper, shown as single and searchable multi-select controls in **Selects**.
- **Input forms** has **Standard** and **Properties** content tabs sharing the same editable draft and validation. Properties uses compact controls with inline labels, including in narrow panels. Both show text and number inputs, notes, the production dropdown, radio buttons, checkboxes, read-only and disabled fields, and local Save/Reset actions. Arrow keys and Home/End switch layout tabs.
- **Command palette** launches the production palette with lab panel and appearance commands. **Shortcuts** shows registered bindings with the application's keycaps and a typing practice input. Cmd/Ctrl+Shift+P opens the palette; Alt+Shift+D changes density and Alt+Shift+C cycles accents outside editable controls.
- `components/ui/range-slider.tsx`: the FX editor's noUiSlider widget, extended with a two-handle `mode="range"`. **Sliders** demonstrates intensity bounds, fractional phase values, scalar amplitude, numeric inputs, and disabled state.
- **Toolbars** combines the production `PanelToolbar`, `ToolbarButton`, `ToggleToolbarButton`, and `DataGridToolbar` with local action, toggle, transport, and selection states. Exclusive Camera/Measure/Move/Rotate/Select modes follow the 3D visualizer; DMX I/O-style **Group by** tabs regroup sample bindings by fixture or universe and support arrow keys, Home, and End.
- **Color picker** uses `components/widgets/color-picker` with square and circular HSV views, brightness, presets, RGB/HSV readouts, a live color swatch, and local reset.
- **Switches** uses the shared `ToggleSwitch` used by transport I/O with independent input/output controls, on/off and disabled states, and keyboard focus.
- **Vertical faders** uses `VerticalRangeSlider` with intensity and speed ranges, reference markers, keyboard input, external reset, and disabled controls. **Attribute sliders** uses the programmer's `AttributeSlider` with absolute/relative modes and synchronized numeric entry.
- **Object selector** uses the production searchable list with secondary text, keyboard selection, and empty results. **Inline rename** uses `CrudInlineLabelEditor` with Enter/blur to commit and Escape to cancel.
- **Sparklines** compares variable, flat, single-sample, and empty metric histories. **Tooltips** demonstrates four placements, wrapped guidance, focus activation, and interactive content.
- **Popups & popouts** launches the shared entity editor and delete confirmation dialogs, a floating Dockview preview, and an actual separate window using the development-only `design-lab-popout.html` host.
- **Toasts** uses the application's `pushToast` service with information, success, warning, and error examples, custom text, and automatic or manual dismissal. Undo and Retry demonstrate dismissing actions; Details keeps its toast open. Pass actions as the fourth argument: `pushToast(level, message, ttlMs, [{ label, onClick, dismissOnClick }])`. The service batches updates every 50 ms, limits the stack to three visible toasts and ten queued presentations, combines repeated messages, and summarizes overflow. Notification history retains up to 100 entries, prioritizing actionable messages; actions work from either history or a toast and dismissing actions execute once.
- `components/overlays/context-menu`: the shared context-menu host, available on tiles, cue cells, and the **Object actions** button. Examples include nested, checked, disabled, and destructive actions.
- `components/shell/docking/dockview/dockview-host.tsx`: a reusable Solid host for real Dockview panels. It uses portals to retain provider context and owns panel lifecycle cleanup.
- `components/widgets/object-tile.tsx` and `components/ui/visual-language/button.tsx`: reusable tile and action primitives.

Object tiles keep their dimensions as panels resize or searches filter results; the collection wraps onto additional rows. Comfort and Compact set explicit tile heights. Group and flow samples include untagged, single-tag, and multiple-tag examples through the shared tile's optional `tags` prop.

The application and lab both load `index.css`, which imports the shared palette, native field defaults, focus rules, and widget styles from `styles/`. Accent choices reference CSS palette variables through `components/ui/visual-language/accents.ts`. Shell layout and CRUD card styles live beside their components. Dockview uses `visualLanguageDockTheme`. Page composition and sample content stay in `design-lab/`.

Tabs use Dockview's smooth drag animation and can be dragged and closed; grips resize regions. **Top tabs / Bottom tabs** moves existing tab strips without discarding edits. **Reset layout** restores the composition and resets panel-local sample edits. Opening or resetting on narrow screens stacks the panels. Native selects only serve as Preline's hidden data backing, never as visible dropdowns.

Grid selections draw a perimeter around the union of selected cells, ranges, rows, and columns. Shared edges disappear with **Column guides** off and use one thin divider with guides on. `--data-grid-column-border` controls guides; `--data-grid-selection-divider` optionally overrides dividers inside selections.

The **Data grid** panel has content tabs for **Editable cues**, **Read-only status**, and **Progress bars**. Read-only status uses a native monitoring table, like the timecode and status displays, with a static timecode snapshot, status indicators, and sticky headers. Progress bars uses the cue editor's production rich time-cell renderer to fill timing-cell backgrounds behind their values. Play/Pause, Reset, and a time slider control a local eight-second preview that stops on completion or when leaving the variant. All views follow the density and column-guide controls. Switching tabs preserves cue edits and each view's scroll position; Left/Right, Home, and End navigate the tabs.

Validate through the repository wrapper, which starts an isolated frontend:

```sh
NIGHTFALL_PLAYWRIGHT_TARGET=embedded-demo npm run test:webui-playwright -- webui/e2e/design-lab.spec.ts --workers=1
```

Screenshots are saved under `test-results/playwright/`. The lab shares the live application theme but uses isolated sample content and does not send live output.
