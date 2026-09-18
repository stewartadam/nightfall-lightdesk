// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Parser components.

pub mod analysis;
mod frontier;
pub mod lexer;
pub mod parse_shapes;
pub mod parse_specs;
pub mod prefix;
pub mod query;
pub mod strict;
pub mod structural;
mod structural_expectation;
mod structural_frontier;
mod structural_fx;
mod structural_programmer;
mod structural_tree;
