// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Types for representing commands
use std::{cmp::Ordering, fmt::Display};

use nightfall_dmx::prelude::Attribute;
use serde::{Deserialize, Serialize};
use strum::EnumString;
use uuid::Uuid;

use crate::{data::FixtureRef, spanned_selection::SpannedSelection};

/// Selection type for programmer
#[derive(Debug, Default, Copy, Clone, PartialEq)]
#[typeshare::typeshare]
pub enum SelectionType {
    #[default]
    Fixture,
    Group,
}

/// Defines valid object types
#[allow(missing_docs)]
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, Hash, EnumString, Serialize, Deserialize)]
#[strum(ascii_case_insensitive)]
#[typeshare::typeshare]
pub enum ObjectType {
    #[default]
    Fixture,
    Fx,
    StepFx,
    FxModule,
    Flow,
    Clip,
    Master,
    Group,
    Parameter,
    Palette,
    Cue,
    Sequence,
    Timecode,
    Timeline,
}

impl Display for ObjectType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ObjectType::Fixture => write!(f, "fixture"),
            ObjectType::Fx => write!(f, "fx"),
            ObjectType::StepFx => write!(f, "step-fx"),
            ObjectType::FxModule => write!(f, "fx-module"),
            ObjectType::Flow => write!(f, "flow"),
            ObjectType::Clip => write!(f, "clip"),
            ObjectType::Master => write!(f, "master"),
            ObjectType::Group => write!(f, "group"),
            ObjectType::Parameter => write!(f, "parameter"),
            ObjectType::Palette => write!(f, "palette"),
            ObjectType::Cue => write!(f, "cue"),
            ObjectType::Sequence => write!(f, "sequence"),
            ObjectType::Timecode => write!(f, "timecode"),
            ObjectType::Timeline => write!(f, "timeline"),
        }
    }
}

/// References to objects by user-facing ID or UUID.
///
/// Numeric IDs are interpreted within the object type. Domains with scoped IDs must reject
/// ambiguous unscoped references; this contract does not imply global numeric uniqueness.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum ObjectRef {
    ById {
        object_type: ObjectType,
        id: u32,
    },
    ByUid {
        object_type: ObjectType,
        #[serde(with = "crate::serde_uuid_simple")]
        uid: Uuid,
    },
}

impl ObjectRef {
    /// Returns the namespace in which this reference must be looked up.
    pub fn object_type(&self) -> ObjectType {
        match self {
            Self::ById { object_type, .. } | Self::ByUid { object_type, .. } => *object_type,
        }
    }
}

/// Persistent identity returned after a reference resolves uniquely in its domain.
///
/// Resolution establishes existence at lookup time, not continued existence or playback support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ObjectIdentity {
    /// Domain namespace that owns the object.
    pub object_type: ObjectType,
    /// Persistent identifier preserved when the object's numeric ID changes.
    #[serde(with = "crate::serde_uuid_simple")]
    pub uid: Uuid,
}

impl From<ObjectIdentity> for ObjectRef {
    /// Creates a UUID reference that can be revalidated against current domain storage.
    fn from(identity: ObjectIdentity) -> Self {
        Self::ByUid {
            object_type: identity.object_type,
            uid: identity.uid,
        }
    }
}

impl Display for ObjectRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ObjectRef::ById { object_type, id } => write!(f, "{}({})", object_type, id),
            ObjectRef::ByUid { object_type, uid } => write!(f, "{}({})", object_type, uid),
        }
    }
}

/// Generic identifier expression for any object type (groups, cues, sequences, macros, etc.)
/// Represents set operations over numeric IDs - resolution happens at usage site with context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum IdExpr {
    /// A single ID
    Single(u32),
    /// A quoted label resolved in the target object namespace.
    Label(String),
    /// A range of IDs (start thru end, inclusive)
    Range {
        /// Start ID
        start: u32,
        /// End ID
        end: u32,
    },
    /// Addition of two expressions
    Add {
        /// Left-hand side of the addition
        lhs: Box<IdExpr>,
        /// Right-hand side of the addition
        rhs: Box<IdExpr>,
    },
    /// Subtraction of two expressions
    Sub {
        /// Left-hand side of the subtraction
        lhs: Box<IdExpr>,
        /// Right-hand side of the subtraction
        rhs: Box<IdExpr>,
    },
    /// Parenthesized expression (preserves span boundaries for effects)
    Span(Box<IdExpr>),
}

