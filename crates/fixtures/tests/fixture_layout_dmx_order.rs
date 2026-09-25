// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::BTreeMap;

use nightfall_fixtures::prelude::FixtureLayout;

/// Golden DMX element order shared with the web UI's patch-map tests.
const GOLDEN_ORDER: &str = include_str!("data/fixture_layout_dmx_element_order.json");

/// Every layout variant, so layouts missing from the golden file must keep declaration order.
const ALL_LAYOUTS: [FixtureLayout; 6] = [
    FixtureLayout::LedBar,
    FixtureLayout::MovingHead,
    FixtureLayout::StrobeMatrix,
    FixtureLayout::RgbStrobeBar,
    FixtureLayout::RotatingWashBeam,
    FixtureLayout::LinearWashBar,
];

/// Pins the engine's wiring-order table to the golden file the web UI also checks, so the
/// DMX panel's labels and jump targets cannot drift from the addresses the engine writes.
#[test]
fn dmx_element_order_matches_shared_golden_file() {
    let golden: BTreeMap<String, Vec<u32>> =
        serde_json::from_str(GOLDEN_ORDER).expect("golden order parses");

    for layout in ALL_LAYOUTS {
        let key = serde_json::to_value(layout)
            .expect("layout serializes")
            .as_str()
            .expect("layout serializes as a string")
            .to_string();
        assert_eq!(
            layout.dmx_element_order(),
            golden.get(&key).cloned(),
            "wiring order for {key}"
        );
    }

    for key in golden.keys() {
        let layout: FixtureLayout = serde_json::from_value(serde_json::Value::String(key.clone()))
            .expect("golden keys name fixture layouts");
        assert!(layout.dmx_element_order().is_some(), "{key} has an order");
    }
}
