// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Walking the scene tree with world-space transforms.

use crate::scene::{Fixture, Layer, Scene, SceneNode};
use crate::transform::Transform;

/// An object of the scene together with where it sits in the tree and in the world.
#[derive(Debug, Clone)]
pub struct PlacedObject<'a> {
    /// The object.
    pub node: &'a SceneNode,
    /// Layer the object is on.
    pub layer: &'a Layer,
    /// Objects enclosing this one, outermost first (groups, trusses, parent fixtures).
    pub ancestors: Vec<&'a SceneNode>,
    /// The object's transform in world space: right-handed, Z up, millimetres.
    pub world: Transform,
}

impl<'a> PlacedObject<'a> {
    /// Returns the object as a fixture, or `None` when it is another kind of object.
    pub fn fixture(&self) -> Option<&'a Fixture> {
        match self.node {
            SceneNode::Fixture(fixture) => Some(fixture),
            _ => None,
        }
    }

    /// Returns the fixture this object is attached to, when its nearest ancestor is a
    /// fixture.
    ///
    /// A fixture nested in another fixture's child list with a `ChildPosition` hangs off a
    /// geometry of the parent's GDTF model (an accessory on a moving head, for example),
    /// so its true position also depends on that geometry and the parent's pan and tilt,
    /// which [`PlacedObject::world`] does not include.
    pub fn parent_fixture(&self) -> Option<&'a Fixture> {
        match self.ancestors.last()? {
            SceneNode::Fixture(fixture) => Some(fixture),
            _ => None,
        }
    }
}

impl Scene {
    /// Returns every object in the scene, depth first in file order, with its world
    /// transform.
    ///
    /// Each world transform composes the layer's matrix, every ancestor's matrix and the
    /// object's own, treating a missing matrix as identity. Unknown node types are skipped
    /// along with anything nested in them.
    pub fn placed_objects(&self) -> Vec<PlacedObject<'_>> {
        self.placed_matching(|_| true)
    }

    /// Returns every fixture in the scene with its world transform, in file order.
    pub fn placed_fixtures(&self) -> Vec<PlacedObject<'_>> {
        self.placed_matching(|node| matches!(node, SceneNode::Fixture(_)))
    }

    /// Walks the whole tree and keeps the objects `keep` accepts, still descending into
    /// the ones it rejects.
    fn placed_matching(&self, keep: fn(&SceneNode) -> bool) -> Vec<PlacedObject<'_>> {
        let mut walk = Walk {
            keep,
            ancestors: Vec::new(),
            placed: Vec::new(),
        };
        for layer in &self.layers.layers {
            let layer_world = layer.matrix.unwrap_or_default();
            for node in &layer.children.nodes {
                walk.visit(node, layer, &layer_world);
            }
        }
        walk.placed
    }
}

/// State of one depth-first walk over the scene tree.
struct Walk<'a> {
    /// Which objects to report.
    keep: fn(&SceneNode) -> bool,
    /// Objects enclosing the one being visited, outermost first.
    ancestors: Vec<&'a SceneNode>,
    /// Objects reported so far.
    placed: Vec<PlacedObject<'a>>,
}

impl<'a> Walk<'a> {
    /// Visits `node` and everything nested in it, composing transforms on the way.
    ///
    /// `parent_world` is the world transform of the node's parent. Unknown node types are
    /// skipped together with their children.
    fn visit(&mut self, node: &'a SceneNode, layer: &'a Layer, parent_world: &Transform) {
        if matches!(node, SceneNode::Other) {
            return;
        }
        let world = parent_world.then(&node.matrix().copied().unwrap_or_default());
        if (self.keep)(node) {
            self.placed.push(PlacedObject {
                node,
                layer,
                ancestors: self.ancestors.clone(),
                world,
            });
        }
        self.ancestors.push(node);
        for child in node.children() {
            self.visit(child, layer, &world);
        }
        self.ancestors.pop();
    }
}
