# Form controls

The app and design lab import `Input`, `Textarea`, `NativeSelect`, `Checkbox`, `Radio`, and `RadioCard` from this directory. Their stylesheet owns control geometry, colors, focus, validation, disabled and read-only states.

Each component forwards native attributes, event handlers and refs. Associate controls with labels using a wrapping `label` or matching `for` and `id`. Keep validation, draft state and submission in the caller; use `aria-invalid` and `aria-describedby` for errors and hints.

Text controls follow the surrounding density by default. Set `density="compact"` for inline properties, or `density="comfortable"` for a fixed full-size control. `NativeSelect` preserves the browser's option menu and keyboard behavior; searchable or multi-select choices use the existing advanced-select widget.

Use `inherited` on `Input` when an editable value comes from a parent default. It uses muted text while retaining normal editing and focus behavior.

Use `RadioCard` when each choice of a radio group needs a title and an explanation, such as export options. The whole card selects the radio and uses the shared selectable surface (see `selectable-surface.css`); the title is the radio's accessible name and the description its accessible description. As with `Radio`, the caller owns `name`, `checked` and `onChange`. Stack the cards in a `fieldset` named by a `legend` or `aria-labelledby`, and disable the fieldset to disable every card.

Use classes for placement and width constraints. Extend the shared stylesheet for new visual states instead of adding screen-specific input styling.

`focus.css` owns the single-pixel focus ring for all native inputs, textareas and selects in the application theme, including legacy fields. Shared controls also use it outside the theme. Do not add focus border, outline or ring utilities to individual inputs. `aria-invalid="true"` selects the error color; `data-validation-severity="warning"` selects the warning color. Thickness comes from `--nf-input-focus-width`.

Composite widgets such as searches, range fields and numeric steppers use `nf-input-group` on the enclosing field surface. The wrapper receives the shared ring when its input has visible focus; the inner input stays transparent without a second ring. Keep sizing and layout in the widget. Buttons within the group retain their own keyboard focus indicator.

Examples live in the design lab's Input forms panel. Production adopters include app settings, entity editor dialogs, CRUD label properties, and cue, sequence and timeline property editors.