impl Default for IdExpr {
    fn default() -> Self {
        IdExpr::Single(0)
    }
}

impl IdExpr {
    /// Expand the expression into a list of IDs (without deduplication).
    pub fn expand(&self) -> Vec<u32> {
        match self {
            IdExpr::Single(id) => vec![*id],
            IdExpr::Label(_) => Vec::new(),
            IdExpr::Range { start, end } => {
                if start <= end {
                    (*start..=*end).collect()
                } else {
                    (*end..=*start).rev().collect()
                }
            }
            IdExpr::Add { lhs, rhs } => {
                let mut out = lhs.expand();
                out.extend(rhs.expand());
                out
            }
            IdExpr::Sub { lhs, rhs } => {
                let mut out = lhs.expand();
                let remove: std::collections::HashSet<_> = rhs.expand().into_iter().collect();
                out.retain(|id| !remove.contains(id));
                out
            }
            IdExpr::Span(inner) => inner.expand(),
        }
    }
}

impl std::fmt::Display for IdExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdExpr::Single(id) => write!(f, "{}", id),
            IdExpr::Label(label) => write!(f, "\"{}\"", label),
            IdExpr::Range { start, end } => write!(f, "{}>{}", start, end),
            IdExpr::Add { lhs, rhs } => write!(f, "{} + {}", lhs, rhs),
            IdExpr::Sub { lhs, rhs } => write!(f, "{} - {}", lhs, rhs),
            IdExpr::Span(inner) => write!(f, "({})", inner),
        }
    }
}

/// Group reference expression with explicit identity semantics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum GroupRefExpr {
    /// Stable reference to a specific group object.
    ByUid {
        #[serde(with = "crate::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        uid: Uuid,
    },
    /// Alias reference to the group currently assigned this user-facing ID.
    ///
    /// Persistence boundaries stabilize resolvable aliases to `ByUid` by default.
    ById(u32),
    /// Alias reference to the group currently matching this label.
    ///
    /// Persistence boundaries stabilize resolvable aliases to `ByUid` by default.
    ByLabel(String),
    /// Inclusive alias range over user-facing group IDs.
    ///
    /// Persistence boundaries expand resolvable members to `ByUid` references by default.
    RangeById {
        /// Start ID.
        start: u32,
        /// End ID.
        end: u32,
    },
    /// Persisted marker for an authored numeric alias that could not be resolved.
    ///
    /// This marker never binds to a group that later acquires the same ID.
    MissingById(u32),
    /// Persisted marker for an authored label alias that could not be resolved.
    ///
    /// This marker never binds to a group that later acquires the same label.
    MissingByLabel(String),
    /// Addition of two group reference expressions.
    Add {
        /// Left-hand side of the addition.
        lhs: Box<GroupRefExpr>,
        /// Right-hand side of the addition.
        rhs: Box<GroupRefExpr>,
    },
    /// Subtraction of two group reference expressions.
    Sub {
        /// Left-hand side of the subtraction.
        lhs: Box<GroupRefExpr>,
        /// Right-hand side of the subtraction.
        rhs: Box<GroupRefExpr>,
    },
    /// Parenthesized expression that preserves span boundaries.
    Span(Box<GroupRefExpr>),
}

impl Default for GroupRefExpr {
    fn default() -> Self {
        Self::ById(0)
    }
}

impl From<IdExpr> for GroupRefExpr {
    fn from(value: IdExpr) -> Self {
        match value {
            IdExpr::Single(id) => Self::ById(id),
            IdExpr::Label(label) => Self::ByLabel(label),
            IdExpr::Range { start, end } => Self::RangeById { start, end },
            IdExpr::Add { lhs, rhs } => Self::Add {
                lhs: Box::new((*lhs).into()),
                rhs: Box::new((*rhs).into()),
            },
            IdExpr::Sub { lhs, rhs } => Self::Sub {
                lhs: Box::new((*lhs).into()),
                rhs: Box::new((*rhs).into()),
            },
            IdExpr::Span(inner) => Self::Span(Box::new((*inner).into())),
        }
    }
}

