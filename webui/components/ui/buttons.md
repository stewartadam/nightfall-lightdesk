# Buttons and toolbars

Use `Button` from `visual-language/button` for ordinary actions. `variant` selects `secondary` (default), `primary`, `subtle`, or `danger`; `size` selects `standard`, `compact`, or `icon`. Native attributes, refs, form submission and event handlers pass through to the button. Icon-only buttons need an accessible label.

Use `ToolbarButton` or `ToggleToolbarButton` for panel tools. `label` names the action for assistive technology and supplies the default tooltip. Set `tooltip` separately when help text includes a shortcut or changes with state. Toggles expose `pressed` through `aria-pressed`; `disabled` preserves the state while preventing activation. Use `variant="danger"` for destructive tools and `size="labeled"` for text alongside or instead of an icon.

`PanelToolbar` arranges left and right action groups and wraps them in narrow panels. `ToolbarSeparator` separates related actions without taking focus. Callers own command availability, selection and preview state. Shared styles own hover, focus, selection, disabled and momentary press feedback, including reduced-motion behavior.

The lab's Buttons and Toolbars panels import these production components. Cue and sequence editor toolbars and entity-dialog actions use the same components. Keep demo CSS focused on arranging examples; add shared variants here when another app surface needs them.
