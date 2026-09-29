// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Types used in the compositor module.
use std::fmt::Display;
use std::time::Duration;

use bevy_ecs::component::Mutable;
use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use moonshine_kind::Any;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;
use web_time::Instant;

/// Marker component to track which object created a layer
#[derive(Clone, Component, Serialize, Deserialize)]
pub struct ObjectRefMarker(pub ObjectRef);

/// Marker component to indicate a layer is being released
#[derive(Clone, Component, SmartDefault)]
pub struct ReleaseMarker {
    /// Time when the release started
    #[default(_code = "Instant::now()")]
    pub start_time: Instant,
}

/// Source-local compositing context for one materialized compositor layer evaluation.
#[derive(Clone, Copy, Component, Debug, Default, PartialEq, Eq)]
pub struct LayerCompositingContext {
    /// Source-local elapsed position for assertion transitions in this layer.
    pub position: Duration,
    /// Source-local playback position where this layer began releasing.
    ///
    /// Transition-owned release anchors on `MaterializedTransition::release_position` are the
    /// canonical timing source for release fade evaluation. This layer-level anchor is retained as
    /// context for layer lifecycle systems and as a compatibility fallback for direct layer
    /// producers that have not stamped every transition with its own release anchor.
    pub released_at: Option<Duration>,
}

impl LayerCompositingContext {
    /// Returns source-local elapsed time since this layer began releasing.
    ///
    /// Prefer transition-owned anchors when evaluating parameter release fades. This helper is for
    /// layer-level lifecycle decisions and fallback contexts where no transition anchor is
    /// available.
    pub fn elapsed_since_release(&self) -> Option<Duration> {
        self.released_at
            .map(|released_at| self.position.saturating_sub(released_at))
    }
}

/// Compositor-facing identity for a fixture parameter.
///
/// The compositor only needs erased Moonshine instance identity for map keys.
/// Fixture crates can convert their typed parameter instances into this value
/// without requiring compositor core types to depend on fixture component
/// definitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ParameterRef(Instance<Any>);

impl ParameterRef {
    /// Create a parameter reference from a Bevy entity.
    pub fn from_entity(entity: Entity) -> Self {
        Self(entity.into())
    }

    /// Create a parameter reference from an erased Moonshine instance.
    pub fn from_any_instance(instance: Instance<Any>) -> Self {
        Self(instance)
    }

    /// Return the Bevy entity backing this parameter reference.
    pub fn entity(self) -> Entity {
        self.0.entity()
    }

    /// Return the erased Moonshine instance backing this reference.
    pub fn any_instance(self) -> Instance<Any> {
        self.0
    }
}

impl<T: Component> From<Instance<T>> for ParameterRef {
    fn from(parameter: Instance<T>) -> Self {
        Self(parameter.cast_into_any())
    }
}

impl<T: Component> From<&Instance<T>> for ParameterRef {
    fn from(parameter: &Instance<T>) -> Self {
        Self(parameter.cast_into_any())
    }
}

impl<T: Component> From<InstanceRef<'_, T>> for ParameterRef {
    fn from(parameter: InstanceRef<'_, T>) -> Self {
        Self(parameter.instance().cast_into_any())
    }
}

impl<T: Component> From<&InstanceRef<'_, T>> for ParameterRef {
    fn from(parameter: &InstanceRef<'_, T>) -> Self {
        Self(parameter.instance().cast_into_any())
    }
}

impl<T: Component> From<InstanceMut<'_, T>> for ParameterRef {
    fn from(parameter: InstanceMut<'_, T>) -> Self {
        Self(parameter.instance().cast_into_any())
    }
}

impl From<ParameterRef> for Entity {
    fn from(parameter: ParameterRef) -> Self {
        parameter.entity()
    }
}

impl From<ParameterRef> for Instance<Any> {
    fn from(parameter: ParameterRef) -> Self {
        parameter.any_instance()
    }
}

impl From<&ParameterRef> for ParameterRef {
    fn from(parameter: &ParameterRef) -> Self {
        *parameter
    }
}

/// Parameter behavior required by compositor math.
///
/// Implementations live with the component that owns parameter metadata and
/// state. The compositor only depends on this contract and `ParameterRef`
/// identity, not on fixture storage or fixture parameter component types.
pub trait CompositorParameter: Component<Mutability = Mutable> + Clone {
    /// Attribute controlled by this parameter.
    fn attribute(&self) -> &Attribute;

