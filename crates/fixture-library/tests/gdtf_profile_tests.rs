// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Piecewise polynomial expectations independent of the fixture corpus.

use gdtf::physical_descriptions::{DmxProfile, Point};
use nightfall_fixture_library::gdtf_profiles::compile_profiles;

/// Reproduce the official builder S-curve example using fractional XML breakpoints.
fn s_curve() -> DmxProfile {
    serde_json::from_value(serde_json::json!({"@Name":"S", "Point":[
        {"@DMXPercentage":0.5,"@CFC0":50,"@CFC1":200,"@CFC2":-200},
        {"@DMXPercentage":0,"@CFC2":200}
    ]}))
    .unwrap()
}

/// Fractional input with percentage-valued coefficients matches the published S-curve.
#[test]
fn official_curve_has_independent_sample_values() {
    let library = compile_profiles(&[s_curve()], 2).unwrap();
    let link = serde_json::from_value(serde_json::json!("S")).unwrap();
    let profile = library.get(library.resolve(&link).unwrap()).unwrap();
    for (input, output) in [
        (0.0, 0.0),
        (0.25, 12.5),
        (0.5, 50.0),
        (0.75, 87.5),
        (1.0, 100.0),
    ] {
        assert_eq!(profile.evaluate_normalized(input).unwrap(), output);
    }
}

/// Breakpoint equality selects the new polynomial, and gaps before the first point return zero.
#[test]
fn discontinuities_and_nonmonotonic_curves_are_preserved() {
    let mut source = s_curve();
    source.points = vec![
        Point {
            dmx_percentage: 0.25,
            cfc0: 20.0,
            cfc1: -100.0,
            cfc2: 0.0,
            cfc3: 0.0,
        },
        Point {
            dmx_percentage: 0.5,
            cfc0: 120.0,
            cfc1: 0.0,
            cfc2: 0.0,
            cfc3: 8.0,
        },
    ];
    let library = compile_profiles(&[source], 2).unwrap();
    let curve = library.get(0).unwrap();
    assert_eq!(curve.evaluate_normalized(0.0).unwrap(), 0.0);
    assert_eq!(curve.evaluate_normalized(0.25).unwrap(), 20.0);
    assert_eq!(curve.evaluate_normalized(0.375).unwrap(), 7.5);
    assert_eq!(curve.evaluate_normalized(0.5).unwrap(), 120.0);
    assert_eq!(curve.evaluate_normalized(1.0).unwrap(), 121.0);
    for input in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
        assert_eq!(
            curve.evaluate_normalized(input).unwrap_err().code,
            "invalid_profile_input"
        );
    }
}

/// Bad identities, duplicate breakpoints and unbounded data cannot enter an immutable curve library.
#[test]
fn malformed_profiles_and_links_are_rejected() {
    assert_eq!(
        compile_profiles(&[s_curve()], 1).unwrap_err().code,
        "profile_point_limit"
    );
    assert_eq!(
        compile_profiles(&[s_curve(), s_curve()], 4)
            .unwrap_err()
            .code,
        "duplicate_profile"
    );
    let mut source = s_curve();
    source.points[1].dmx_percentage = 0.5;
    assert_eq!(
        compile_profiles(&[source.clone()], 2).unwrap_err().code,
        "duplicate_profile_point"
    );
    source.points[0].cfc0 = f64::NAN;
    assert_eq!(
        compile_profiles(&[source.clone()], 2).unwrap_err().code,
        "invalid_profile_point"
    );
    source.points.clear();
    assert_eq!(
        compile_profiles(&[source.clone()], 2).unwrap_err().code,
        "empty_profile"
    );
    source.name = None;
    assert_eq!(
        compile_profiles(&[source], 2).unwrap_err().code,
        "missing_profile_name"
    );
    let library = compile_profiles(&[s_curve()], 2).unwrap();
    for (link, code) in [
        ("Missing", "missing_profile"),
        ("S.Point", "invalid_profile_link"),
    ] {
        let link = serde_json::from_value(serde_json::json!(link)).unwrap();
        assert_eq!(library.resolve(&link).unwrap_err().code, code);
    }
}

/// Finite coefficients can still overflow at evaluation and must not produce an infinite physical value.
#[test]
fn polynomial_overflow_is_reported() {
    let mut source = s_curve();
    source.points = vec![Point {
        dmx_percentage: 0.0,
        cfc0: f64::MAX,
        cfc1: f64::MAX,
        cfc2: 0.0,
        cfc3: 0.0,
    }];
    let library = compile_profiles(&[source], 1).unwrap();
    assert_eq!(
        library
            .get(0)
            .unwrap()
            .evaluate_normalized(1.0)
            .unwrap_err()
            .code,
        "profile_output_overflow"
    );
}

/// Raw normalization preserves 32-bit endpoint distinctions and does not round through f32.
#[test]
fn raw_intervals_preserve_full_resolution() {
    let mut source = s_curve();
    source.points = vec![Point {
        dmx_percentage: 0.0,
        cfc0: 0.0,
        cfc1: 100.0,
        cfc2: 0.0,
        cfc3: 0.0,
    }];
    let library = compile_profiles(&[source], 1).unwrap();
    let curve = library.get(0).unwrap();
    assert_eq!(curve.evaluate_raw(u32::MAX, 0, u32::MAX).unwrap(), 100.0);
    assert!(curve.evaluate_raw(u32::MAX - 1, 0, u32::MAX).unwrap() < 100.0);
    assert_eq!(curve.evaluate_raw(150, 100, 200).unwrap(), 50.0);
    assert_eq!(curve.evaluate_raw(100, 100, 100).unwrap(), 0.0);
    for (raw, from, to) in [(99, 100, 200), (201, 100, 200), (100, 200, 100)] {
        assert_eq!(
            curve.evaluate_raw(raw, from, to).unwrap_err().code,
            "invalid_profile_raw_range"
        );
    }
}
