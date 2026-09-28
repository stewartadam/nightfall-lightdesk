// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Loader for the Rust WASM bridge module, shared by the async wrappers in
 * `wasm-bridge.ts` and by hot paths (such as the visualizer, which also runs
 * in a worker) that call the module synchronously once it has loaded.
 */

/** The WASM bridge module's exports. */
export type WasmBridgeModule =
  typeof import("../assets/wasm/nightfall_wasm_bridge");

let loaded: WasmBridgeModule | null = null;
let loading: Promise<WasmBridgeModule> | null = null;

/**
 * Imports and instantiates the WASM bridge once, resolving with its exports.
 * Concurrent callers share one load; a failed load may be retried.
 */
export function loadWasmBridge(): Promise<WasmBridgeModule> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= instantiate().then(
    (module) => {
      loaded = module;
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** Returns the WASM bridge's exports if it has finished loading, otherwise null. */
export function loadedWasmBridge(): WasmBridgeModule | null {
  return loaded;
}

/**
 * Imports the WASM bridge and instantiates its binary, reading it from disk
 * under Node (tests) and fetching it in browsers and workers.
 */
async function instantiate(): Promise<WasmBridgeModule> {
  const module = await import("../assets/wasm/nightfall_wasm_bridge.js");
  const runtime = globalThis as { process?: { versions?: { node?: string } } };
  if (runtime.process?.versions?.node !== undefined) {
    const importNodeModule = new Function(
      "specifier",
      "return import(specifier)",
    ) as (
      specifier: string,
    ) => Promise<{ readFile(path: URL): Promise<Uint8Array> }>;
    const { readFile } = await importNodeModule("node:fs/promises");
    const wasmBytes = await readFile(
      new URL("../assets/wasm/nightfall_wasm_bridge_bg.wasm", import.meta.url),
    );
    await module.default({ module_or_path: wasmBytes });
  } else {
    await module.default();
  }
  return module;
}