    /// Compositing behavior of this parameter, which does not depend on its current value.
    fn compositing_traits(&self) -> ParameterTraits;

    /// Current effective value in the parameter's logical range.
    fn current_value(&self) -> ParameterDmxValue;

    /// Set the current effective value used by compositor math.
    fn set_raw_value(&mut self, value: ParameterDmxValue);
}

/// Maps an absolute percentage onto a parameter's logical range.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AbsolutePercentScale {
    /// Minimum logical value, reached at 0% (unsigned) or -100% (signed).
    pub min: ParameterDmxValue,
    /// Width of the logical range.
    pub range: ParameterDmxValue,
    /// Whether percentages span -100% to 100% around the range's midpoint instead of 0% to 100%.
    pub signed: bool,
}

impl AbsolutePercentScale {
    /// Converts an absolute percentage into a logical value, clamping it to the scale's span.
    pub fn value(&self, percent: Percentage) -> ParameterDmxValue {
        if self.signed {
            let percent = percent.clamp((-1.0).into(), 1.0.into()).as_f32();
            self.min + self.range * ((percent + 1.0) / 2.0)
        } else {
            let percent = percent.clamp(0.0.into(), 1.0.into());
            self.min + self.range * percent.as_f32()
        }
    }
}

/// Compositing behavior of one parameter: everything the compositor reads from it besides its
/// current value.
///
/// It is small and `Copy` so a compositor pass can snapshot every parameter once and read the
/// snapshot per assertion, instead of fetching the full parameter component for each layer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParameterTraits {
    /// Value the parameter rests at when nothing asserts it.
    pub default_value: ParameterDmxValue,
    /// Minimum logical value, which releasing virtual intensities fade toward.
    pub logical_min: ParameterDmxValue,
    /// Whether same-priority layers merge highest-takes-precedence.
    pub uses_htp_merge: bool,
    /// Whether the parameter is a virtual intensity, which keeps asserting while it releases.
    pub is_virtual_intensity: bool,
    /// Conversion for absolute percentage values.
    pub absolute_percent: AbsolutePercentScale,
    /// Logical value per 100% of a relative percentage offset.
    pub relative_percent_range: ParameterDmxValue,
}

impl ParameterTraits {
    /// Resolves an asserted value against an explicit current value, such as the value composited
    /// below the asserting layer.
    pub fn resolve_value_with_current(
        &self,
        value: &ParameterValue,
        current_value: ParameterDmxValue,
    ) -> ParameterDmxValue {
        match value {
            ParameterValue::Absolute { value } => *value,
            ParameterValue::AbsolutePercent { value } => self.absolute_percent.value(*value),
            ParameterValue::Relative { offset } => current_value + *offset,
            ParameterValue::RelativePercent { offset } => {
                current_value + self.relative_percent_range * offset.as_f32()
            }
        }
    }
}

/// Source of parameter compositing traits for compositor stages.
///
/// A parameter query reads each parameter's component on every lookup, while a
/// [`ParameterTraitsTable`] answers from a snapshot taken once per compositor pass.
pub trait ParameterLookup {
    /// Returns the compositing traits of a parameter, or `None` when it does not exist.
    fn parameter_traits(&self, parameter: ParameterRef) -> Option<ParameterTraits>;

    /// Returns the attribute of a parameter for trace output.
    fn parameter_attribute(&self, parameter: ParameterRef) -> Option<Attribute>;
}

impl<P: CompositorParameter> ParameterLookup for Query<'_, '_, InstanceMut<'_, P>> {
    /// Reads the traits from the parameter's component.
    fn parameter_traits(&self, parameter: ParameterRef) -> Option<ParameterTraits> {
        self.get(parameter.entity())
            .ok()
            .map(|parameter| parameter.compositing_traits())
    }

    /// Reads the attribute from the parameter's component.
    fn parameter_attribute(&self, parameter: ParameterRef) -> Option<Attribute> {
        self.get(parameter.entity())
            .ok()
            .map(|parameter| parameter.attribute().clone())
    }
}

/// Compositing traits of every parameter, snapshotted from a parameter query once per compositor
/// pass.
pub struct ParameterTraitsTable<'q, 'w, 's, 'a, P: CompositorParameter> {
    /// Traits keyed by parameter.
    traits: ParameterMap<ParameterTraits>,
    /// Query the snapshot was taken from, used only for trace output.
    parameters: &'q Query<'w, 's, InstanceMut<'a, P>>,
}

