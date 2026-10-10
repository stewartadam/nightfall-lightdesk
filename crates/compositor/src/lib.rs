// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor module for managing visual layers and rendering pipelines.
#![warn(missing_docs)]

use std::marker::PhantomData;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::Render;
use nightfall_engine::Compositing;

use crate::system::CompositorRemovals;
use crate::types::{
    CompositorParameter, FinalLayerAttributedAssertions, FinalLayerOutput, LayerCompositingContext,
    ReleaseMarker,
};

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::add_compositor_removal_observers;
    pub use crate::pipeline::CompositorPipeline;
    pub use crate::system::compositor;
    pub use crate::types::*;
}

pub mod pipeline;
pub mod stages;
pub mod system;
pub mod types;

/// Registers the observers that record removals the [`compositor`](system::compositor) system
/// must react to.
///
/// The compositor runs in the [`Render`](nightfall_engine::prelude::Render) schedule, which can
/// skip several updates, so removals are recorded in [`CompositorRemovals`] when they happen
/// instead of being read from [`RemovedComponents`]. Apps that add the system without
/// [`CompositorPlugin`] call this. Calling it again for the same parameter kind has no effect.
pub fn add_compositor_removal_observers<P: CompositorParameter>(app: &mut App) {
    if app.world().contains_resource::<CompositorRemovals<P>>() {
        return;
    }
    app.init_resource::<CompositorRemovals<P>>();
    app.add_observer(
        |_: On<Remove<P>>, mut removals: ResMut<CompositorRemovals<P>>| {
            removals.parameters = true;
        },
    );
    app.add_observer(
        |_: On<Remove<ReleaseMarker>>, mut removals: ResMut<CompositorRemovals<P>>| {
            removals.layer_state = true;
        },
    );
    app.add_observer(
        |_: On<Remove<LayerCompositingContext>>, mut removals: ResMut<CompositorRemovals<P>>| {
            removals.layer_state = true;
        },
    );
}

/// Compositor plugin that adds the layer compositing system to a Bevy app.
///
/// The compositor layer stack and final layer resources are global for the app, so this plugin is
/// intended to be registered once for the app's single active parameter component domain.
pub struct CompositorPlugin<P: CompositorParameter> {
    parameter: PhantomData<fn() -> P>,
}

impl<P: CompositorParameter> Default for CompositorPlugin<P> {
    fn default() -> Self {
        Self {
            parameter: PhantomData,
        }
    }
}

impl<P: CompositorParameter> Plugin for CompositorPlugin<P> {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering CompositorPlugin");
        // Initialize the final layer resources.
        app.init_resource::<FinalLayerAttributedAssertions>();
        app.init_resource::<FinalLayerOutput>();
        add_compositor_removal_observers::<P>(app);

        // Add system to compose the layers from materialized outputs
        app.add_systems(
            Render,
            (
                crate::system::compositor::<P>.in_set(Compositing),
                // ensure current OutputLayer is available for the next systems
                ApplyDeferred,
            )
                .chain(),
        );
    }
}
