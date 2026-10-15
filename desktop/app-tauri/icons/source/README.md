# App icon sources

Every icon in `desktop/app-tauri/icons/` is generated with the Tauri CLI.

- Windows, Linux, iOS and Android icons come from the full-bleed logo `webui/public/logo.svg`:

  ```sh
  pnpm exec tauri icon webui/public/logo.svg -o desktop/app-tauri/icons
  ```

- `icon.icns` (macOS) comes from `macos.svg`, which follows Apple's app icon grid: an 824px body with
  a drop shadow, centred in a transparent 1024px canvas. A full-bleed icon renders larger than every
  other app in the Dock and the app switcher. Generate it into a scratch directory and keep only the `.icns`:

  ```sh
  pnpm exec tauri icon desktop/app-tauri/icons/source/macos.svg -o /tmp/nightfall-macos-icons
  cp /tmp/nightfall-macos-icons/icon.icns desktop/app-tauri/icons/icon.icns
  ```