impl<'q, 'w, 's, 'a, P: CompositorParameter> ParameterTraitsTable<'q, 'w, 's, 'a, P> {
    /// Snapshots the traits of every parameter in the query.
    pub fn new(parameters: &'q Query<'w, 's, InstanceMut<'a, P>>) -> Self {
        let mut traits = ParameterMap::new();
        traits.extend(
            parameters
                .iter()
                .map(|parameter| (parameter.instance(), parameter.compositing_traits())),
        );
        Self { traits, parameters }
    }
}

impl<P: CompositorParameter> ParameterLookup for ParameterTraitsTable<'_, '_, '_, '_, P> {
    /// Reads the traits from the snapshot.
    fn parameter_traits(&self, parameter: ParameterRef) -> Option<ParameterTraits> {
        self.traits.get(parameter).copied()
    }

    /// Reads the attribute from the parameter's component, since trace output is rare.
    fn parameter_attribute(&self, parameter: ParameterRef) -> Option<Attribute> {
        self.parameters.parameter_attribute(parameter)
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Merge behavior for compositor parameter unit tests.
    #[derive(Clone, Copy)]
    pub(crate) enum TestMergeMode {
        /// Highest-takes-priority behavior.
        Htp,
        /// Latest-takes-priority behavior.
        Ltp,
    }

    /// Minimal parameter component for compositor unit tests.
    #[derive(Component, Clone)]
    pub(crate) struct TestParameter {
        /// Attribute controlled by this parameter.
        pub(crate) attribute: Attribute,
        /// Merge behavior used by this parameter.
        pub(crate) merge_mode: TestMergeMode,
        /// Current effective value.
        pub(crate) current_value: ParameterDmxValue,
        /// Default effective value.
        pub(crate) default_value: ParameterDmxValue,
        /// Minimum logical value.
        pub(crate) min: ParameterDmxValue,
        /// Maximum logical value.
        pub(crate) max: ParameterDmxValue,
    }

    impl TestParameter {
        /// Build a test parameter for the given merge behavior and attribute.
        pub(crate) fn new(merge_mode: TestMergeMode, attribute: Attribute) -> Self {
            Self {
                attribute,
                merge_mode,
                current_value: 0.0,
                default_value: 0.0,
                min: 0.0,
                max: 255.0,
            }
        }
    }

    impl CompositorParameter for TestParameter {
        fn attribute(&self) -> &Attribute {
            &self.attribute
        }

        fn compositing_traits(&self) -> ParameterTraits {
            ParameterTraits {
                default_value: self.default_value,
                logical_min: self.min,
                uses_htp_merge: matches!(self.merge_mode, TestMergeMode::Htp),
                is_virtual_intensity: matches!(self.attribute, Attribute::VirtualIntensity),
                absolute_percent: AbsolutePercentScale {
                    min: self.min,
                    range: self.max - self.min,
                    signed: false,
                },
                relative_percent_range: self.max - self.min,
            }
        }

        fn current_value(&self) -> ParameterDmxValue {
            self.current_value
        }

        fn set_raw_value(&mut self, value: ParameterDmxValue) {
            self.current_value = value;
        }
    }
}

/// Map keyed by erased fixture parameter instances.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParameterMap<V>(FxHashMap<Instance<Any>, V>);

impl<V> ParameterMap<V> {
    /// Create an empty parameter map.
    pub fn new() -> Self {
        Self(FxHashMap::default())
    }

    /// Create an empty parameter map with capacity for at least `capacity` entries.
    pub fn with_capacity(capacity: usize) -> Self {
        Self(FxHashMap::with_capacity_and_hasher(
            capacity,
            Default::default(),
        ))
    }

    /// Reserve capacity for at least `additional` more parameter entries.
    pub fn reserve(&mut self, additional: usize) {
        self.0.reserve(additional);
    }

    /// Number of parameter entries.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the map has no parameter entries.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Insert a parameter value, returning the previous value when present.
    pub fn insert<P>(&mut self, parameter: P, value: V) -> Option<V>
    where
        P: Into<ParameterRef>,
    {
        self.0.insert(parameter.into().any_instance(), value)
    }

    /// Return the value for a parameter.
    pub fn get<P>(&self, parameter: P) -> Option<&V>
    where
        P: Into<ParameterRef>,
    {
        self.0.get(&parameter.into().any_instance())
    }

