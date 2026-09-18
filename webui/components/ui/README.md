# Shared UI components

Application screens and the design lab import the same production components from this directory. The lab demonstrates those components; its styles should arrange examples without redefining component appearance.

Both entry points load `webui/index.css`. Its `styles/theme.css` import defines the canonical palette and appearance tokens, while `styles/forms.css` provides native field defaults in Tailwind’s base layer. Plain inputs, selects, and textareas receive those defaults without a component class. Shared components add density and composite-control behavior; local utilities can override the base layout.

Reusable components own their visual rules alongside their implementation. Dialog primitives use Tailwind classes directly. `visual-language/accents.ts` references the CSS palette variables instead of copying color values; runtime preferences apply to the document root so body portals and derived colors inherit them.

## Menus

`menu` exports `MenuSurface`, `MenuItem`, `MenuHeading`, and `MenuSeparator`. These primitives own surface treatment, typography, spacing, icon/checkmark alignment, keyboard focus, disabled states, destructive actions, and shortcut hints.

- Use `dropdown-menu` for button-triggered menus. Its items close the dropdown after activation.
- Use the context-menu provider and widget for menus anchored to a pointer, including nested flyouts.
- Both wrappers compose the menu primitives and retain responsibility for interaction and positioning. Add visual states to the primitives instead of styling individual menu callers.
- The design lab's Menus panel demonstrates both wrappers, including checked, disabled, and destructive entries. Its button popover also exercises arbitrary interactive dropdown content.

The accent picker and buttons in `visual-language` follow the same shared-component pattern. Extend these production components when introducing another application or lab use case.

## Toolbars

Use `PanelToolbar` for panel action rows. It owns spacing, wrapping, background, and a bottom divider, with no top or side borders or rounded outer corners. Supply controls through its `left` and `right` slots; keep container borders and padding out of the slot classes. Use `ToolbarSeparator` between related action groups.

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

## Switches and numeric steppers

Use `ToggleSwitch` for boolean settings with a visible `label`, accessible `ariaLabel`, controlled `checked` value, and `onChange` callback. It owns the track, thumb, keyboard focus, disabled styling, and reduced-motion behavior. The I/O settings and design lab use the same component.

Use `NumericStepper` for a numeric draft with decrement/increment buttons. Supply `value`, `onValueChange`, and accessible `decreaseLabel`/`increaseLabel` strings. Native input attributes, refs, blur handlers, and validation states are forwarded to the field. `min`/`max` clamp increments; `stepBy` overrides the native `step` for buttons and arrow keys (`step="any"` increments by one). Fractions are preserved. `fallbackValue` supplies the value to increment from when a draft is blank or invalid. Callers own draft validation and commit/reset behavior. `disabled` and `readOnly` also disable increment actions. Use `unit` for a visible suffix and `density="compact"` for property rows and popovers.

Use `InputGroup` and `InputSuffix` from `form-controls` to attach units to fields under one border and focus ring. Keep units outside the editable value. The shared stepper and waveform rate editor compose this same field shell.

## Search pickers

Use `SearchPickerSurface`, `SearchPickerInput`, and `SearchPickerOption` from `search-picker` for command and destination lists. The surface composes the shared dialog frame, the search field composes `InputGroup` and `Input`, and rich option rows share accent, hover, focus, and disabled states. Supply `selected` on the active option and native `disabled` for unavailable actions. Callers own filtering, keyboard navigation, result semantics, positioning, and dismissal. Put removable filter tokens in the input's `leading` slot and optional back actions or hints in its `trailing` slot. Keep result viewports shrinkable (`min-height: 0`) and constrain the surface to available viewport space.

The command palette in the app and design lab, showfile object search, timeline action insertion, and timeline jump picker use these components.

Search picker options accept `density="compact"` for anchored command suggestions. Command inputs and history search use shared fields and buttons; DMX direction and universe selection use shared toggle toolbar buttons.
