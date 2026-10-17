# Shared UI components

Application screens and the design lab import the same production components from this directory. The lab demonstrates those components; its styles should arrange examples without redefining component appearance.

Both entry points load `webui/index.css`. Its `styles/theme.css` import defines the canonical palette and appearance tokens, while `styles/forms.css` provides native field defaults in Tailwind’s base layer. Plain inputs, selects, and textareas receive those defaults without a component class. Shared components add density and composite-control behavior; local utilities can override the base layout.

Reusable components own their visual rules alongside their implementation. Dialog primitives use Tailwind classes directly. `visual-language/accents.ts` references the CSS palette variables instead of copying color values; runtime preferences apply to the document root so body portals and derived colors inherit them.

## Menus

`menu` exports `MenuSurface`, `MenuItem`, `MenuHeading`, and `MenuSeparator`. These primitives own surface treatment, typography, spacing, icon/checkmark alignment, keyboard focus, disabled states, destructive actions, and shortcut hints.

- Use `dropdown-menu` for button-triggered menus. Its items close the dropdown after activation. Give a trigger the shared button look with `triggerVariant`/`triggerSize` (see `buttons.md`) rather than styling a `<span>` inside it.
- Use the context-menu provider and widget for menus anchored to a pointer, including nested flyouts.
- Both wrappers compose the menu primitives and retain responsibility for interaction and positioning. Add visual states to the primitives instead of styling individual menu callers.
- The design lab's Menus panel demonstrates both wrappers, including checked, disabled, and destructive entries. Its button popover also exercises arbitrary interactive dropdown content.

The accent picker and buttons in `visual-language` follow the same shared-component pattern. Extend these production components when introducing another application or lab use case.

## Key caps

Use `Kbd` and `KbdShortcut` from `kbd` wherever the UI shows a keyboard key or shortcut as a key cap: the keyboard shortcuts overlay, command palette hints and keybinding settings. They own the cap surface, border, typography and platform-specific modifier glyphs.

- `KbdShortcut` takes shortcut syntax as the shortcut registry and stored keybindings write it: `$mod+Shift+P`, `Control+KeyM`, `Shift++` or the chord `$mod+k w`. Keys sit side by side and chord steps are spaced apart. Pass the raw shortcut; do not pre-format it.
- `Kbd` renders one cap. With `keyName` it resolves the key like `KbdShortcut` does; without it, it shows its children verbatim.
- `$mod` resolves to Command on Apple platforms and Ctrl elsewhere. Apple platforms draw Command, Option, Control and Shift as glyphs with the key name kept for screen readers. `Key`/`Digit` code prefixes are dropped, letters are capitalized and arrows, Escape and Page Up/Down are abbreviated.
- `size="compact"` suits dense rows and inline hints; the default suits reference lists and dialogs. `tone="muted"` dims caps for disabled or secondary shortcuts.
- `describeKey` and `parseShortcut` expose the same resolution for text such as accessible labels.

Menu items keep their plain-text `shortcut` hint; key caps are for lists and hints outside menus. The design lab's Shortcuts panel shows the sizes, tones and a chord.

## Alerts

Use `Alert` from `alert` for inline, blockquote-style callouts inside panels and dialogs, the equivalent of GitHub Markdown's `[!NOTE]` callouts. Tailwind and Preline ship no alert component, so this one owns the colored start border, tinted background, icon and title styling.

