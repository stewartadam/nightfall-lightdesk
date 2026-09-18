// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    error::Error,
    fs,
    path::Path,
};

use wit_component::ComponentEncoder;

fn main() -> Result<(), Box<dyn Error>> {
    let profile = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "debug".to_string());
    let output_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("wasm32-unknown-unknown")
        .join(&profile);
    let core_module = output_dir.join("fx_module_basic_module.wasm");
    let component_path = output_dir.join("basic-module.wasm");

    let module = fs::read(&core_module)?;
    let component = ComponentEncoder::default().module(&module)?.encode()?;
    fs::write(&component_path, component)?;

    println!("{}", component_path.display());
    Ok(())
}
