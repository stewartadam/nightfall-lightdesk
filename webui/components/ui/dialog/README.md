# Dialog presentation

Build modal dialogs with `Dialog`, and fill it with `DialogBody`, `DialogFooter` and `DialogCancelButton`. Use shared `Button` and form controls for actions and fields. The design lab's **Dialogs** panel demonstrates each kind.

`Dialog` owns the modal lifecycle (through `Modal`), the backdrop, the surface, the title row and every way to close. Its `kind` decides the close affordances, so dialogs inherit one pattern rather than wiring their own:

- **`task`** dialogs commit work, such as forms, wizards and confirmations. They show the header close button, put `DialogCancelButton` in the footer with one primary (or danger) default action last, and ignore clicks outside.
- **`info`** dialogs have nothing to commit, such as About, Settings and Layouts. They show only the header close button, with no footer, and also close on Escape or a click outside.
- **`required`** prompts need a choice, such as draft recovery. They have no close button, ignore Escape and clicks outside, and put the choices in the footer.

The header close, `DialogCancelButton`, Escape and info outside clicks all call `onDismiss`. `onSubmit` is the default action Enter runs when focus has no Enter behavior of its own; a native form submit covers fields inside a `<form>`. `busy` disables every way out and the default action together. Pass `label` when the accessible name differs from the visible title, `closeLabel` to name the close button, `headerActions` for other title-row controls, and width constraints such as `max-w-lg` through `class`.

`Modal` renders a native `<dialog>` opened with `showModal()`: the browser draws it in the top layer and makes everything outside the frontmost dialog inert, so Tab, clicks and screen readers cannot reach the page behind it. Focus moves into the dialog when it opens (an `autofocus` field, or else the dialog itself so Enter still reaches `onSubmit`) and returns to the opener on close. Floating overlays (menus, tooltips, select lists) must mount through `overlayHost()` from `modal/dialog-stack.ts`, because anything outside an open modal dialog renders beneath it and is inert. Keep open state, validation and submission in the caller. Never compose `DialogBackdrop`, `DialogSurface`, `DialogHeader` or `DialogCloseButton` by hand for a modal; they exist for `Dialog` and for non-modal surfaces such as popovers. `shared-dialogs.node.test.ts` fails when a screen renders `Modal`, `DialogBackdrop` or `DialogCloseButton` outside `Dialog`; only the palettes and the connection overlay, which are not dialogs, are exempt. The surface constrains tall forms to the viewport and scrolls the body while keeping the heading and action row visible.

Keep footers outside padded form bodies. Close buttons default to the accessible name “Close”; override it when several dialogs need distinct labels. File inputs used by drop zones remain hidden native inputs.

Dialog buttons and single-line form controls default to compact 28px sizing, matching the startup recovery actions. Header close buttons use the same height. Explicit button `size` and field `density` props override the surrounding defaults; multiline fields retain their larger editing area.

`DialogBody` uses `ScrollArea` to show directional carets when content overflows. Body classes and HTML attributes apply to the padded viewport; `style` applies to the outer sizing container. Use `scrollable={false}` when a child `ScrollArea` or `TableScroll` owns scrolling, and constrain that child with a flex or grid layout so headers and actions stay visible.
