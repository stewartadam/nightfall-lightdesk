// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resolution of a GDTF DMX mode into geometry instances and placed channels.
//!
//! A DMX mode names one root geometry. Only geometry reachable from that root
//! exists in the mode. `GeometryReference` nodes instantiate a top-level
//! template geometry at their own position; the channels a mode declares on
//! the template are repeated once per reference, shifted by the reference's
//! `Break` offsets. Every later conversion step (parameters, elements,
//! geometry tree, beam bindings) reads from the single [`ResolvedMode`]
//! produced here instead of re-walking the XML.

use std::collections::HashMap;

use gdtf::dmx_mode::{DmxBreak, DmxChannel, DmxMode};
use gdtf::fixture_type::FixtureType;
use gdtf::geometry::{AnyGeometry, Geometry, ReferenceGeometry};

/// Maximum nesting depth of geometries, including reference expansion.
pub const MAX_GEOMETRY_DEPTH: usize = 32;
/// Maximum number of geometry instances a mode may expand to.
pub const MAX_GEOMETRY_INSTANCES: usize = 20_000;

/// A problem found while resolving a mode that does not prevent conversion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GdtfDiagnostic {
    /// The mode's root geometry is not a top-level geometry; the first top-level geometry was used.
    MissingModeRoot {
        /// Root geometry named by the mode.
        root: String,
    },
    /// A geometry reference points at a geometry that does not exist.
    DanglingReference {
        /// Reference geometry name.
        reference: String,
        /// Missing target name.
        target: String,
    },
    /// A reference chain refers back to one of its own ancestors.
    ReferenceCycle {
        /// Reference geometry name where the cycle was detected.
        reference: String,
    },
    /// Expansion exceeded [`MAX_GEOMETRY_DEPTH`] or [`MAX_GEOMETRY_INSTANCES`] and was truncated.
    ExpansionLimit,
    /// A channel names a geometry that is not reachable from the mode root.
    UnreachableChannel {
        /// Channel geometry name.
        geometry: String,
    },
    /// A referenced channel's DMX break has no matching `Break` on the reference.
    MissingReferenceBreak {
        /// Reference geometry name.
        reference: String,
        /// Break number the channel uses.
        dmx_break: i32,
    },
    /// Two geometries in one tree share a name; later ones were renamed and do not bind channels.
    DuplicateGeometryName {
        /// Repeated geometry name.
        name: String,
    },
    /// A channel's slots cannot be represented (more than four bytes or outside one universe); it was dropped.
    UnrepresentableChannel {
        /// Instance the channel names.
        instance: String,
        /// Resolved 1-based slots.
        offsets: Vec<i64>,
    },
    /// A channel reuses slots of an earlier channel; it was kept as a virtual (non-output) parameter.
    SharedSlots {
        /// Instance of the later channel.
        instance: String,
        /// Shared 1-based slots.
        offsets: Vec<u16>,
    },
}

/// Break offsets supplied by one geometry reference.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReferenceScope {
    /// Name of the `GeometryReference` node.
    name: String,
    /// `(DMXBreak, DMXOffset)` pairs in file order.
    breaks: Vec<(u16, u32)>,
    /// Index of the enclosing scope, for nested references.
    parent: Option<usize>,
}

/// One concrete geometry node of a resolved mode.
#[derive(Debug, Clone)]
pub struct GeometryInstance<'a> {
    /// Unique instance name. Nodes outside references keep their geometry
    /// name; a referenced template root takes the reference's name and its
    /// descendants are prefixed with it (`"Pixel 2/Lens"`).
    pub name: String,
    /// Geometry definition this node instantiates.
    pub geometry: &'a Geometry,
    /// Local transform source: the reference node for template roots, otherwise `geometry`.
    pub placement: &'a Geometry,
    /// Model name, with a reference's model overriding the template's.
    pub model: Option<&'a str>,
    /// Parent instance index.
    pub parent: Option<usize>,
    /// Child instance indices in file order.
    pub children: Vec<usize>,
    /// Innermost reference scope this instance belongs to.
    scope: Option<usize>,
    /// Whether an earlier instance already had this name; duplicates bind no channels.
    duplicate: bool,
}

