# Dialog presentation

Use `DialogBackdrop`, `DialogSurface`, `DialogHeader`, `DialogTitle`, `DialogBody`, `DialogFooter`, and `DialogCloseButton` for modal presentation. Use shared `Button` and form controls for actions and fields. The design lab demonstrates the production entity editor and delete confirmation.

Keep open state, validation, submission, focus restoration, and domain keyboard handling in the caller. Compose these primitives with `Modal` for portal, Escape and scroll locking, or retain an existing lifecycle owner. Put `role="dialog"`, `aria-modal="true"` and an accessible title on one container. Pass placement constraints such as `max-w-lg` to the surface and content layout such as `space-y-4` to the body. The surface constrains tall forms to the viewport and scrolls the body while keeping the heading and action row visible.

Keep headers and footers outside padded form bodies. Close buttons default to the accessible name “Close”; override it when several dialogs need distinct labels. File inputs used by drop zones remain hidden native inputs.

Dialog buttons and single-line form controls default to compact 28px sizing, matching the startup recovery actions. Header close buttons use the same height. Explicit button `size` and field `density` props override the surrounding defaults; multiline fields retain their larger editing area.

`DialogBody` uses `ScrollArea` to show directional carets when content overflows. Body classes and HTML attributes apply to the padded viewport; `style` applies to the outer sizing container. Use `scrollable={false}` when a child `ScrollArea` or `TableScroll` owns scrolling, and constrain that child with a flex or grid layout so headers and actions stay visible.