    /// Return the mutable value for a parameter.
    pub fn get_mut<P>(&mut self, parameter: P) -> Option<&mut V>
    where
        P: Into<ParameterRef>,
    {
        self.0.get_mut(&parameter.into().any_instance())
    }

    /// Whether the map contains a parameter.
    pub fn contains_key<P>(&self, parameter: P) -> bool
    where
        P: Into<ParameterRef>,
    {
        self.0.contains_key(&parameter.into().any_instance())
    }

    /// Remove a parameter value.
    pub fn remove<P>(&mut self, parameter: P) -> Option<V>
    where
        P: Into<ParameterRef>,
    {
        self.0.remove(&parameter.into().any_instance())
    }

    /// Iterate over parameter keys.
    pub fn keys(&self) -> impl Iterator<Item = ParameterRef> + '_ {
        self.0
            .keys()
            .map(|instance| ParameterRef::from_any_instance(*instance))
    }

    /// Iterate over parameter values.
    pub fn values(&self) -> impl Iterator<Item = &V> + '_ {
        self.0.values()
    }

    /// Iterate over mutable parameter values.
    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> + '_ {
        self.0.values_mut()
    }

    /// Iterate over parameter-value pairs.
    pub fn iter(&self) -> impl Iterator<Item = (ParameterRef, &V)> + '_ {
        self.0
            .iter()
            .map(|(instance, value)| (ParameterRef::from_any_instance(*instance), value))
    }

    /// Iterate over mutable parameter-value pairs.
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (ParameterRef, &mut V)> + '_ {
        self.0
            .iter_mut()
            .map(|(instance, value)| (ParameterRef::from_any_instance(*instance), value))
    }

    /// Extend this map with another parameter map.
    pub fn extend_map(&mut self, other: Self) {
        self.0.extend(other.0);
    }
}

impl<V> Default for ParameterMap<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V, P> Extend<(P, V)> for ParameterMap<V>
where
    P: Into<ParameterRef>,
{
    fn extend<T: IntoIterator<Item = (P, V)>>(&mut self, iter: T) {
        self.0.extend(
            iter.into_iter()
                .map(|(parameter, value)| (parameter.into().any_instance(), value)),
        );
    }
}

/// A layer that has its transitions and relative offsets computed on top of its base layer
#[derive(Component, Default, Debug, Clone, PartialEq)]
pub struct ComputedLayer {
    /// Absolute parameter values
    pub absolute: ParameterMap<ParameterDmxValue>,
    /// Relative parameter values
    pub relative: ParameterMap<ParameterDmxValue>,
}

impl Display for ComputedLayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Computed layer containing {} absolute and {} relative items:",
            self.absolute.len(),
            self.relative.len()
        )
    }
}

impl ComputedLayer {
    /// Create an empty computed layer with map capacity hints.
    pub fn with_capacity(absolute_capacity: usize, relative_capacity: usize) -> Self {
        Self {
            absolute: ParameterMap::with_capacity(absolute_capacity),
            relative: ParameterMap::with_capacity(relative_capacity),
        }
    }

    /// Get the final computed value for a parameter by combining absolute and relative values
    pub fn get_effective_value<P>(&self, param: P) -> ParameterDmxValue
    where
        P: Into<ParameterRef>,
    {
        let param = param.into();
        let absolute = self.absolute.get(param).unwrap_or(&0.0);
        let relative = self.relative.get(param).unwrap_or(&0.0);

        if self.absolute.contains_key(param) || self.relative.contains_key(param) {
            *absolute + *relative
        } else {
            *absolute
        }
    }

    /// Get all parameters that have values (absolute or relative)
    pub fn all_parameters(&self) -> impl Iterator<Item = ParameterRef> {
        let mut all_params: std::collections::HashSet<_> = self.absolute.keys().collect();
        all_params.extend(self.relative.keys());
        all_params.into_iter()
    }

    /// Convert to effective values (absolute + relative)
    pub fn to_effective(&self) -> Self {
        let mut effective = self.clone();
        effective.relative.iter().for_each(|(param, value)| {
            let absolute = self.absolute.get(param).unwrap_or(&0.0);
            effective.absolute.insert(param, *absolute + *value);
        });
        effective
    }
}

