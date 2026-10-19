# Buttons and toolbars

Use `Button` from `visual-language/button` for ordinary actions. `variant` selects `secondary` (default), `primary`, `subtle`, or `danger`. `size` selects:

- `standard` for dialog footers and prominent actions;
- `compact` for dense panels, banners, menu headers and preset rows;
- `icon` (32px) and `icon-compact` (28px) for icon-only actions. Both are square for a lone icon and widen only to fit an icon with a menu caret, such as the compact header's logo menu;
- `icon-inline` (22px) for a lone icon inside a dense surface, such as the settings button on a clip card;
- `inline` for a 20px button that sits inside a line of text or a status strip, such as the browser demo's reset action, without raising the line's height.

Native attributes, refs, form submission and event handlers pass through to the button. Icon-only buttons need an accessible label. Pass `tooltip` for hover and focus help instead of `title`; see Tooltips in the README. Do not resize `.nf-button` from surrounding CSS; add a size here instead.

`DropdownMenu` renders its own trigger `<button>`. Pass `triggerVariant` and/or `triggerSize` to give it the `Button` look (both use the `Button` values); the `trigger` content then only supplies the label and caret. `AppMenu` forwards `triggerSize` the same way. Components that must own a native button can call `buttonClass(variant)` and set `data-size` to stay in sync with `Button`.

Use `ToolbarButton` or `ToggleToolbarButton` for panel tools. `label` names the action for assistive technology and supplies the default tooltip. Set `tooltip` separately when help text includes a shortcut or changes with state. Toggles expose `pressed` through `aria-pressed`, and only `ToggleToolbarButton` can set it; neither accepts `title`. `disabled` preserves the state while preventing activation. Use `variant="danger"` for destructive tools and `size="labeled"` for text alongside or instead of an icon. Pass `count` to show how many items an action applies to (such as a selection) as a corner `CountBadge` (see Badges in README.md); it never changes the button's width, so selection changes cannot reflow the toolbar.

`PanelToolbar` arranges left and right action groups and wraps them in narrow panels. `ToolbarSeparator` separates related actions without taking focus. Callers own command availability, selection and preview state. Shared styles own hover, focus, selection, disabled and momentary press feedback, including reduced-motion behavior.

The lab's Buttons and Toolbars panels import these production components. Cue and sequence editor toolbars and entity-dialog actions use the same components. Keep demo CSS focused on arranging examples; add shared variants here when another app surface needs them.