impl std::fmt::Display for GroupRefExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GroupRefExpr::ByUid { uid } => write!(f, "uid:{}", uid),
            GroupRefExpr::ById(id) => write!(f, "{}", id),
            GroupRefExpr::ByLabel(label) => write!(f, "\"{}\"", label),
            GroupRefExpr::RangeById { start, end } => write!(f, "{}>{}", start, end),
            GroupRefExpr::MissingById(id) => write!(f, "missing-id:{}", id),
            GroupRefExpr::MissingByLabel(label) => write!(f, "missing-label:\"{}\"", label),
            GroupRefExpr::Add { lhs, rhs } => write!(f, "{} + {}", lhs, rhs),
            GroupRefExpr::Sub { lhs, rhs } => write!(f, "{} - {}", lhs, rhs),
            GroupRefExpr::Span(inner) => write!(f, "({})", inner),
        }
    }
}

/// Spatial axis used by selection transforms and visualizer geometry.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum Axis {
    X,
    Y,
    Z,
}

/// Grid dimensions used when projecting a linear selection into rows and columns.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum GridSize {
    Width(u32),
    WidthHeight { x: u32, y: u32 },
}

/// Grouping rule used when inverting a projected spatial selection.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum InvertMode {
    Index,
    Block,
    Group,
    Wing,
}

/// AST representation of a selection (fixtures or groups that resolve to fixtures)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum SelectionExpr {
    /// Reference to fixtures by ID expression
    Fixture(UnresolvedFixtureRef),
    /// Reference to fixtures by ID range
    FixtureRange {
        /// Start fixture reference
        start: UnresolvedFixtureRef,
        /// End fixture reference
        end: UnresolvedFixtureRef,
    },
    /// Map fixture range to element selector (cartesian expansion).
    FixtureMap {
        /// Fixture ID range (inclusive).
        fixtures: FixtureRangeExpr,
        /// Element selector applied to each fixture in the range.
        elements: ElementSelectorExpr,
    },
    /// Reference to groups by explicit identity expression (resolves to fixtures)
    Group(GroupRefExpr),
    /// Addition of two selections
    Add {
        /// Left-hand side of the addition
        lhs: Box<SelectionExpr>,
        /// Right-hand side of the addition
        rhs: Box<SelectionExpr>,
    },
    /// Subtraction of two selections
    Sub {
        /// Left-hand side of the subtraction
        lhs: Box<SelectionExpr>,
        /// Right-hand side of the subtraction
        rhs: Box<SelectionExpr>,
    },
    /// An explicit selection set that preserves span boundaries.
    Span(Box<SelectionExpr>),
    /// A parenthesized spatial selection whose resolved indexes compose as source spans.
    Spatial(Box<SpatialSelection>),
    /// A resolved list of fixtures (for cases where we already have the resolved fixtures)
    Resolved(Vec<FixtureRef>),
}

impl Default for SelectionExpr {
    fn default() -> Self {
        SelectionExpr::Resolved(Default::default())
    }
}

impl SelectionExpr {
    /// Returns true if the selection expression is definitively empty.
    /// Only `Resolved` with an empty vector is considered empty; unresolved
    /// expressions may resolve to fixtures and are not considered empty.
    pub fn is_empty(&self) -> bool {
        matches!(self, SelectionExpr::Resolved(v) if v.is_empty())
    }
}

/// Transform applied to a source selection during spatial selection resolution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum SpatialClause {
    Grid(GridSize),
    Transpose,
    Mirror(Axis),
    RotateLeft,
    RotateRight,
    Split,
    Merge,
    Expand {
        depth: Option<u32>,
    },
    Take(u32),
    Skip(u32),
    Shift {
        axis: Axis,
        amount: i32,
    },
    Blocks {
        axis: Axis,
        amount: u32,
    },
    Group {
        axis: Axis,
        amount: u32,
    },
    Wings {
        axis: Axis,
        amount: u32,
    },
    Shuffle {
        axis: Axis,
        seed: u32,
    },
    Invert {
        mode: InvertMode,
        attrs: Option<Vec<Attribute>>,
    },
}