/// Type alias for mapping parameter instances to their owning object, value, and transitions.
pub type ParameterOwnershipMap =
    ParameterMap<(ObjectRef, (ParameterValue, Option<MaterializedTransition>))>;

/// A layer of parameter assertions with attribution for the object that set each value.
#[derive(Component, Default, Debug, Clone, PartialEq)]
pub struct AttributedAssertionsLayer {
    /// Absolute parameter values with ownership tracking
    pub absolute: ParameterOwnershipMap,
    /// Relative parameter values with ownership tracking
    pub relative: ParameterOwnershipMap,
}

impl Display for AttributedAssertionsLayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(
            f,
            "Attributed assertions layer containing {} absolute and {} relative items:",
            self.absolute.len(),
            self.relative.len()
        )
    }
}

impl AttributedAssertionsLayer {
    /// Create an empty attributed assertions layer with map capacity hints.
    pub fn with_capacity(absolute_capacity: usize, relative_capacity: usize) -> Self {
        Self {
            absolute: ParameterMap::with_capacity(absolute_capacity),
            relative: ParameterMap::with_capacity(relative_capacity),
        }
    }
}

/// Resource to hold the final attributed assertions layer for the current frame.
#[derive(Resource, Default, Debug, Clone)]
pub struct FinalLayerAttributedAssertions(pub AttributedAssertionsLayer);

/// Resource to hold the computed output values from the most recent compositor pass.
#[derive(Resource, Default, Debug, Clone, PartialEq)]
pub struct FinalLayerOutput(pub ComputedLayer);

/// Component to store the computed layer for a layer's composited output
#[derive(Component, Default, Debug, Clone)]
pub struct OutputLayer(pub ComputedLayer);

/// Layers the values for parameters that should be composited, after entity
/// materialization. This means that transitions, fades, and delays need to be
/// processed before parameters are inserted into a layer.
///
/// Higher priority layers are merged last.
#[derive(Component, Debug, Clone, PartialEq)]
pub struct Layer {
    /// Creator object reference (for debugging)
    pub creator: String,
    /// Priority of the layer (higher priority layers are merged last)
    pub priority: Priority,
    /// Time when this layer was activated (used for sorting layers with equal priority)
    pub activation_time: Instant,
    /// Relative parameter values with optional transitions
    pub relative: ParameterMap<(ParameterValue, Option<MaterializedTransition>)>,
    /// Absolute parameter values with optional transitions
    pub absolute: ParameterMap<(ParameterValue, Option<MaterializedTransition>)>,
    /// Parameter values that are still transitioning after layer-internal preprocessing.
    pub transitioning: ParameterMap<bool>,
}

impl Layer {
    /// Create a new layer with the given creator and priority
    pub fn new(creator: String, priority: Priority) -> Self {
        Self {
            creator,
            priority,
            activation_time: Instant::now(),
            relative: Default::default(),
            absolute: Default::default(),
            transitioning: Default::default(),
        }
    }

    /// Create a new layer with map capacity hints for authored parameter values.
    pub fn with_capacity(
        creator: String,
        priority: Priority,
        absolute_capacity: usize,
        relative_capacity: usize,
    ) -> Self {
        Self {
            creator,
            priority,
            activation_time: Instant::now(),
            relative: ParameterMap::with_capacity(relative_capacity),
            absolute: ParameterMap::with_capacity(absolute_capacity),
            transitioning: ParameterMap::with_capacity(absolute_capacity + relative_capacity),
        }
    }

    /// Merges another layer onto existing values, overriding existing parameters.
    pub fn squash(&mut self, upper_layer: Layer) {
        self.absolute.reserve(upper_layer.absolute.len());
        self.relative.reserve(upper_layer.relative.len());
        self.transitioning.reserve(upper_layer.transitioning.len());
        self.absolute.extend_map(upper_layer.absolute);
        self.relative.extend_map(upper_layer.relative);
        self.transitioning.extend_map(upper_layer.transitioning);
    }

    /// Returns whether any parameter assertion in this layer has transition timing.
    pub fn has_transitions(&self) -> bool {
        self.absolute
            .iter()
            .any(|(_, (_, transition))| transition.is_some())
            || self
                .relative
                .iter()
                .any(|(_, (_, transition))| transition.is_some())
    }
}

impl Display for Layer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Layer for {} with priority {} containing {} absolute and {} relative items",
            self.creator.clone(),
            self.priority,
            self.absolute.len(),
            self.relative.len()
        )
    }
}