impl GeometryInstance<'_> {
    /// Returns the name of the geometry definition this node instantiates.
    pub fn geometry_name(&self) -> &str {
        self.geometry.name().map(|name| name.as_ref()).unwrap_or("")
    }
}

/// A DMX channel bound to one geometry instance with absolute footprint slots.
#[derive(Debug, Clone)]
pub struct ResolvedChannel<'a> {
    /// Source channel definition.
    pub channel: &'a DmxChannel,
    /// Index of the geometry instance the channel controls.
    pub instance: usize,
    /// DMX break after applying reference overrides.
    pub dmx_break: u16,
    /// 1-based footprint slots, most significant first; `None` for virtual channels.
    pub offsets: Option<Vec<i64>>,
}

/// A DMX mode resolved against its fixture type.
#[derive(Debug, Clone)]
pub struct ResolvedMode<'a> {
    /// Geometry instances in depth-first order; index 0 is the mode root.
    pub instances: Vec<GeometryInstance<'a>>,
    /// Channels in file order, each repeated per instance of its geometry.
    pub channels: Vec<ResolvedChannel<'a>>,
    /// Non-fatal problems found while resolving.
    pub diagnostics: Vec<GdtfDiagnostic>,
    scopes: Vec<ReferenceScope>,
}

impl<'a> ResolvedMode<'a> {
    /// Resolves `mode` of `fixture_type`, or returns `None` when the fixture type has no geometry.
    pub fn new(fixture_type: &'a FixtureType, mode: &'a DmxMode) -> Option<Self> {
        let mut resolved = Self {
            instances: Vec::new(),
            channels: Vec::new(),
            diagnostics: Vec::new(),
            scopes: Vec::new(),
        };

        let root_name = mode.geometry.as_ref().map(|name| name.to_string());
        let root = match root_name
            .as_deref()
            .and_then(|name| fixture_type.root_geometry(name))
        {
            Some(root) => root,
            None => {
                let fallback = fixture_type.geometries.first()?;
                if let Some(root) = root_name {
                    resolved
                        .diagnostics
                        .push(GdtfDiagnostic::MissingModeRoot { root });
                }
                fallback
            }
        };

        let mut active_templates = Vec::new();
        resolved.expand(
            fixture_type,
            root,
            root,
            None,
            None,
            None,
            0,
            &mut active_templates,
        );
        if resolved.instances.is_empty() {
            return None;
        }
        resolved.resolve_channels(mode);
        Some(resolved)
    }

    /// Adds an instance for `geometry` and its descendants, expanding references.
    #[allow(clippy::too_many_arguments)]
    fn expand(
        &mut self,
        fixture_type: &'a FixtureType,
        geometry: &'a Geometry,
        placement: &'a Geometry,
        name_override: Option<String>,
        parent: Option<usize>,
        scope: Option<usize>,
        depth: usize,
        active_templates: &mut Vec<&'a str>,
    ) -> Option<usize> {
        if depth >= MAX_GEOMETRY_DEPTH || self.instances.len() >= MAX_GEOMETRY_INSTANCES {
            if !self.diagnostics.contains(&GdtfDiagnostic::ExpansionLimit) {
                self.diagnostics.push(GdtfDiagnostic::ExpansionLimit);
            }
            return None;
        }

        if let Geometry::Reference(reference) = geometry {
            return self.expand_reference(
                fixture_type,
                reference,
                geometry,
                parent,
                scope,
                depth,
                active_templates,
            );
        }

        let geometry_name = geometry
            .name()
            .map(|name| name.to_string())
            .unwrap_or_default();
        let mut name = name_override.unwrap_or_else(|| match scope {
            Some(scope) => format!("{}/{geometry_name}", self.scopes[scope].name),
            None => geometry_name,
        });
        let duplicate = self.instances.iter().any(|instance| instance.name == name);
        if duplicate {
            let diagnostic = GdtfDiagnostic::DuplicateGeometryName { name: name.clone() };
            if !self.diagnostics.contains(&diagnostic) {
                self.diagnostics.push(diagnostic);
            }
            let base = name.clone();
            let mut suffix = 2;
            while self.instances.iter().any(|instance| instance.name == name) {
                name = format!("{base} #{suffix}");
                suffix += 1;
            }
        }
        let model = placement
            .model_name()
            .or_else(|| geometry.model_name())
            .map(|model| model.as_ref());

        let index = self.instances.len();
        self.instances.push(GeometryInstance {
            name,
            geometry,
            placement,
            model,
            parent,
            children: Vec::new(),
            scope,
            duplicate,
        });
        if let Some(parent) = parent {
            self.instances[parent].children.push(index);
        }

        for child in geometry.children() {
            self.expand(
                fixture_type,
                child,
                child,
                None,
                Some(index),
                scope,
                depth + 1,
                active_templates,
            );
        }
        Some(index)
    }

