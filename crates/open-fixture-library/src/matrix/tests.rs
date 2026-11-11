// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;
use crate::schema::OflMatrix;

/// Parses a matrix object from JSON.
fn matrix(json: serde_json::Value) -> OflMatrix {
    serde_json::from_value(json).expect("matrix JSON should parse")
}

/// Returns the pixel keys of a matrix in definition order.
fn keys(matrix: &OflMatrix) -> Vec<String> {
    matrix.pixels().into_iter().map(|pixel| pixel.key).collect()
}

/// Verifies `pixelKeys` is read as `[z][y][x]`, skipping `null` positions while
/// keeping the positions of the pixels after them.
#[test]
fn pixel_keys_follow_z_y_x_structure_and_skip_gaps() {
    let matrix = matrix(serde_json::json!({
        "pixelKeys": [
            [["a", null, "c"], ["d", "e", "f"]],
            [["g", "h", "i"]]
        ]
    }));
    let pixels = matrix.pixels();
    let positions: Vec<(&str, [usize; 3])> = pixels
        .iter()
        .map(|pixel| (pixel.key.as_str(), pixel.position))
        .collect();
    assert_eq!(
        positions,
        vec![
            ("a", [1, 1, 1]),
            ("c", [3, 1, 1]),
            ("d", [1, 2, 1]),
            ("e", [2, 2, 1]),
            ("f", [3, 2, 1]),
            ("g", [1, 1, 2]),
            ("h", [2, 1, 2]),
            ("i", [3, 1, 2]),
        ]
    );
    assert_eq!(matrix.defined_axes(), vec![Z, Y, X]);
}

/// Verifies `pixelCount` generates OFL's default keys: plain numbers for one axis and
/// coordinate tuples for two or three.
#[test]
fn pixel_count_generates_ofl_default_keys() {
    assert_eq!(
        keys(&matrix(serde_json::json!({ "pixelCount": [3, 1, 1] }))),
        ["1", "2", "3"]
    );
    assert_eq!(
        keys(&matrix(serde_json::json!({ "pixelCount": [1, 1, 2] }))),
        ["1", "2"]
    );
    assert_eq!(
        keys(&matrix(serde_json::json!({ "pixelCount": [2, 2, 1] }))),
        ["(1, 1)", "(2, 1)", "(1, 2)", "(2, 2)"]
    );
    assert_eq!(
        keys(&matrix(serde_json::json!({ "pixelCount": [1, 2, 2] }))),
        ["(1, 1)", "(2, 1)", "(1, 2)", "(2, 2)"]
    );
    assert_eq!(
        keys(&matrix(serde_json::json!({ "pixelCount": [2, 1, 2] }))),
        ["(1, 1)", "(2, 1)", "(1, 2)", "(2, 2)"]
    );
    assert_eq!(
        keys(&matrix(serde_json::json!({ "pixelCount": [2, 2, 2] })))[7],
        "(2, 2, 2)"
    );
}

/// Verifies every `eachPixel…` keyword orders pixels with its first axis changing
/// fastest, and `eachPixelABC` sorts keys in natural order.
#[test]
fn repeat_orders_sort_pixels_by_axis() {
    let matrix = matrix(serde_json::json!({
        "pixelKeys": [[["10", "2"], ["1", "20"]]]
    }));
    let order = |order| matrix.repeat_for_keys(&OflRepeatFor::Order(order));
    assert_eq!(order(OflRepeatOrder::EachPixelXyz), ["10", "2", "1", "20"]);
    assert_eq!(order(OflRepeatOrder::EachPixelYxz), ["10", "1", "2", "20"]);
    assert_eq!(order(OflRepeatOrder::EachPixelAbc), ["1", "2", "10", "20"]);
    assert_eq!(
        matrix.repeat_for_keys(&OflRepeatFor::Keys(vec!["20".into(), "1".into()])),
        ["20", "1"]
    );
}

/// Verifies pixel groups resolve `"all"`, explicit key lists and position and name
/// constraints, and keep their definition order.
#[test]
fn pixel_groups_resolve_every_group_kind() {
    let matrix = matrix(serde_json::json!({
        "pixelCount": [4, 2, 1],
        "pixelGroups": {
            "Odd columns": { "x": ["odd"] },
            "Everything": "all",
            "Pair": ["(1, 1)", "(4, 2)"],
            "Right bottom": { "x": [">=3"], "y": ["=2"] },
            "Named": { "name": ["^\\(1"] }
        }
    }));
    let groups = matrix.pixel_groups();
    let names: Vec<&str> = groups.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        ["Odd columns", "Everything", "Pair", "Right bottom", "Named"]
    );
    assert_eq!(groups[0].1, ["(1, 1)", "(3, 1)", "(1, 2)", "(3, 2)"]);
    assert_eq!(groups[1].1.len(), 8);
    assert_eq!(groups[2].1, ["(1, 1)", "(4, 2)"]);
    assert_eq!(groups[3].1, ["(3, 2)", "(4, 2)"]);
    assert_eq!(groups[4].1, ["(1, 1)", "(1, 2)"]);
    assert_eq!(
        matrix.repeat_for_keys(&OflRepeatFor::Order(OflRepeatOrder::EachPixelGroup)),
        names
    );
}

/// Verifies each OFL position constraint form, and that malformed ones match nothing.
#[test]
fn position_constraints_match_ofl_semantics() {
    let matching = |constraint: &str| -> Vec<usize> {
        (1..=8)
            .filter(|position| position_matches(constraint, *position))
            .collect()
    };
    assert_eq!(matching("=3"), [3]);
    assert_eq!(matching(">=7"), [7, 8]);
    assert_eq!(matching("<=2"), [1, 2]);
    assert_eq!(matching("even"), [2, 4, 6, 8]);
    assert_eq!(matching("odd"), [1, 3, 5, 7]);
    assert_eq!(matching("3n"), [3, 6]);
    assert_eq!(matching("3n+1"), [1, 4, 7]);
    assert!(matching("0n").is_empty());
    assert!(matching("n+1").is_empty());
    assert!(matching("bogus").is_empty());
}

/// Verifies natural ordering compares digit runs by value and is otherwise case-insensitive.
#[test]
fn natural_order_compares_numbers_by_value() {
    let mut keys = vec!["Pixel 10", "pixel 2", "Pixel 1", "B", "a", "007", "8"];
    keys.sort_by(|a, b| natural_cmp(a, b));
    assert_eq!(
        keys,
        ["007", "8", "a", "B", "Pixel 1", "pixel 2", "Pixel 10"]
    );
}
