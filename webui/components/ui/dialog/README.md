# Dialog presentation

Use `DialogBackdrop`, `DialogSurface`, `DialogHeader`, `DialogTitle`, `DialogBody`, `DialogFooter`, and `DialogCloseButton` for modal presentation. Use shared `Button` and form controls for actions and fields. The design lab demonstrates the production entity editor and delete confirmation.

Keep open state, validation, submission, focus restoration, and domain keyboard handling in the caller. Compose these primitives with `Modal` for portal, Escape and scroll locking, or retain an existing lifecycle owner. Put `role="dialog"`, `aria-modal="true"` and an accessible title on one container. Pass placement constraints such as `max-w-lg` to the surface and content layout such as `space-y-4` to the body. The surface constrains tall forms to the viewport and scrolls the body while keeping the heading and action row visible.

Every dialog follows one of three close patterns, demonstrated in the design lab's **Dialogs** panel:

- **Task** dialogs commit work, such as forms, wizards and confirmations. They show `DialogCloseButton` and a footer `Cancel` that share the Escape handler, place one primary (or danger) default action last, and ignore clicks outside. While work cannot be cancelled, disable every way out together. Rename Cancel to Close once nothing remains to undo.
- **Info** dialogs have nothing to commit, such as About, Settings and Layouts. They show only `DialogCloseButton`, with no footer, and also close on Escape or a click outside.
- **Required** prompts need a choice, such as draft recovery. They have no close button, ignore Escape and clicks outside, and put the choices in the footer.

Never hand-roll a close button; use `DialogCloseButton`. Compose with `Modal` so Escape works and nested dialogs can suspend their parent's Escape through `closeOnEscape`.

Keep headers and footers outside padded form bodies. Close buttons default to the accessible name “Close”; override it when several dialogs need distinct labels. File inputs used by drop zones remain hidden native inputs.

Dialog buttons and single-line form controls default to compact 28px sizing, matching the startup recovery actions. Header close buttons use the same height. Explicit button `size` and field `density` props override the surrounding defaults; multiline fields retain their larger editing area.

`DialogBody` uses `ScrollArea` to show directional carets when content overflows. Body classes and HTML attributes apply to the padded viewport; `style` applies to the outer sizing container. Use `scrollable={false}` when a child `ScrollArea` or `TableScroll` owns scrolling, and constrain that child with a flex or grid layout so headers and actions stay visible.
