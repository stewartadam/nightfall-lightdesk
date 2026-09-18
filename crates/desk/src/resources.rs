// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use bevy_platform::cell::SyncCell;

pub mod log_config;
pub mod network_stats;
pub mod variables;

/// Wraps thread-unsafe (!Sync) resources in a SyncCell so that they can be used
/// as resources, albeit with exclusively mutable access.
///
/// TODO: Migrate to native Exclusive wrapper type when it is released out of
/// nightly. https://doc.rust-lang.org/nightly/std/sync/struct.Exclusive.html
#[derive(Resource)]
pub struct ExclusiveResource<T> {
    inner: SyncCell<T>,
}
impl<T> ExclusiveResource<T> {
    pub fn get(&mut self) -> &mut T {
        self.inner.get()
    }

    pub fn new(value: T) -> Self {
        Self {
            inner: SyncCell::new(value),
        }
    }
}