/// Source selection plus the ordered spatial transforms to apply to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct SpatialSelection {
    /// Source expression resolved before replaying this pipeline's clauses.
    pub source: SelectionExpr,
    /// Ordered transforms applied to the resolved source.
    pub clauses: Vec<SpatialClause>,
    /// Additional spatial pipelines concatenated after this pipeline.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub union: Vec<SpatialSelection>,
}

impl Default for SpatialSelection {
    fn default() -> Self {
        Self::identity(SelectionExpr::default())
    }
}

impl SpatialSelection {
    /// Create a spatial selection pipeline with no union branches.
    pub fn pipeline(source: SelectionExpr, clauses: Vec<SpatialClause>) -> Self {
        Self {
            source,
            clauses,
            union: Vec::new(),
        }
    }

    /// Create an identity spatial selection for a source expression.
    pub fn identity(source: SelectionExpr) -> Self {
        Self::pipeline(source, Vec::new())
    }

    /// Return whether this selection resolves to no source, clauses, or union branches.
    pub fn is_empty(&self) -> bool {
        self.source.is_empty() && self.clauses.is_empty() && self.union.is_empty()
    }
}

impl From<SelectionExpr> for SpatialSelection {
    fn from(source: SelectionExpr) -> Self {
        Self::identity(source)
    }
}

impl std::fmt::Display for SpatialSelection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.source)?;
        for clause in &self.clauses {
            write!(f, " | {clause}")?;
        }
        for branch in &self.union {
            write!(f, " + {branch}")?;
        }
        Ok(())
    }
}

/// Integer coordinate assigned to a fixture while resolving spatial selection clauses.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize, Default)]
#[typeshare::typeshare]
pub struct ProjectedCoord {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// Fixture reference paired with its projected coordinate in a resolved selection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct IndexedFixture {
    pub fixture: FixtureRef,
    pub projected_coord: ProjectedCoord,
}

/// One resolved selection slot, including grouped members produced by projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct SelectionIndex {
    pub index: u32,
    pub invert: bool,
    pub members: Vec<IndexedFixture>,
}

/// Inclusive extents of the projected coordinates occupied by a resolved selection.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ProjectionBounds {
    pub min_x: i32,
    pub max_x: i32,
    pub min_y: i32,
    pub max_y: i32,
    pub min_z: i32,
    pub max_z: i32,
}

impl ProjectionBounds {
    /// Create inclusive projection bounds.
    pub fn new(min_x: i32, max_x: i32, min_y: i32, max_y: i32, min_z: i32, max_z: i32) -> Self {
        Self {
            min_x,
            max_x,
            min_y,
            max_y,
            min_z,
            max_z,
        }
    }

    /// Return the number of projected Y lanes in these bounds.
    pub fn height(&self) -> u32 {
        (self.max_y - self.min_y + 1).max(0) as u32
    }

    /// Return the number of projected Z lanes in these bounds.
    pub fn depth(&self) -> u32 {
        (self.max_z - self.min_z + 1).max(0) as u32
    }
}

/// Fully resolved fixture order with optional spatial projection metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[typeshare::typeshare]
pub struct ResolvedSelection {
    pub canonical: Vec<FixtureRef>,
    pub indexes: Vec<SelectionIndex>,
    pub projection_bounds: Option<ProjectionBounds>,
    pub invert_attrs: Option<Vec<Attribute>>,
}

impl ResolvedSelection {
    /// Create a resolved selection, deriving projection bounds from occupied indexes.
    pub fn new(
        canonical: Vec<FixtureRef>,
        indexes: Vec<SelectionIndex>,
        invert_attrs: Option<Vec<Attribute>>,
    ) -> Self {
        let projection_bounds = projection_bounds_from_indexes(&indexes);
        Self {
            canonical,
            indexes,
            projection_bounds,
            invert_attrs,
        }
    }

    /// Create a resolved selection with explicit projection bounds.
    pub fn with_projection_bounds(
        canonical: Vec<FixtureRef>,
        indexes: Vec<SelectionIndex>,
        projection_bounds: ProjectionBounds,
        invert_attrs: Option<Vec<Attribute>>,
    ) -> Self {
        Self {
            canonical,
            indexes,
            projection_bounds: Some(projection_bounds),
            invert_attrs,
        }
    }

