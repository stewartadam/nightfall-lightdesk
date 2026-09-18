// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! HTTP route registry for plugin-owned endpoint registration.
//!
//! This module provides a registry-based architecture where domain plugins
//! can register their own HTTP routes without the websocket crate needing
//! to depend on them directly.
//!
//! # Architecture
//!
//! Plugins register routes during their `build()` phase using the
//! `HttpRouteRegistry` resource. When the Axum server starts, it consumes
//! all registered routes and builds the final router.
//!
//! # Usage
//!
//! ```ignore
//! impl Plugin for MyPlugin {
//!     fn build(&self, app: &mut App) {
//!         app.world_mut()
//!             .resource_mut::<HttpRouteRegistry>()
//!             .register("/api/my-endpoint/{id}", get(my_handler));
//!     }
//! }
//! ```

use axum::Router;
use bevy_ecs::prelude::*;

use crate::websocket::AxumAppState;

/// Registry for stateless HTTP routes.
///
/// Plugins register their routes at app startup. When the websocket server
/// starts, it consumes all registered routes and merges them into the main
/// router.
///
/// Routes registered here do not have access to the websocket's shared state.
/// For simple REST-style endpoints (like serving static files or resources),
/// this is the appropriate registration mechanism.
///
/// # Self-Registration
///
/// Each plugin registers its own routes in its `build()` method:
///
/// ```ignore
/// impl Plugin for MyPlugin {
///     fn build(&self, app: &mut App) {
///         app.world_mut()
///             .resource_mut::<HttpRouteRegistry>()
///             .register("/api/my-resource/{id}", get(my_handler));
///     }
/// }
/// ```
#[derive(Resource, Default)]
pub struct HttpRouteRegistry {
    router: Router,
    stateful_router: Router<AxumAppState>,
}

impl HttpRouteRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            router: Router::new(),
            stateful_router: Router::new(),
        }
    }

    /// Register a route with a path and method router.
    ///
    /// The `path` should be an Axum-style path pattern (e.g., "/api/mesh/{id}").
    /// The `handler` is a `MethodRouter` created with Axum's routing methods
    /// like `get()`, `post()`, etc.
    ///
    /// # Example
    ///
    /// ```ignore
    /// use axum::routing::get;
    ///
    /// registry.register("/api/health", get(health_handler));
    /// registry.register("/api/items/{id}", get(get_item).post(create_item));
    /// ```
    pub fn register(&mut self, path: impl AsRef<str>, handler: axum::routing::MethodRouter) {
        let path = path.as_ref();
        tracing::debug!("Registering HTTP route: {}", path);
        self.router = std::mem::take(&mut self.router).route(path, handler);
    }

    /// Register a route that needs access to the Axum application state.
    ///
    /// Most plugin-owned routes should remain stateless. Use this only for
    /// lifecycle-sensitive RPCs that need to enqueue work into the Bevy command
    /// pipeline through the websocket command channel.
    pub fn register_stateful(
        &mut self,
        path: impl AsRef<str>,
        handler: axum::routing::MethodRouter<AxumAppState>,
    ) {
        let path = path.as_ref();
        tracing::debug!("Registering stateful HTTP route: {}", path);
        self.stateful_router = std::mem::take(&mut self.stateful_router).route(path, handler);
    }

    /// Take the built router, consuming the routes from the registry.
    ///
    /// This is called when building the Axum router. After calling this,
    /// the registry will be empty.
    pub fn take_router(&mut self) -> Router {
        std::mem::take(&mut self.router)
    }

    /// Take the built stateful router, consuming the stateful routes from the registry.
    pub fn take_stateful_router(&mut self) -> Router<AxumAppState> {
        std::mem::take(&mut self.stateful_router)
    }

    /// Check if any routes are registered.
    pub fn is_empty(&self) -> bool {
        // Router doesn't expose a way to check this directly,
        // so we track it implicitly by the default state
        false // Conservative - assume routes may be registered
    }
}
