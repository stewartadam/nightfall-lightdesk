// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{error::Error, fs, path::Path};

use wit_component::ComponentEncoder;

/// Packages the supplied Cargo artifact, or the default debug/release module, as a component.
fn main() -> Result<(), Box<dyn Error>> {
    let profile = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "debug".to_string());
    let output_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("wasm32-unknown-unknown")
        .join(&profile);
    let core_module = std::env::args()
        .nth(2)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| output_dir.join("fx_module_basic_module.wasm"));
    fs::create_dir_all(&output_dir)?;
    let component_path = output_dir.join("basic-module.wasm");

    let module = fs::read(&core_module)?;
    let component = ComponentEncoder::default().module(&module)?.encode()?;
    fs::write(&component_path, component)?;

    println!("{}", component_path.display());
    Ok(())
}