    /// Return the inclusive projection bounds when the resolved selection has cells.
    pub fn projection_bounds(&self) -> Option<ProjectionBounds> {
        self.projection_bounds
    }

    pub fn canonical_fixtures(&self) -> &[FixtureRef] {
        &self.canonical
    }

    pub fn indexes(&self) -> &[SelectionIndex] {
        &self.indexes
    }

    pub fn is_empty(&self) -> bool {
        self.canonical.is_empty() && self.indexes.is_empty()
    }

    pub fn invert_attrs(&self) -> Option<&[Attribute]> {
        self.invert_attrs.as_deref()
    }

    pub fn should_invert_attribute(&self, attribute: &Attribute) -> bool {
        match &self.invert_attrs {
            Some(attrs) => attrs.contains(attribute),
            None => matches!(attribute, Attribute::Pan | Attribute::Tilt),
        }
    }

    pub fn to_spanned_selection(&self) -> SpannedSelection {
        SpannedSelection::from_spans(
            self.indexes
                .iter()
                .filter_map(|index| {
                    let fixtures: Vec<_> = index
                        .members
                        .iter()
                        .map(|member| member.fixture.clone())
                        .collect();
                    (!fixtures.is_empty()).then_some(fixtures)
                })
                .collect(),
        )
    }

    /// Append a resolved spatial branch after this selection while preserving branch layout.
    pub fn append_spatial_branch(&mut self, branch: ResolvedSelection) {
        let target_bounds = self.projection_bounds();
        let branch_bounds = branch.projection_bounds();
        let x_offset = target_bounds
            .map(|bounds| bounds.max_x + 1)
            .unwrap_or_default()
            - branch_bounds.map(|bounds| bounds.min_x).unwrap_or_default();
        let shifted_branch_bounds = branch_bounds.map(|bounds| {
            ProjectionBounds::new(
                bounds.min_x + x_offset,
                bounds.max_x + x_offset,
                bounds.min_y,
                bounds.max_y,
                bounds.min_z,
                bounds.max_z,
            )
        });
        let index_offset = self.indexes.len() as u32;
        let mut appended_indexes = branch
            .indexes
            .into_iter()
            .enumerate()
            .map(|(offset, mut index)| {
                index.index = index_offset + offset as u32;
                for member in &mut index.members {
                    member.projected_coord.x += x_offset;
                }
                index
            })
            .collect::<Vec<_>>();

        self.canonical.extend(branch.canonical);
        self.indexes.append(&mut appended_indexes);
        match (&mut self.invert_attrs, branch.invert_attrs) {
            (Some(target_attrs), Some(branch_attrs)) => {
                for attr in branch_attrs {
                    if !target_attrs.contains(&attr) {
                        target_attrs.push(attr);
                    }
                }
            }
            (None, Some(branch_attrs)) => self.invert_attrs = Some(branch_attrs),
            _ => {}
        }

        *self = ResolvedSelection::new(
            std::mem::take(&mut self.canonical),
            std::mem::take(&mut self.indexes),
            self.invert_attrs.take(),
        );
        if let Some(bounds) = combine_projection_bounds(target_bounds, shifted_branch_bounds) {
            self.projection_bounds = Some(bounds);
        }
    }

    pub fn iter_indexes(&self) -> impl Iterator<Item = &SelectionIndex> {
        self.indexes.iter()
    }

    pub fn iter_non_empty_indexes(&self) -> impl Iterator<Item = &SelectionIndex> {
        self.indexes
            .iter()
            .filter(|index| !index.members.is_empty())
    }
}

/// Derive projection bounds from occupied selection indexes.
fn projection_bounds_from_indexes(indexes: &[SelectionIndex]) -> Option<ProjectionBounds> {
    let mut bounds: Option<ProjectionBounds> = None;

    for indexed_fixture in indexes.iter().flat_map(|index| index.members.iter()) {
        let coord = indexed_fixture.projected_coord;
        bounds = Some(match bounds {
            Some(bounds) => ProjectionBounds::new(
                bounds.min_x.min(coord.x),
                bounds.max_x.max(coord.x),
                bounds.min_y.min(coord.y),
                bounds.max_y.max(coord.y),
                bounds.min_z.min(coord.z),
                bounds.max_z.max(coord.z),
            ),
            None => ProjectionBounds::new(coord.x, coord.x, coord.y, coord.y, coord.z, coord.z),
        });
    }

    bounds
}