- `variant` is one of `note` (blue, the default), `tip` (green), `important` (violet), `warning` (amber) or `caution` (red). Use `caution` for errors.
- `title` adds a bold heading in the accent color. Without it, the icon aligns with the first line of text.
- `density="compact"` suits dense dialogs and property rows. `icon` replaces the variant icon, or hides it with `false`.
- `align="center"` centers the icon on the content instead of its first line, for a single row of text beside a taller control such as a button.
- Children stack with a small gap, so paragraphs and an action button can sit together.
- `border` places the accent stripe on the `left` (default), on the `top` (Flowbite's border accent) or nowhere (`none`, tint only).
- `show` toggles the alert with an enter/exit animation instead of mounting it conditionally, so it can animate out. `transition` picks `fade` (default), `slide` or `none`, and `transitionMs` sets the length (150 ms by default). Reduced motion skips the animation.
- `flash` takes an accessor; each time its value changes the alert shows for `flashMs` (2000 ms by default), like the tooltip's flash. With `flash` set and no `show`, the alert stays hidden between flashes.
- The alert has no live-region role of its own. Pass `role="alert"` for errors that appear after an action, or `role="status"` for polite updates.

Use toasts for transient feedback and `Alert` for messages that belong to the surrounding content. Full-width strip banners at the top of a panel are not alerts.

## Tooltips

Use `Tooltip` for hover and focus help instead of a native `title`, which shows late, cannot be styled, and never appears on keyboard focus. `ToolbarButton` and `Button` take a `tooltip` prop and wrap themselves; wrap other controls and status indicators in `Tooltip` directly. Multi-line content keeps its line breaks.

- Keep the accessible name on the control (`aria-label` or visible text). When the tooltip adds information beyond that name, expose it with `aria-description` as well; `Button` does this for its `tooltip` automatically.
- The trigger wrapper is `relative inline-block`. Pass `class` (or `tooltipClass` on `Button`) when the parent positions or sizes the control, such as `absolute top-1 right-1` or `block w-full`, and move those classes from the control to the wrapper.
- Make a non-button trigger that hides essential information focusable (`tabindex="0"` with a focus ring) so keyboard users can open it.

## Error fallbacks

Use `ErrorFallback` from `error-fallback` as the `fallback` of a panel-level Solid `ErrorBoundary`. It fills the panel and centers a `caution` `Alert` with the `title`, an optional `description`, the error's `Name: message`, and its stack behind a collapsed **Technical details** disclosure (`hideDetails` omits it).

- Pass the boundary's `reset` to show a primary **Retry** button; `actions` adds further buttons after it, such as the Dockview panel boundary's **Report Bug**.
- The component imports only Solid, `Alert` and `Button`, so it still renders when stores, the bridge or other panels have failed. Keep it that way: callers log the error and build any bug report themselves.
- The fatal error dialog (`shell/app/fatal-error-dialog.tsx`) stays separate, because it must work when the whole shell is broken.

The Dockview panel boundary, the flow editor and the visualizer use it. The design lab's **Error fallback** panel throws on demand and recovers with Retry.

## Badges

Use `Badge` from `badge` for small, non-interactive status and metadata labels: states such as Draft or Listening, sources, identifiers and short counts in a row. It owns color, border, radius, padding and type size, so call sites only position it.

- `tone` is one of `neutral` (the default), `accent`, `info`, `success`, `warning` or `danger`. Tones use the same palette tokens as `Alert`; map domain states onto a tone rather than picking colors.
- `appearance` is `outline` (the default, tinted border), `soft` (tinted fill) or `solid` (full fill with dark text, for the strongest emphasis).
- `size` is `sm` (the default, for dense rows), `md` (beside headings and in table cells) or `xs` (object tiles, where badges shrink and truncate to fit).
- `uppercase` sets status words in capitals; `mono` uses the monospace font for identifiers and counts. `icon` adds a leading icon sized to the text.
- Long labels truncate with an ellipsis. Pass test ids and `title` as usual; they reach the badge element.

Use `CountBadge` for a count bubble on a control's top-right corner. It is absolutely positioned against the nearest positioned ancestor, ignores pointer events, renders nothing for zero, and never resizes the control. `tone` defaults to `info`; `max` collapses larger counts to `99+`-style labels. `ToolbarButton`'s `count`, the data grid filter trigger and the mapping overlay all use it. Add `aria-hidden` when the count repeats information the control's label already gives.

The design lab's Badges panel shows every tone, appearance and size, plus count bubbles.

## Toolbars

Use `PanelToolbar` for panel action rows. It owns spacing, wrapping, background, and a bottom divider, with no top or side borders or rounded outer corners. Supply controls through its `left` and `right` slots; keep container borders and padding out of the slot classes. Use `ToolbarSeparator` between related action groups, never a hand-drawn `w-px` divider; it passes `data-*` attributes through for test hooks.

Wrap a group of related controls in `Toolbar` (with a `label`) to make it one keyboard focus group, following the WAI-ARIA toolbar pattern. The group is a single Tab stop: Tab enters on the control used last, Left/Right (Up/Down with `orientation="vertical"`) move between controls and wrap at the ends, and Home/End jump to the first or last control. Disabled and inert controls are skipped. Text fields keep their arrow keys, and a child that handles an arrow key itself calls `preventDefault()` to keep it from the toolbar, as the step FX Step bar does to move its selection. Never set `tabIndex` on controls inside a `Toolbar`; it owns them.

Mark content that is present but not usable, such as closed submenus, collapsed sections and inactive workspaces, with `inert` rather than `aria-hidden` or per-control `tabIndex={-1}`, so it leaves the focus order, pointer interaction and the accessibility tree together.

## Segmented tabs

Use `SegmentedTabs` for compact horizontal content selectors, including toolbar grouping views. Supply labeled options, the selected value, and an `onChange` callback. The component owns selected styling, arrow/Home/End navigation, roving focus, and scrolling focused tabs into view. Selection changes replay a directional `tw-animate-css` entrance on the associated content element through `playContentEntrance`, respecting reduced motion. The same helper powers the design lab previews and accepts duration/delay in milliseconds, distance as a percentage, and starting opacity/scale as ratios.

Options may supply their own `contentId` when each view has a separate mounted panel.

Give each instance a unique `id` and its content container's `contentId`. The caller owns the content and persistence: set `role="tabpanel"` on the container and `aria-labelledby` to `${id}-${selectedKey}`.

## Tables

`ScrollArea` from `scroll-area` provides a native scroll viewport with blurred edge fades and decorative directional chevrons. Hints appear only where content continues, and update on scrolling, viewport resizing, and content changes. Active edge strips block pointer activation and drag starts on covered content, while wheel and touch scrolling remain native. Keyboard activation remains available. `TableScroll` and `SegmentedTabs` compose this shared component.

For other scrollable surfaces, apply layout sizing through `ScrollArea`'s `class` and `style`, viewport styling through `viewportClass`, and accessible labels, keyboard focus, refs, or scroll handlers through `viewportProps`. Give standalone content viewports a meaningful `aria-label`, `role="region"`, and `tabIndex={0}`. Set `--nf-scroll-surface` on `.nf-scroll-indicators` when the viewport uses a different surface color.

For third-party widgets that own their scroll element, render `ScrollIndicators` with that element as `viewport` and `fixed` inside a portal. This shares edge measurement and pointer protection without changing the widget's DOM or scroll ownership; positioning follows viewport scroll, resize and attribute changes.

Application card collections use `widgets/crud/crud-scroll-area`. It fills the space below a panel toolbar, supplies keyboard scrolling, and forwards card selection and drag handlers to the viewport. Keep grid content intrinsically sized so resizing or wrapping cards updates the overflow hints; reserve fixed-height content for list views with their own grid viewport.

Use `table` for native HTML data tables. `Table` owns header/cell typography, spacing, borders, sticky headers, hover and selection styling. Compose it with native `thead`, `tbody`, `tr`, `th` and `td` elements; use `scope="col"` or `scope="row"` on headings. Cells may contain rich JSX, wrapped text, buttons or form controls. Keep column widths, alignment, value formatting and domain behavior at the call site, and add shared visual states to the component instead of duplicating table chrome.

- `density="compact"` is the default; use `density="comfortable"` for spacious tables. `columnGuides` enables vertical dividers and `stickyHeader={false}` disables sticky headers.
- Use `TableScroll` with an `aria-label` for a keyboard-scrollable viewport. The caller sets the available height and any minimum table width.
- Use `TableEmptyRow` with the full `colSpan` for empty data. Mark selected rows with `data-selected="true"`. Virtual spacer rows use `data-table-spacer="true"` and `aria-hidden="true"` so they receive no padding, borders or hover styling.
- Sorting, row identity, selection, resizing and virtualization remain with the caller. Existing sortable headers retain their buttons and should expose `aria-sort` on the header.
- Use `DataGrid`/`CrudListDataGrid` for spreadsheet interactions. Use `DataGrid` with `readOnly` for fixed-height monitoring tables that need shared resizing, virtualization, selection, copying or sorting. Keep native `Table` for wrapped detail content or embedded form controls that need native table semantics.

The design lab uses the production read-only `DataGrid` for live timecode source status, and production `Table` for the progress examples. References and Reference Health also use read-only `DataGrid`.

### Read-only DataGrid

Import `DataGrid` and `createKeyedDataGridCellProvider` from `components/widgets/data-grid`. Provide unique stable row keys and column IDs. Update the reactive provider when source values change; do not use array positions as identities. The grid owns the TanStack row model, column sizing and virtualization.

- Set `readOnly` to block text/rich editors, boolean toggles, paste and deletion even when source cells advertise editing. Switching a grid to read-only discards any pending editor. Navigation, selection and copying remain available.
- Set `ariaLabel` and optionally `emptyState`. Headers remain visible with an empty row projection.
- `density="comfortable"` uses 42px rows and `density="compact"` uses 32px rows. An explicit `rowHeight` overrides either. Editable grids retain their 30px default. `columnGuides` overrides the inherited app setting when supplied.
- Opt individual headers into sorting with `sortableColumns={["name", "count"]}`. Click, Enter and Space cycle ascending, descending and source order. Numeric and boolean cells sort by raw value; text and rich cells use display/copy text with natural, case-insensitive ordering. Loading cells sort last.
- Sorting is internal unless `sorting` and `onSortingChange` control it. Generic sorting only applies in read-only mode; editable/domain projections keep their upstream order.
- Selection, click/context-menu/hover callbacks, decorations and scroll requests use **source-provider coordinates**, even while rows are sorted. Selection follows stable row identity across reorderings; rectangular selections may become multiple ranges. Removed rows are dropped from selection.
- Column resize handles support dragging, Left/Right in 10px increments, Shift+Left/Right in 1px increments, and Home to restore the default size. Resizing does not activate sorting.
- Register rich display cells through `richCellExtensions`; use `copyData` for their copyable/sortable text. Domain renderers own badges and formatting, while the shared grid owns table structure and interaction styling.

## Selectable surfaces

Import `selectable-surface.css` and mark a selectable card or tile with `data-selectable-surface` and `data-selected={selected}` to give it the shared rest, hover, selected, keyboard-focus and press states. Selected surfaces take the accent border, the soft accent background and a 3px accent bar on the start edge; hover lightens unselected surfaces only; focus-visible draws the accent outline; pressing nudges the surface down unless reduced motion is on. The rules outrank the shared `Button`'s own states, so a surface may render through `Button` to keep its press feedback.

The surface only styles state. Size, padding, radius, typography and layout stay with the card (`nf-crud-card` in `widgets/crud/crud-cards.css`, `ObjectTile` in `widgets/object-tile.css`). Callers own selection, keyboard activation and semantics such as `aria-pressed` or `role="button"`. Override `--nf-selectable-surface-bg`, `--nf-selectable-surface-border`, `--nf-selectable-surface-hover-bg` or `--nf-selectable-surface-hover-border` on the element for a different resting tone.

CRUD panel cards (groups, blueprints, cues, sequences, timelines, clips, FX and flows) and design lab object tiles use this surface.

## Switches and numeric steppers

Use `ToggleSwitch` for boolean settings with a visible `label`, accessible `ariaLabel`, controlled `checked` value, and `onChange` callback. It owns the track, thumb, keyboard focus, disabled styling, and reduced-motion behavior. The I/O settings and design lab use the same component.

Use `NumericStepper` for a numeric draft with decrement/increment buttons. Supply `value`, `onValueChange`, and accessible `decreaseLabel`/`increaseLabel` strings. Native input attributes, refs, blur handlers, and validation states are forwarded to the field. `min`/`max` clamp increments; `stepBy` overrides the native `step` for buttons and arrow keys (`step="any"` increments by one). Fractions are preserved. `fallbackValue` supplies the value to increment from when a draft is blank or invalid. Callers own draft validation and commit/reset behavior. `disabled` and `readOnly` also disable increment actions. Use `unit` for a visible suffix and `density="compact"` for property rows and popovers.

Use `InputGroup` and `InputSuffix` from `form-controls` to attach units to fields under one border and focus ring. Keep units outside the editable value. The shared stepper and waveform rate editor compose this same field shell.

## Sliders

Use `RangeSlider` from `range-slider` for any horizontal numeric slider instead of a native `type="range"`; `mode="range"` gives two ordered handles. Always pass `ariaLabel` (or `handleLabels`) and, in a settings row, `describedBy`. `onChange` receives every edit, including each drag step; `onCommit` receives the settled value once a drag ends or a key press, track tap or numeric entry completes, so live previews and undoable commits stay separate. While a handle is dragged the slider ignores incoming `value` echoes, so a lagging backend cannot pull it back. `min`, `max` and `step` may change while mounted (for example an absolute/relative mode switch). The numeric field and its `suffix` (`""` hides the unit) appear unless `showInputs={false}`; hide `showPips` and `tooltips` in compact rows. `format` drives tooltips, pips and the handle's `aria-valuetext`.

Use `VerticalRangeSlider` for faders. Both components import `range-slider.css`, which owns the noUiSlider base styles and the theme: a neutral track, an `--accent` fill and a round handle with an accent ring. Do not restyle `.noUi-*` classes elsewhere. Inside a flow node, wrap the slider in a `nodrag nokey` element that stops `pointerdown` propagation, so drags and arrow keys move the handle rather than the node. The masters table, attribute sliders, color path timing, tap pattern detection, visualizer darkness, Step FX start position, flow normalized ports, FX waveform editor and clip faders use these components.

## Settings rows

Use `SettingsRow` from `settings-row` for one setting in a preferences surface: its `label` and optional `description` sit on the left and the control is aligned to the right edge, centered beside them. The row renders its control through a child function that receives `id` and `describedBy`; pass them to the control (`id`/`aria-describedby` on fields, `id`/`describedBy` on a `switch-only` `ToggleSwitch`) so the title labels it and the description describes it. Set `labelControl={false}` when the control is a button or read-only content whose own text names it. `details` runs full width beneath the row, for lists, notes and errors, and `heading` makes the title a section heading.

Group rows in `SettingsSection`, which adds an optional `title` heading that also names the section, divides each direct child from the next with a thin line, and takes a `footer` note. A row wrapped in a labelled `<section>` divides like a bare row. Fields and selects in a row size to their content; give sliders and other wide controls an explicit width. The control wraps beneath the text when the row is too narrow for both.

Settings, the About dialog's update choice and the design lab's switch examples use these rows.

## Search pickers

Use `SearchPickerSurface`, `SearchPickerInput`, and `SearchPickerOption` from `search-picker` for command and destination lists. The surface composes the shared dialog frame, the search field composes `InputGroup` and `Input`, and rich option rows share accent, hover, focus, and disabled states. Supply `selected` on the active option and native `disabled` for unavailable actions. Callers own filtering, keyboard navigation, result semantics, positioning, and dismissal. Put removable filter tokens in the input's `leading` slot and optional back actions or hints in its `trailing` slot. Keep result viewports shrinkable (`min-height: 0`) and constrain the surface to available viewport space.

The command palette in the app and design lab, showfile object search, timeline action insertion, and timeline jump picker use these components.

Search picker options accept `density="compact"` for anchored command suggestions. Command inputs and history search use shared fields and buttons; DMX direction and universe selection use shared toggle toolbar buttons.
