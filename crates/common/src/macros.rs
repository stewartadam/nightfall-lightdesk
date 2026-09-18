// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use crate::data::Identifiers;

pub trait Source {}

/// Named command sequence that can be invoked as one executable action.
pub struct Macro {
    pub identifiers: Identifiers,
    pub commands: Vec<String>,
}

impl Source for Macro {}
