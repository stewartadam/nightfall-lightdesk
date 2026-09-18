# Basic FX Module Example

This example is a minimal fx module guest crate that renders a seeded intensity pulse across the resolved selection.

Build, package, and install it:

```bash
npm run fx-module:install -- crates/fx-module/examples/basic-module
```

That installs the componentized module at:

```text
<nightfall-data-dir>/fx-modules/basic-module.wasm
```

Example workflow:

```bash
store fx 1 basic-module selection fix 1 config rand=5
fx module 1 start
```

The stored `rand` config entry is passed to the host as the activation seed, so repeated activations with the same config produce the same phase offset.