/// Combine two optional projection bounds into one inclusive extent.
fn combine_projection_bounds(
    lhs: Option<ProjectionBounds>,
    rhs: Option<ProjectionBounds>,
) -> Option<ProjectionBounds> {
    match (lhs, rhs) {
        (Some(lhs), Some(rhs)) => Some(ProjectionBounds::new(
            lhs.min_x.min(rhs.min_x),
            lhs.max_x.max(rhs.max_x),
            lhs.min_y.min(rhs.min_y),
            lhs.max_y.max(rhs.max_y),
            lhs.min_z.min(rhs.min_z),
            lhs.max_z.max(rhs.max_z),
        )),
        (Some(bounds), None) | (None, Some(bounds)) => Some(bounds),
        (None, None) => None,
    }
}

impl std::fmt::Display for SelectionExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SelectionExpr::Fixture(fixture_ref) => {
                write!(f, "Fixture {}", fixture_ref)
            }
            SelectionExpr::FixtureRange { start, end } => {
                write!(f, "Fixture {}>{}", start, end)
            }
            SelectionExpr::FixtureMap { fixtures, elements } => match elements {
                ElementSelectorExpr::Single(_) => write!(f, "Fixture {}.{}", fixtures, elements),
                ElementSelectorExpr::Range { .. } => {
                    write!(f, "Fixture {}.({})", fixtures, elements)
                }
            },
            SelectionExpr::Group(id_expr) => {
                write!(f, "Group {}", id_expr)
            }
            SelectionExpr::Add { lhs, rhs } => {
                write!(f, "{} + {}", lhs, rhs)
            }
            SelectionExpr::Sub { lhs, rhs } => {
                write!(f, "{} - {}", lhs, rhs)
            }
            SelectionExpr::Span(inner) => write!(f, "{{{}}}", inner),
            SelectionExpr::Spatial(selection) => {
                write!(f, "({})", selection)
            }
            SelectionExpr::Resolved(fixtures) => {
                // For resolved selections, show count since we can't reconstruct the original expression
                if fixtures.is_empty() {
                    Ok(())
                } else if fixtures.len() == 1 {
                    write!(f, "1 fixture")
                } else {
                    write!(f, "{} fixtures", fixtures.len())
                }
            }
        }
    }
}

impl std::fmt::Display for Axis {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let axis = match self {
            Axis::X => "X",
            Axis::Y => "Y",
            Axis::Z => "Z",
        };
        write!(f, "{axis}")
    }
}

impl std::fmt::Display for GridSize {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GridSize::Width(width) => write!(f, "{width}"),
            GridSize::WidthHeight { x, y } => write!(f, "{x}x{y}"),
        }
    }
}

impl std::fmt::Display for InvertMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mode = match self {
            InvertMode::Index => "Index",
            InvertMode::Block => "Block",
            InvertMode::Group => "Group",
            InvertMode::Wing => "Wing",
        };
        write!(f, "{mode}")
    }
}

impl std::fmt::Display for SpatialClause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpatialClause::Grid(size) => write!(f, "Grid {size}"),
            SpatialClause::Transpose => write!(f, "Transpose"),
            SpatialClause::Mirror(axis) => {
                if matches!(axis, Axis::X) {
                    write!(f, "Mirror")
                } else {
                    write!(f, "Mirror {axis}")
                }
            }
            SpatialClause::RotateLeft => write!(f, "Rotate Left"),
            SpatialClause::RotateRight => write!(f, "Rotate Right"),
            SpatialClause::Split => write!(f, "Split"),
            SpatialClause::Merge => write!(f, "Merge"),
            SpatialClause::Expand { depth } => match depth {
                Some(depth) => write!(f, "Expand {depth}"),
                None => write!(f, "Expand"),
            },
            SpatialClause::Take(amount) => write!(f, "Take {amount}"),
            SpatialClause::Skip(amount) => write!(f, "Skip {amount}"),
            SpatialClause::Shift { axis, amount } => {
                format_axis_assignment_clause(f, "Shift", *axis, amount)
            }
            SpatialClause::Blocks { axis, amount } => {
                format_axis_assignment_clause(f, "Blocks", *axis, amount)
            }
            SpatialClause::Group { axis, amount } => {
                format_axis_assignment_clause(f, "Group", *axis, amount)
            }
            SpatialClause::Wings { axis, amount } => {
                format_axis_assignment_clause(f, "Wings", *axis, amount)
            }
            SpatialClause::Shuffle { axis, seed } => {
                format_axis_assignment_clause(f, "Shuffle", *axis, seed)
            }
            SpatialClause::Invert { mode, attrs } => {
                write!(f, "Invert {mode}")?;
                if let Some(attrs) = attrs {
                    write!(f, " Attrs {}", format_attribute_list(attrs))?;
                }
                Ok(())
            }
        }
    }
}

