# Nightfall Data Grid

A virtualized, spreadsheet-style data grid for [SolidJS](https://www.solidjs.com/). It powers the tables in [Nightfall](https://nightfall.live), a lighting control app, and handles thousands of rows with cell and row selection, keyboard navigation, inline editing, copy and paste, sorting, column resizing and frozen columns.

## Install

```sh
npm install @stewartadam/nightfall-data-grid solid-js
```

`solid-js` 1.9 is a peer dependency. The grid's icons come from `@squidlab/phosphor-solid`, which ships TypeScript source, so build your app with a Solid-aware bundler such as Vite with `vite-plugin-solid`.

## Use

Import the stylesheet once, describe your columns, and give the grid a cell provider that maps each row and column to a cell:

```tsx
import DataGrid, {
  createKeyedDataGridCellProvider,
} from "@stewartadam/nightfall-data-grid";
import {
  type GridColumn,
  GridCellKind,
} from "@stewartadam/nightfall-data-grid/types";
import "@stewartadam/nightfall-data-grid/styles.css";
import { createMemo } from "solid-js";

interface Fixture {
  id: string;
  name: string;
  channels: number;
}

const columns: GridColumn[] = [
  { id: "name", title: "Name", width: 200 },
  { id: "channels", title: "Channels", width: 90, align: "right" },
];

export function FixtureTable(props: { fixtures: Fixture[] }) {
  const provider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: props.fixtures,
      columns,
      rowKey: (fixture) => fixture.id,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) =>
        column.id === "name"
          ? { kind: GridCellKind.Text, data: row.name }
          : { kind: GridCellKind.Number, data: row.channels },
    }),
  );
  return (
    <DataGrid
      ariaLabel="Fixtures"
      readOnly
      columns={columns}
      rows={props.fixtures.length}
      cellProvider={provider}
      empty="No fixtures yet"
      height="content"
    />
  );
}
```

Row and column keys must be stable: the grid keeps selection and sizing attached to them as rows move.

Other props include:

- `onCellEdited`: receives edits, so you can make cells editable.
- `richCellExtensions`: renders custom cells with Solid components.
- `onMetric`: reports render metrics.

## Styling

`styles.css` contains the grid's rules and the [Tailwind](https://tailwindcss.com/) utility classes its markup uses. It leaves out Tailwind's base reset, so it doesn't change the rest of your page, and its rules only match the grid's own elements.

The grid takes its colors from CSS variables, which you can set on the page or on any element around a grid:

- `--panel`, `--raised` and `--line`: backgrounds, hovered rows and row lines.
- `--text` and `--muted`: cell text and header text.
- `--accent`: selection and focus.

More specific variables take precedence over those:

- `--data-grid-bg`, `--data-grid-text` and `--data-grid-header-bg`.
- `--data-grid-selected-bg`, `--data-grid-selected-header-bg` and `--data-grid-selection-ring`.
- `--data-grid-column-border`: column dividers.

Read-only grids use the table appearance, which always takes its background and header colors from `--panel`. Without any of these variables, the grid uses a dark theme.

## License

[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/).

## Contributing

The grid is developed in the [Nightfall repository](https://github.com/stewartadam/nightfall-lightdesk) under `packages/data-grid`. Inside that repository, the app imports the package's source directly, with no build step.

To publish a release:

1. Bump `version` in `package.json` and merge it into `develop`.
2. Run the **Publish data grid** workflow on `develop` from the repository's Actions tab. It builds the package, packs it, and publishes it to npm with provenance. Check the **dry run** box first to see what would be published.

The workflow publishes through npm's trusted publishing, so no npm token is stored in the repository. `prepack` builds `dist/`, and pnpm swaps in the `publishConfig.exports` map that points at the build.