    /// Instantiates a reference's template geometry at the reference's position.
    #[allow(clippy::too_many_arguments)]
    fn expand_reference(
        &mut self,
        fixture_type: &'a FixtureType,
        reference: &'a ReferenceGeometry,
        placement: &'a Geometry,
        parent: Option<usize>,
        scope: Option<usize>,
        depth: usize,
        active_templates: &mut Vec<&'a str>,
    ) -> Option<usize> {
        let reference_name = reference
            .name
            .as_ref()
            .map(|name| name.to_string())
            .unwrap_or_default();
        let target_name = reference
            .geometry
            .as_ref()
            .map(|name| name.as_ref())
            .unwrap_or("");
        let Some(template) = fixture_type.root_geometry(target_name) else {
            self.diagnostics.push(GdtfDiagnostic::DanglingReference {
                reference: reference_name,
                target: target_name.to_string(),
            });
            return None;
        };
        if active_templates.contains(&target_name) {
            self.diagnostics.push(GdtfDiagnostic::ReferenceCycle {
                reference: reference_name,
            });
            return None;
        }

        let instance_name = match scope {
            Some(scope) => format!("{}/{reference_name}", self.scopes[scope].name),
            None => reference_name,
        };
        self.scopes.push(ReferenceScope {
            name: instance_name.clone(),
            breaks: reference
                .breaks
                .iter()
                .map(|entry| (entry.dmx_break as u16, entry.dmx_offset.absolute()))
                .collect(),
            parent: scope,
        });
        let new_scope = self.scopes.len() - 1;

        active_templates.push(target_name);
        let index = self.expand(
            fixture_type,
            template,
            placement,
            Some(instance_name),
            parent,
            Some(new_scope),
            depth,
            active_templates,
        );
        active_templates.pop();
        index
    }

    /// Binds every mode channel to the instances of its geometry and applies reference offsets.
    fn resolve_channels(&mut self, mode: &'a DmxMode) {
        let mut by_geometry: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, instance) in self.instances.iter().enumerate() {
            if instance.duplicate {
                continue;
            }
            by_geometry
                .entry(instance.geometry_name().to_string())
                .or_default()
                .push(index);
        }