fn format_axis_assignment_clause(
    f: &mut std::fmt::Formatter<'_>,
    keyword: &str,
    axis: Axis,
    value: impl std::fmt::Display,
) -> std::fmt::Result {
    if matches!(axis, Axis::X) {
        write!(f, "{keyword} {value}")
    } else {
        write!(f, "{keyword} {axis}={value}")
    }
}

fn format_attribute_list(attributes: &[Attribute]) -> String {
    attributes
        .iter()
        .map(|attribute| {
            let label = match attribute {
                Attribute::Custom { label } => label.clone(),
                _ => attribute.to_string(),
            };
            if label.chars().any(char::is_whitespace) {
                format!("\"{label}\"")
            } else {
                label
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// A contiguous fixture ID range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixtureRangeExpr {
    /// Start fixture ID (inclusive).
    pub start: u32,
    /// End fixture ID (inclusive).
    pub end: u32,
}

impl std::fmt::Display for FixtureRangeExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.start == self.end {
            write!(f, "{}", self.start)
        } else {
            write!(f, "{}>{}", self.start, self.end)
        }
    }
}

/// Element selector applied to fixtures.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ElementSelectorExpr {
    /// Single element index (1-based).
    Single(u32),
    /// Range of element indices (inclusive).
    Range { start: u32, end: u32 },
}

impl std::fmt::Display for ElementSelectorExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ElementSelectorExpr::Single(index) => write!(f, "{}", index),
            ElementSelectorExpr::Range { start, end } => write!(f, "{}>{}", start, end),
        }
    }
}

/// Reference to a fixture or its element by user-facing ID
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct UnresolvedFixtureRef {
    /// Fixture ID
    pub fixture_id: u32,
    /// Element index (or None for to select all child elements)
    pub element_index: Option<u32>,
}

impl PartialOrd for UnresolvedFixtureRef {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for UnresolvedFixtureRef {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.fixture_id.cmp(&other.fixture_id) {
            Ordering::Equal => self.element_index.cmp(&other.element_index),
            other => other,
        }
    }
}

impl std::fmt::Display for UnresolvedFixtureRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.element_index {
            Some(idx) => write!(f, "{}.{}", self.fixture_id, idx),
            None => write!(f, "{}", self.fixture_id),
        }
    }
}

/// Reference to a DMX channel by universe and address
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DmxChannelRef {
    /// DMX universe (e.g., 1, 2, 3...)
    pub universe: u16,
    /// DMX address within universe (1-512)
    pub address: u16,
}

impl std::fmt::Display for DmxChannelRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.universe, self.address)
    }
}

/// Expression for selecting DMX channels (similar to IdExpr but for DMX addresses)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum DmxChannelExpr {
    /// A single DMX channel
    Single(DmxChannelRef),
    /// A range of DMX channels (start thru end, inclusive)
    Range {
        /// Start channel
        start: DmxChannelRef,
        /// End channel
        end: DmxChannelRef,
    },
    /// Addition of two expressions
    Add {
        /// Left-hand side of the addition
        lhs: Box<DmxChannelExpr>,
        /// Right-hand side of the addition
        rhs: Box<DmxChannelExpr>,
    },
    /// Subtraction of two expressions
    Sub {
        /// Left-hand side of the subtraction
        lhs: Box<DmxChannelExpr>,
        /// Right-hand side of the subtraction
        rhs: Box<DmxChannelExpr>,
    },
    /// Parenthesized expression
    Span(Box<DmxChannelExpr>),
}

