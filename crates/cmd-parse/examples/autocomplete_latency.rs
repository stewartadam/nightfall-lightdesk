// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Measures complete response generation over the authoring design matrix.

use std::hint::black_box;
use std::time::Instant;

use nightfall_cmd_parse::autocomplete::complete_command;
use serde::Deserialize;

/// Reads only inputs, leaving snapshot expectations outside the timing measurement.
#[derive(Deserialize)]
struct Matrix {
    cases: Vec<Case>,
}

/// One representative command prefix from the shared authoring matrix.
#[derive(Deserialize)]
struct Case {
    input: String,
}

/// Warms each input and reports response latency across a configurable number of complete matrix runs.
fn main() {
    let iterations = std::env::args().nth(1).map_or(100, |value| {
        value.parse::<usize>().expect("positive iteration count")
    });
    assert!(iterations > 0);
    let matrix: Matrix =
        serde_json::from_str(include_str!("../tests/fixtures/design_matrix_cases.json"))
            .expect("valid matrix");
    for case in &matrix.cases {
        black_box(complete_command(&case.input, case.input.len()));
    }
    let mut samples = Vec::with_capacity(iterations * matrix.cases.len());
    for _ in 0..iterations {
        for case in &matrix.cases {
            let start = Instant::now();
            black_box(complete_command(&case.input, case.input.len()));
            samples.push(start.elapsed().as_micros());
        }
    }
    samples.sort_unstable();
    println!(
        "{} responses: p50={}µs p95={}µs p99={}µs max={}µs",
        samples.len(),
        samples[samples.len() / 2],
        samples[samples.len() * 95 / 100],
        samples[samples.len() * 99 / 100],
        samples.last().unwrap()
    );
}