        for channel in &mode.dmx_channels {
            let geometry = channel.geometry.as_ref();
            let Some(instances) = by_geometry.get(geometry) else {
                self.diagnostics.push(GdtfDiagnostic::UnreachableChannel {
                    geometry: geometry.to_string(),
                });
                continue;
            };
            for &instance in instances {
                let (dmx_break, shift) =
                    self.break_and_shift(channel, self.instances[instance].scope);
                let offsets = channel.offset.as_ref().map(|offsets| {
                    offsets
                        .iter()
                        .map(|offset| *offset as i64 + shift)
                        .collect()
                });
                self.channels.push(ResolvedChannel {
                    channel,
                    instance,
                    dmx_break,
                    offsets,
                });
            }
        }
    }

    /// Returns the effective break and the cumulative slot shift for a channel in a reference scope.
    ///
    /// A fixed break uses the reference `Break` with the same number; an
    /// `Overwrite` break takes both break and offset from the reference's
    /// last `Break`. Nested references add their shifts.
    fn break_and_shift(&mut self, channel: &DmxChannel, scope: Option<usize>) -> (u16, i64) {
        let mut dmx_break = match channel.dmx_break {
            DmxBreak::Value(value) => value.clamp(1, u16::MAX as i32) as u16,
            DmxBreak::Overwrite => 1,
        };
        let mut overwrite = channel.dmx_break == DmxBreak::Overwrite;
        let mut shift = 0i64;
        let mut current = scope;
        while let Some(scope_index) = current {
            let scope = &self.scopes[scope_index];
            let entry = if overwrite {
                scope.breaks.last().copied()
            } else {
                scope
                    .breaks
                    .iter()
                    .find(|(number, _)| *number == dmx_break)
                    .copied()
            };
            match entry {
                Some((number, offset)) => {
                    dmx_break = number.max(1);
                    shift += offset as i64 - 1;
                }
                None => {
                    let diagnostic = GdtfDiagnostic::MissingReferenceBreak {
                        reference: scope.name.clone(),
                        dmx_break: dmx_break as i32,
                    };
                    if !self.diagnostics.contains(&diagnostic) {
                        self.diagnostics.push(diagnostic);
                    }
                }
            }
            overwrite = false;
            current = scope.parent;
        }
        (dmx_break, shift)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{
        BreakSpec, ChannelSpec, GdtfBuilder, GeometrySpec, ModeSpec, translation,
    };

    /// Builds a bar whose pixels are three references to one template beam.
    fn pixel_bar() -> GdtfBuilder {
        GdtfBuilder::new("Test", "Bar")
            .geometry(
                GeometrySpec::generic("Body")
                    .child(GeometrySpec::reference("Pixel 1", "Pixel", &[(1, 2)]))
                    .child(
                        GeometrySpec::reference("Pixel 2", "Pixel", &[(1, 5)])
                            .at(translation(0.1, 0.0, 0.0)),
                    )
                    .child(
                        GeometrySpec::reference("Pixel 3", "Pixel", &[(1, 8)])
                            .at(translation(0.2, 0.0, 0.0)),
                    ),
            )
            .geometry(GeometrySpec::beam("Pixel").child(GeometrySpec::generic("Lens")))
            .geometry(GeometrySpec::generic("Unused Root"))
            .mode(
                ModeSpec::new("Pixels", "Body")
                    .channel(ChannelSpec::new("Body", "Dimmer", &[1]))
                    .channel(
                        ChannelSpec::new("Pixel", "ColorAdd_R", &[1])
                            .on_break(BreakSpec::Overwrite),
                    )
                    .channel(
                        ChannelSpec::new("Pixel", "ColorAdd_G", &[2])
                            .on_break(BreakSpec::Overwrite),
                    )
                    .channel(
                        ChannelSpec::new("Pixel", "ColorAdd_B", &[3])
                            .on_break(BreakSpec::Overwrite),
                    )
                    .channel(ChannelSpec::new("Unused Root", "Zoom", &[20])),
            )
    }

    /// Verifies only the mode root is instantiated and references expand the template per instance.
    #[test]
    fn expands_references_from_mode_root_only() {
        let gdtf = pixel_bar().parse();
        let fixture_type = &gdtf.description.fixture_types[0];
        let resolved = ResolvedMode::new(fixture_type, &fixture_type.dmx_modes[0]).unwrap();

        let names: Vec<&str> = resolved.instances.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Body",
                "Pixel 1",
                "Pixel 1/Lens",
                "Pixel 2",
                "Pixel 2/Lens",
                "Pixel 3",
                "Pixel 3/Lens"
            ]
        );
        assert_eq!(resolved.instances[3].parent, Some(0));
        assert!(matches!(
            resolved.instances[3].placement,
            Geometry::Reference(_)
        ));
        assert_eq!(
            resolved.diagnostics,
            vec![GdtfDiagnostic::UnreachableChannel {
                geometry: "Unused Root".to_string()
            }]
        );
    }

    /// Verifies template channels repeat per reference with the reference's break offset applied.
    #[test]
    fn applies_reference_break_offsets() {
        let gdtf = pixel_bar().parse();
        let fixture_type = &gdtf.description.fixture_types[0];
        let resolved = ResolvedMode::new(fixture_type, &fixture_type.dmx_modes[0]).unwrap();

        let placed: Vec<(&str, Vec<i64>)> = resolved
            .channels
            .iter()
            .map(|channel| {
                (
                    resolved.instances[channel.instance].name.as_str(),
                    channel.offsets.clone().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            placed,
            [
                ("Body", vec![1]),
                ("Pixel 1", vec![2]),
                ("Pixel 2", vec![5]),
                ("Pixel 3", vec![8]),
                ("Pixel 1", vec![3]),
                ("Pixel 2", vec![6]),
                ("Pixel 3", vec![9]),
                ("Pixel 1", vec![4]),
                ("Pixel 2", vec![7]),
                ("Pixel 3", vec![10]),
            ]
        );
    }

    /// Verifies a mode rooted at a different top-level geometry sees only that tree.
    #[test]
    fn selects_mode_specific_root() {
        let gdtf = pixel_bar()
            .mode(
                ModeSpec::new("Other", "Unused Root").channel(ChannelSpec::new(
                    "Unused Root",
                    "Zoom",
                    &[1],
                )),
            )
            .parse();
        let fixture_type = &gdtf.description.fixture_types[0];
        let resolved = ResolvedMode::new(fixture_type, &fixture_type.dmx_modes[1]).unwrap();
        assert_eq!(resolved.instances.len(), 1);
        assert_eq!(resolved.instances[0].name, "Unused Root");
        assert!(resolved.diagnostics.is_empty());
    }

    /// Verifies self-referencing templates are reported instead of recursing forever.
    #[test]
    fn reports_reference_cycles() {
        let gdtf = GdtfBuilder::new("Test", "Cycle")
            .geometry(GeometrySpec::generic("Body").child(GeometrySpec::reference(
                "A",
                "Loop",
                &[(1, 1)],
            )))
            .geometry(GeometrySpec::generic("Loop").child(GeometrySpec::reference(
                "B",
                "Loop",
                &[(1, 1)],
            )))
            .mode(ModeSpec::new("Mode", "Body"))
            .parse();
        let fixture_type = &gdtf.description.fixture_types[0];
        let resolved = ResolvedMode::new(fixture_type, &fixture_type.dmx_modes[0]).unwrap();
        assert_eq!(resolved.instances.len(), 2);
        assert_eq!(
            resolved.diagnostics,
            vec![GdtfDiagnostic::ReferenceCycle {
                reference: "B".to_string()
            }]
        );
    }

    /// Verifies dangling references are reported and skipped.
    #[test]
    fn reports_dangling_references() {
        let gdtf = GdtfBuilder::new("Test", "Dangling")
            .geometry(GeometrySpec::generic("Body").child(GeometrySpec::reference(
                "A",
                "Missing",
                &[],
            )))
            .mode(ModeSpec::new("Mode", "Body"))
            .parse();
        let fixture_type = &gdtf.description.fixture_types[0];
        let resolved = ResolvedMode::new(fixture_type, &fixture_type.dmx_modes[0]).unwrap();
        assert_eq!(resolved.instances.len(), 1);
        assert!(matches!(
            resolved.diagnostics[0],
            GdtfDiagnostic::DanglingReference { .. }
        ));
    }

    /// Verifies nested references accumulate their break offsets.
    #[test]
    fn nested_references_accumulate_offsets() {
        let gdtf = GdtfBuilder::new("Test", "Nested")
            .geometry(
                GeometrySpec::generic("Body")
                    .child(GeometrySpec::reference("Row 1", "Row", &[(1, 1)]))
                    .child(GeometrySpec::reference("Row 2", "Row", &[(1, 5)])),
            )
            .geometry(
                GeometrySpec::generic("Row")
                    .child(GeometrySpec::reference("Cell A", "Cell", &[(1, 1)]))
                    .child(GeometrySpec::reference("Cell B", "Cell", &[(1, 3)])),
            )
            .geometry(GeometrySpec::beam("Cell"))
            .mode(ModeSpec::new("Mode", "Body").channel(ChannelSpec::new(
                "Cell",
                "Dimmer",
                &[1, 2],
            )))
            .parse();
        let fixture_type = &gdtf.description.fixture_types[0];
        let resolved = ResolvedMode::new(fixture_type, &fixture_type.dmx_modes[0]).unwrap();
        let placed: Vec<(&str, Vec<i64>)> = resolved
            .channels
            .iter()
            .map(|channel| {
                (
                    resolved.instances[channel.instance].name.as_str(),
                    channel.offsets.clone().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            placed,
            [
                ("Row 1/Cell A", vec![1, 2]),
                ("Row 1/Cell B", vec![3, 4]),
                ("Row 2/Cell A", vec![5, 6]),
                ("Row 2/Cell B", vec![7, 8]),
            ]
        );
    }
}