impl DmxChannelExpr {
    /// Expand the expression into a list of DMX channel references (without deduplication).
    pub fn expand(&self) -> Vec<DmxChannelRef> {
        match self {
            DmxChannelExpr::Single(ch) => vec![*ch],
            DmxChannelExpr::Range { start, end } => {
                // Only expand within the same universe
                if start.universe != end.universe {
                    // Return both endpoints if different universes
                    return vec![*start, *end];
                }

                let universe = start.universe;
                if start.address <= end.address {
                    (start.address..=end.address)
                        .map(|addr| DmxChannelRef {
                            universe,
                            address: addr,
                        })
                        .collect()
                } else {
                    (end.address..=start.address)
                        .rev()
                        .map(|addr| DmxChannelRef {
                            universe,
                            address: addr,
                        })
                        .collect()
                }
            }
            DmxChannelExpr::Add { lhs, rhs } => {
                let mut out = lhs.expand();
                out.extend(rhs.expand());
                out
            }
            DmxChannelExpr::Sub { lhs, rhs } => {
                let mut out = lhs.expand();
                let remove: std::collections::HashSet<_> = rhs.expand().into_iter().collect();
                out.retain(|ch| !remove.contains(ch));
                out
            }
            DmxChannelExpr::Span(inner) => inner.expand(),
        }
    }
}

impl std::fmt::Display for DmxChannelExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DmxChannelExpr::Single(ch) => write!(f, "{}", ch),
            DmxChannelExpr::Range { start, end } => write!(f, "{}>{}", start, end),
            DmxChannelExpr::Add { lhs, rhs } => write!(f, "{} + {}", lhs, rhs),
            DmxChannelExpr::Sub { lhs, rhs } => write!(f, "{} - {}", lhs, rhs),
            DmxChannelExpr::Span(inner) => write!(f, "({})", inner),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_ref(id: u128) -> FixtureRef {
        FixtureRef {
            fixture_uid: Uuid::from_u128(id),
            index: None,
        }
    }

    #[test]
    fn spatial_selection_identity_starts_with_no_clauses() {
        let source = SelectionExpr::Resolved(vec![fixture_ref(1), fixture_ref(2)]);
        let selection = SpatialSelection::identity(source.clone());

        assert_eq!(selection.source, source);
        assert!(selection.clauses.is_empty());
    }

    /// Empty resolved selections render as blank text so inspector output remains parseable.
    #[test]
    fn empty_resolved_selection_formats_blank() {
        assert_eq!(
            SelectionExpr::Resolved(Vec::<FixtureRef>::new()).to_string(),
            ""
        );
    }

    #[test]
    fn resolved_selection_to_spanned_selection_omits_empty_indexes() {
        let fixture_a = fixture_ref(1);
        let fixture_b = fixture_ref(2);
        let resolved = ResolvedSelection::new(
            vec![fixture_a.clone(), fixture_b.clone()],
            vec![
                SelectionIndex {
                    index: 0,
                    invert: false,
                    members: vec![IndexedFixture {
                        fixture: fixture_a.clone(),
                        projected_coord: ProjectedCoord { x: 0, y: 0, z: 0 },
                    }],
                },
                SelectionIndex {
                    index: 1,
                    invert: true,
                    members: Vec::new(),
                },
                SelectionIndex {
                    index: 2,
                    invert: false,
                    members: vec![IndexedFixture {
                        fixture: fixture_b.clone(),
                        projected_coord: ProjectedCoord { x: 1, y: 0, z: 0 },
                    }],
                },
            ],
            None,
        );

        let spans = resolved.to_spanned_selection();
        let collected: Vec<Vec<FixtureRef>> = spans.spans().map(|span| span.to_vec()).collect();

        assert_eq!(resolved.iter_indexes().count(), 3);
        assert_eq!(resolved.iter_non_empty_indexes().count(), 2);
        assert_eq!(spans.span_count(), 2);
        assert_eq!(collected, vec![vec![fixture_a], vec![fixture_b]]);
    }
}
