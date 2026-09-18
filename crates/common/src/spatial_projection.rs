// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{BTreeMap, BTreeSet, HashSet};

use nightfall_dmx::prelude::Attribute;

use crate::{
    command_types::{
        Axis, GridSize, IndexedFixture, InvertMode, ProjectedCoord, ProjectionBounds,
        ResolvedSelection, SelectionExpr, SelectionIndex, SpatialClause, SpatialSelection,
    },
    data::FixtureRef,
    partial_result::PartialResult,
    spanned_selection::SpannedSelection,
};

/// Error returned when a spatial selection cannot be projected without external resolution context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpatialProjectionError {
    /// The selection source still contains unresolved fixture, group, range, or set expressions.
    UnresolvedSource,
}

/// Project an already-spanned source selection through spatial clauses.
pub fn project_spanned_selection(
    source: &SpannedSelection,
    canonical: Vec<FixtureRef>,
    clauses: &[SpatialClause],
) -> PartialResult<ResolvedSelection> {
    project_spanned_selection_with_expander(source, canonical, clauses, |fixture| {
        vec![fixture.clone()]
    })
}

/// Project an already-spanned source selection through spatial clauses with fixture expansion.
pub fn project_spanned_selection_with_expander(
    source: &SpannedSelection,
    canonical: Vec<FixtureRef>,
    clauses: &[SpatialClause],
    mut expand_member: impl FnMut(&FixtureRef) -> Vec<FixtureRef>,
) -> PartialResult<ResolvedSelection> {
    let mut state = ReplayState::from_spanned_selection(source);
    let mut issues = Vec::new();
    let mut canonical = canonical;

    for clause in clauses {
        state.apply_clause(clause, &mut issues, &mut expand_member);
        canonical = expand_canonical_for_clause(canonical, clause, &mut expand_member);
    }

    PartialResult::partial_many(state.into_resolved(canonical), issues)
}

/// Apply projection-time expansion to canonical refs when an expand clause can change members.
fn expand_canonical_for_clause(
    canonical: Vec<FixtureRef>,
    clause: &SpatialClause,
    expand_member: &mut impl FnMut(&FixtureRef) -> Vec<FixtureRef>,
) -> Vec<FixtureRef> {
    match clause {
        SpatialClause::Expand { depth } if !matches!(depth, Some(0)) => canonical
            .into_iter()
            .flat_map(|fixture| expand_member(&fixture))
            .collect(),
        _ => canonical,
    }
}

/// Project a spatial selection whose source is already resolved fixture refs.
pub fn project_resolved_spatial_selection(
    selection: &SpatialSelection,
) -> Result<PartialResult<ResolvedSelection>, SpatialProjectionError> {
    let (mut resolved, mut issues) = project_resolved_spatial_selection_pipeline(selection)?;
    for branch in &selection.union {
        let (branch_resolved, branch_issues) =
            project_resolved_spatial_selection(branch)?.into_parts();
        resolved.append_spatial_branch(branch_resolved);
        issues.extend(branch_issues);
    }

    Ok(PartialResult::partial_many(resolved, issues))
}

/// Project one resolved source-plus-clause pipeline, excluding union branches.
fn project_resolved_spatial_selection_pipeline(
    selection: &SpatialSelection,
) -> Result<(ResolvedSelection, Vec<String>), SpatialProjectionError> {
    let SelectionExpr::Resolved(source) = &selection.source else {
        return Err(SpatialProjectionError::UnresolvedSource);
    };

    let spanned = SpannedSelection::from_spans(
        source
            .iter()
            .cloned()
            .map(|fixture| vec![fixture])
            .collect::<Vec<_>>(),
    );
    Ok(project_spanned_selection(&spanned, source.clone(), &selection.clauses).into_parts())
}

/// Accumulates spatial selection clauses into occupied projection cells.
#[derive(Debug, Clone, Default)]
struct ReplayState {
    bounds: Option<Bounds>,
    cells: BTreeMap<(i32, i32, i32), ReplayUnit>,
    invert_attrs: Option<Vec<Attribute>>,
}

/// Inclusive extents occupied by the replay grid.
#[derive(Debug, Copy, Clone)]
struct Bounds {
    min_x: i32,
    max_x: i32,
    min_y: i32,
    max_y: i32,
    min_z: i32,
    max_z: i32,
}

/// Fixtures and grouping metadata stored in one replay grid cell.
#[derive(Debug, Clone)]
struct ReplayUnit {
    members: Vec<FixtureRef>,
    invert: bool,
    block_ids: BTreeSet<u32>,
    group_ids: BTreeSet<u32>,
    wing_ids: BTreeSet<u32>,
}

impl ReplayUnit {
    /// Build a replay unit when a span contains at least one member.
    fn new(members: Vec<FixtureRef>) -> Option<Self> {
        (!members.is_empty()).then_some(Self {
            members,
            invert: false,
            block_ids: BTreeSet::new(),
            group_ids: BTreeSet::new(),
            wing_ids: BTreeSet::new(),
        })
    }

    /// Merge replay units that share a projected index after grouping transforms.
    fn merge_all<'a>(units: impl IntoIterator<Item = &'a ReplayUnit>) -> Option<Self> {
        let mut members = Vec::new();
        let mut invert = false;
        let mut block_ids = BTreeSet::new();
        let mut group_ids = BTreeSet::new();
        let mut wing_ids = BTreeSet::new();

        for unit in units {
            members.extend(unit.members.iter().cloned());
            invert |= unit.invert;
            block_ids.extend(unit.block_ids.iter().copied());
            group_ids.extend(unit.group_ids.iter().copied());
            wing_ids.extend(unit.wing_ids.iter().copied());
        }

        (!members.is_empty()).then_some(Self {
            members,
            invert,
            block_ids,
            group_ids,
            wing_ids,
        })
    }

    /// Split this replay unit into one replay unit for each member fixture.
    fn split_members(self) -> Vec<Self> {
        self.members
            .into_iter()
            .map(|member| Self {
                members: vec![member],
                invert: self.invert,
                block_ids: self.block_ids.clone(),
                group_ids: self.group_ids.clone(),
                wing_ids: self.wing_ids.clone(),
            })
            .collect()
    }

    /// Return this replay unit with each member replaced by its expanded members.
    fn with_expanded_members(
        self,
        expand_member: &mut impl FnMut(&FixtureRef) -> Vec<FixtureRef>,
    ) -> Option<Self> {
        let members = self
            .members
            .into_iter()
            .flat_map(|member| expand_member(&member))
            .collect::<Vec<_>>();

        (!members.is_empty()).then_some(Self {
            members,
            invert: self.invert,
            block_ids: self.block_ids,
            group_ids: self.group_ids,
            wing_ids: self.wing_ids,
        })
    }

    /// Replace the block lineage with the block created by the current transform.
    fn with_block_id(mut self, id: u32) -> Self {
        self.block_ids.clear();
        self.block_ids.insert(id);
        self
    }

    /// Replace the group lineage with the group created by the current transform.
    fn with_group_id(mut self, id: u32) -> Self {
        self.group_ids.clear();
        self.group_ids.insert(id);
        self
    }

    /// Replace the wing lineage with the wing created by the current transform.
    fn with_wing_id(mut self, id: u32) -> Self {
        self.wing_ids.clear();
        self.wing_ids.insert(id);
        self
    }

    /// Return whether this unit belongs to an odd-indexed lineage for the invert mode.
    fn should_invert_for_mode(&self, mode: InvertMode) -> bool {
        let lineage = match mode {
            InvertMode::Index => return false,
            InvertMode::Block => &self.block_ids,
            InvertMode::Group => &self.group_ids,
            InvertMode::Wing => &self.wing_ids,
        };

        lineage.iter().any(|id| id % 2 == 1)
    }
}

impl Bounds {
    /// Create explicit inclusive projection bounds.
    fn new(min_x: i32, max_x: i32, min_y: i32, max_y: i32, min_z: i32, max_z: i32) -> Self {
        Self {
            min_x,
            max_x,
            min_y,
            max_y,
            min_z,
            max_z,
        }
    }

    /// Return the minimum coordinate on an axis.
    fn axis_min(&self, axis: Axis) -> i32 {
        match axis {
            Axis::X => self.min_x,
            Axis::Y => self.min_y,
            Axis::Z => self.min_z,
        }
    }

    /// Return the maximum coordinate on an axis.
    fn axis_max(&self, axis: Axis) -> i32 {
        match axis {
            Axis::X => self.max_x,
            Axis::Y => self.max_y,
            Axis::Z => self.max_z,
        }
    }

    /// Return the number of integer coordinates covered by an axis.
    fn axis_len(&self, axis: Axis) -> usize {
        (self.axis_max(axis) - self.axis_min(axis) + 1).max(0) as usize
    }

    /// Reset one axis while preserving the other two axes.
    fn set_axis_len(&mut self, axis: Axis, min: i32, len: usize) {
        let max = min + len as i32 - 1;
        match axis {
            Axis::X => {
                self.min_x = min;
                self.max_x = max;
            }
            Axis::Y => {
                self.min_y = min;
                self.max_y = max;
            }
            Axis::Z => {
                self.min_z = min;
                self.max_z = max;
            }
        }
    }
}

impl ReplayState {
    /// Seed the replay grid with one X-axis cell per source span.
    fn from_spanned_selection(selection: &SpannedSelection) -> Self {
        let spans: Vec<Vec<FixtureRef>> = selection.spans().map(|span| span.to_vec()).collect();
        if spans.is_empty() {
            return Self::default();
        }

        let mut cells = BTreeMap::new();
        for (x, span) in spans.into_iter().enumerate() {
            if let Some(unit) = ReplayUnit::new(span) {
                cells.insert((x as i32, 0, 0), unit);
            }
        }

        Self {
            bounds: Some(Bounds::new(
                0,
                cells.len().saturating_sub(1) as i32,
                0,
                0,
                0,
                0,
            )),
            cells,
            invert_attrs: None,
        }
    }

    /// Convert the replay grid into the resolved selection shape consumed by cue and selection code.
    fn into_resolved(self, canonical: Vec<FixtureRef>) -> ResolvedSelection {
        let canonical = self.filter_canonical(canonical);
        let Some(bounds) = self.bounds else {
            return ResolvedSelection::new(canonical, Vec::new(), self.invert_attrs);
        };

        let mut indexes = Vec::with_capacity(bounds.axis_len(Axis::X));
        for (index, x) in (bounds.min_x..=bounds.max_x).enumerate() {
            let mut members = Vec::new();
            let mut invert = false;

            for z in bounds.min_z..=bounds.max_z {
                for y in bounds.min_y..=bounds.max_y {
                    if let Some(unit) = self.cells.get(&(x, y, z)) {
                        invert |= unit.invert;
                        members.extend(unit.members.iter().cloned().map(|fixture| {
                            IndexedFixture {
                                fixture,
                                projected_coord: ProjectedCoord { x, y, z },
                            }
                        }));
                    }
                }
            }

            indexes.push(SelectionIndex {
                index: index as u32,
                invert,
                members,
            });
        }

        ResolvedSelection::with_projection_bounds(
            canonical,
            indexes,
            ProjectionBounds::new(
                bounds.min_x,
                bounds.max_x,
                bounds.min_y,
                bounds.max_y,
                bounds.min_z,
                bounds.max_z,
            ),
            self.invert_attrs,
        )
    }

    /// Apply one spatial clause to the replay grid.
    fn apply_clause(
        &mut self,
        clause: &SpatialClause,
        issues: &mut Vec<String>,
        expand_member: &mut impl FnMut(&FixtureRef) -> Vec<FixtureRef>,
    ) {
        match clause {
            SpatialClause::Grid(size) => self.apply_grid(size, issues),
            SpatialClause::Transpose => self.apply_transpose(),
            SpatialClause::Mirror(axis) => self.apply_mirror(*axis),
            SpatialClause::RotateLeft => self.apply_rotate_left(),
            SpatialClause::RotateRight => self.apply_rotate_right(),
            SpatialClause::Split => self.apply_split(),
            SpatialClause::Merge => self.apply_merge(),
            SpatialClause::Expand { depth } => self.apply_expand(*depth, expand_member),
            SpatialClause::Take(amount) => self.apply_take(*amount),
            SpatialClause::Skip(amount) => self.apply_skip(*amount),
            SpatialClause::Shift { axis, amount } => self.apply_shift(*axis, *amount),
            SpatialClause::Blocks { axis, amount } => self.apply_blocks(*axis, *amount, issues),
            SpatialClause::Group { axis, amount } => self.apply_group(*axis, *amount, issues),
            SpatialClause::Wings { axis, amount } => self.apply_wings(*axis, *amount, issues),
            SpatialClause::Shuffle { axis, seed } => self.apply_shuffle(*axis, *seed),
            SpatialClause::Invert { mode, attrs } => self.apply_invert(*mode, attrs.clone()),
        }
    }

    /// Split each current X-axis projection unit into one unit per fixture member.
    fn apply_split(&mut self) {
        self.transform_axis(Axis::X, |core| {
            core.into_iter()
                .flat_map(|unit| unit.split_members())
                .collect()
        });
    }

    /// Expand each current projection unit into its available member fixtures.
    fn apply_expand(
        &mut self,
        depth: Option<u32>,
        expand_member: &mut impl FnMut(&FixtureRef) -> Vec<FixtureRef>,
    ) {
        if matches!(depth, Some(0)) {
            return;
        }

        self.transform_axis(Axis::X, |core| {
            core.into_iter()
                .filter_map(|unit| unit.with_expanded_members(expand_member))
                .collect()
        });
    }

    /// Merge the current projected iterator shape into one projection unit.
    fn apply_merge(&mut self) {
        let Some(bounds) = self.bounds else {
            return;
        };

        let mut ordered_units = Vec::new();
        for x in bounds.min_x..=bounds.max_x {
            for z in bounds.min_z..=bounds.max_z {
                for y in bounds.min_y..=bounds.max_y {
                    if let Some(unit) = self.cells.get(&(x, y, z)) {
                        ordered_units.push(unit);
                    }
                }
            }
        }
        let Some(unit) = ReplayUnit::merge_all(ordered_units) else {
            self.cells.clear();
            self.bounds = None;
            return;
        };

        self.cells = BTreeMap::from([((0, 0, 0), unit)]);
        self.bounds = Some(Bounds::new(0, 0, 0, 0, 0, 0));
    }

    /// Recluster dense X-axis steps into a two- or three-dimensional grid.
    fn apply_grid(&mut self, size: &GridSize, issues: &mut Vec<String>) {
        let steps = self.current_steps();
        if steps.is_empty() {
            return;
        }

        let (width, height, auto_height) = match size {
            GridSize::Width(width) if *width > 0 => (*width as usize, 1usize, true),
            GridSize::WidthHeight { x, y } if *x > 0 && *y > 0 => (*x as usize, *y as usize, false),
            _ => {
                issues.push("Grid requires positive dimensions".to_string());
                return;
            }
        };

        let lane_len = steps.len();
        let height = if auto_height {
            lane_len.div_ceil(width).max(1)
        } else {
            height
        };
        let slice_capacity = width * height;
        let depth = lane_len.div_ceil(slice_capacity).max(1);

        let mut cells = BTreeMap::new();
        for (index, step) in steps.into_iter().enumerate() {
            let x = (index % width) as i32;
            let y = ((index / width) % height) as i32;
            let z = (index / slice_capacity) as i32;
            if let Some(unit) = step {
                cells.insert((x, y, z), unit);
            }
        }

        self.cells = cells;
        self.bounds = Some(Bounds::new(
            0,
            width as i32 - 1,
            0,
            height as i32 - 1,
            0,
            depth as i32 - 1,
        ));
    }

    /// Swap X and Y coordinates while preserving Z coordinates.
    fn apply_transpose(&mut self) {
        let Some(bounds) = self.bounds else {
            return;
        };

        let width = bounds.axis_len(Axis::X);
        let height = bounds.axis_len(Axis::Y);
        let mut cells = BTreeMap::new();
        for ((x, y, z), unit) in &self.cells {
            let nx = bounds.min_x + (y - bounds.min_y);
            let ny = bounds.min_y + (x - bounds.min_x);
            cells.insert((nx, ny, *z), unit.clone());
        }

        self.cells = cells;
        self.bounds = Some(Bounds::new(
            bounds.min_x,
            bounds.min_x + height as i32 - 1,
            bounds.min_y,
            bounds.min_y + width as i32 - 1,
            bounds.min_z,
            bounds.max_z,
        ));
    }

    /// Mirror occupied cells across the requested axis.
    fn apply_mirror(&mut self, axis: Axis) {
        let Some(bounds) = self.bounds else {
            return;
        };

        self.cells = self
            .cells
            .iter()
            .map(|((x, y, z), unit)| {
                let coord = match axis {
                    Axis::X => (bounds.min_x + bounds.max_x - x, *y, *z),
                    Axis::Y => (*x, bounds.min_y + bounds.max_y - y, *z),
                    Axis::Z => (*x, *y, bounds.min_z + bounds.max_z - z),
                };
                (coord, unit.clone())
            })
            .collect();
    }

    /// Rotate the XY plane 90 degrees counter-clockwise.
    fn apply_rotate_left(&mut self) {
        let Some(bounds) = self.bounds else {
            return;
        };

        let width = bounds.axis_len(Axis::X) as i32;
        let mut cells = BTreeMap::new();
        for ((x, y, z), unit) in &self.cells {
            let x0 = x - bounds.min_x;
            let y0 = y - bounds.min_y;
            let nx = bounds.min_x + y0;
            let ny = bounds.min_y + (width - 1 - x0);
            cells.insert((nx, ny, *z), unit.clone());
        }

        let height = bounds.axis_len(Axis::Y);
        self.cells = cells;
        self.bounds = Some(Bounds::new(
            bounds.min_x,
            bounds.min_x + height as i32 - 1,
            bounds.min_y,
            bounds.min_y + width - 1,
            bounds.min_z,
            bounds.max_z,
        ));
    }

    /// Rotate the XY plane 90 degrees clockwise.
    fn apply_rotate_right(&mut self) {
        let Some(bounds) = self.bounds else {
            return;
        };

        let height = bounds.axis_len(Axis::Y) as i32;
        let mut cells = BTreeMap::new();
        for ((x, y, z), unit) in &self.cells {
            let x0 = x - bounds.min_x;
            let y0 = y - bounds.min_y;
            let nx = bounds.min_x + (height - 1 - y0);
            let ny = bounds.min_y + x0;
            cells.insert((nx, ny, *z), unit.clone());
        }

        let width = bounds.axis_len(Axis::X);
        self.cells = cells;
        self.bounds = Some(Bounds::new(
            bounds.min_x,
            bounds.min_x + height - 1,
            bounds.min_y,
            bounds.min_y + width as i32 - 1,
            bounds.min_z,
            bounds.max_z,
        ));
    }

    /// Translate occupied cells along one axis, retaining leading or trailing empty projection space.
    fn apply_shift(&mut self, axis: Axis, amount: i32) {
        let Some(mut bounds) = self.bounds else {
            return;
        };

        self.cells = self
            .cells
            .iter()
            .map(|((x, y, z), unit)| {
                let coord = match axis {
                    Axis::X => (x + amount, *y, *z),
                    Axis::Y => (*x, y + amount, *z),
                    Axis::Z => (*x, *y, z + amount),
                };
                (coord, unit.clone())
            })
            .collect();

        match axis {
            Axis::X => {
                bounds.min_x = bounds.min_x.min(bounds.min_x + amount);
                bounds.max_x = bounds.max_x.max(bounds.max_x + amount);
            }
            Axis::Y => {
                bounds.min_y = bounds.min_y.min(bounds.min_y + amount);
                bounds.max_y = bounds.max_y.max(bounds.max_y + amount);
            }
            Axis::Z => {
                bounds.min_z = bounds.min_z.min(bounds.min_z + amount);
                bounds.max_z = bounds.max_z.max(bounds.max_z + amount);
            }
        }

        self.bounds = Some(bounds);
    }

    /// Collapse dense lane entries into contiguous blocks.
    fn apply_blocks(&mut self, axis: Axis, amount: u32, issues: &mut Vec<String>) {
        let amount = amount as usize;
        if amount == 0 {
            issues.push("Blocks requires an amount greater than zero".to_string());
            return;
        }

        self.transform_axis(axis, |core| {
            if amount == 1 {
                return core
                    .into_iter()
                    .enumerate()
                    .map(|(index, unit)| unit.with_block_id(index as u32))
                    .collect();
            }

            core.chunks(amount)
                .enumerate()
                .filter_map(|(index, chunk)| {
                    ReplayUnit::merge_all(chunk.iter()).map(|unit| unit.with_block_id(index as u32))
                })
                .collect()
        });
    }

    /// Partition dense lane entries into a fixed number of groups.
    fn apply_group(&mut self, axis: Axis, amount: u32, issues: &mut Vec<String>) {
        let amount = amount as usize;
        if amount == 0 {
            issues.push("Group requires an amount greater than zero".to_string());
            return;
        }

        self.transform_axis(axis, |core| {
            if core.is_empty() {
                return core;
            }

            let mut output = Vec::with_capacity(amount);
            let mut cursor = 0usize;
            for (index, group_size) in contiguous_partition_sizes(core.len(), amount)
                .into_iter()
                .enumerate()
            {
                let next = cursor + group_size;
                output.extend(
                    ReplayUnit::merge_all(core[cursor..next].iter())
                        .map(|unit| unit.with_group_id(index as u32)),
                );
                cursor = next;
            }
            output
        });
    }

    /// Pair dense lane entries into symmetrical wings.
    fn apply_wings(&mut self, axis: Axis, amount: u32, issues: &mut Vec<String>) {
        let amount = amount as usize;
        if amount == 0 || !amount.is_multiple_of(2) {
            issues.push("Wings requires 1 or an even amount (2N)".to_string());
            return;
        }

        self.transform_axis(axis, |core| {
            if core.is_empty() {
                return core;
            }

            if amount == 1 {
                return core
                    .into_iter()
                    .enumerate()
                    .map(|(index, unit)| unit.with_wing_id(index as u32))
                    .collect();
            }

            let mut groups = Vec::with_capacity(amount);
            let mut cursor = 0usize;
            for group_size in contiguous_partition_sizes(core.len(), amount) {
                let next = cursor + group_size;
                let mut group = core[cursor..next].to_vec();
                if groups.len() % 2 == 1 {
                    group.reverse();
                }
                groups.push(group);
                cursor = next;
            }

            let mut output = Vec::new();
            for pair in groups.chunks(2) {
                let left = &pair[0];
                let right = pair.get(1).cloned().unwrap_or_default();
                for i in 0..left.len().max(right.len()) {
                    output.extend(
                        ReplayUnit::merge_all(left.get(i).into_iter().chain(right.get(i)))
                            .map(|unit| unit.with_wing_id(output.len() as u32)),
                    );
                }
            }

            output
        });
    }

    /// Shuffle dense lane entries with a deterministic seed.
    fn apply_shuffle(&mut self, axis: Axis, seed: u32) {
        if seed == 0 {
            return;
        }

        self.transform_axis(axis, |mut core| {
            deterministic_shuffle(&mut core, seed);
            core
        });
    }

    /// Mark replay units as inverted according to the active projection lineage.
    fn apply_invert(&mut self, mode: InvertMode, attrs: Option<Vec<Attribute>>) {
        let Some(bounds) = self.bounds else {
            return;
        };

        self.invert_attrs = attrs;

        for (offset, x) in (bounds.min_x..=bounds.max_x).enumerate() {
            for z in bounds.min_z..=bounds.max_z {
                for y in bounds.min_y..=bounds.max_y {
                    if let Some(unit) = self.cells.get_mut(&(x, y, z)) {
                        unit.invert = match mode {
                            InvertMode::Index => offset % 2 == 1,
                            InvertMode::Block | InvertMode::Group | InvertMode::Wing => {
                                unit.should_invert_for_mode(mode)
                            }
                        };
                    }
                }
            }
        }
    }

    /// Keeps only the first `amount` dense entries on each X-axis lane.
    fn apply_take(&mut self, amount: u32) {
        let amount = amount as usize;
        self.transform_axis(Axis::X, |core| core.into_iter().take(amount).collect());
    }

    /// Drops the first `amount` dense entries from each X-axis lane.
    fn apply_skip(&mut self, amount: u32) {
        let amount = amount as usize;
        self.transform_axis(Axis::X, |core| core.into_iter().skip(amount).collect());
    }

    /// Apply a dense-lane transform independently across every lane on an axis.
    fn transform_axis(
        &mut self,
        axis: Axis,
        mut transform: impl FnMut(Vec<ReplayUnit>) -> Vec<ReplayUnit>,
    ) {
        let Some(bounds) = self.bounds else {
            return;
        };

        let axis_min = bounds.axis_min(axis);
        let axis_len = bounds.axis_len(axis);
        let lane_keys = lane_keys(axis, bounds);
        let mut new_cells = BTreeMap::new();
        let mut output_len = 0usize;

        for lane_key in lane_keys {
            let lane = build_lane(&self.cells, bounds, axis, lane_key, axis_len);
            let (prefix, suffix, dense_core) = split_lane(lane);
            let dense_output = transform(dense_core);
            let lane_output = prefix + dense_output.len() + suffix;
            output_len = output_len.max(lane_output);

            for (idx, unit) in dense_output.into_iter().enumerate() {
                let axis_value = axis_min + prefix as i32 + idx as i32;
                new_cells.insert(coord_for(axis, axis_value, lane_key), unit);
            }
        }

        self.cells = new_cells;
        if output_len == 0 {
            self.bounds = None;
            return;
        }

        let mut new_bounds = bounds;
        new_bounds.set_axis_len(axis, axis_min, output_len);
        self.bounds = Some(new_bounds);
    }

    /// Return the current dense X-axis steps used as the source for grid reclustering.
    fn current_steps(&self) -> Vec<Option<ReplayUnit>> {
        let Some(bounds) = self.bounds else {
            return Vec::new();
        };

        (bounds.min_x..=bounds.max_x)
            .map(|x| {
                ReplayUnit::merge_all((bounds.min_z..=bounds.max_z).flat_map(|z| {
                    (bounds.min_y..=bounds.max_y).filter_map(move |y| self.cells.get(&(x, y, z)))
                }))
            })
            .collect()
    }

    /// Filters canonical fixtures down to the members still present after spatial subset clauses.
    fn filter_canonical(&self, canonical: Vec<FixtureRef>) -> Vec<FixtureRef> {
        let retained = self
            .cells
            .values()
            .flat_map(|unit| unit.members.iter().cloned())
            .collect::<HashSet<_>>();

        canonical
            .into_iter()
            .filter(|fixture| retained.contains(fixture))
            .collect()
    }
}

/// Partition a lane length into contiguous group sizes as evenly as possible.
fn contiguous_partition_sizes(len: usize, groups: usize) -> Vec<usize> {
    let base = len / groups;
    let remainder = len % groups;
    (0..groups)
        .map(|index| base + usize::from(index < remainder))
        .collect()
}

/// Apply a small deterministic in-place shuffle for stable cue timing indexes.
fn deterministic_shuffle<T>(items: &mut [T], seed: u32) {
    let mut state = seed as u64;
    for index in (1..items.len()).rev() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let swap_index = (state as usize) % (index + 1);
        items.swap(index, swap_index);
    }
}

/// Return every secondary coordinate pair that forms a lane for an axis.
fn lane_keys(axis: Axis, bounds: Bounds) -> Vec<(i32, i32)> {
    match axis {
        Axis::X => (bounds.min_z..=bounds.max_z)
            .flat_map(|z| (bounds.min_y..=bounds.max_y).map(move |y| (y, z)))
            .collect(),
        Axis::Y => (bounds.min_z..=bounds.max_z)
            .flat_map(|z| (bounds.min_x..=bounds.max_x).map(move |x| (x, z)))
            .collect(),
        Axis::Z => (bounds.min_y..=bounds.max_y)
            .flat_map(|y| (bounds.min_x..=bounds.max_x).map(move |x| (x, y)))
            .collect(),
    }
}

/// Materialize one sparse lane as optional replay units.
fn build_lane(
    cells: &BTreeMap<(i32, i32, i32), ReplayUnit>,
    bounds: Bounds,
    axis: Axis,
    lane_key: (i32, i32),
    axis_len: usize,
) -> Vec<Option<ReplayUnit>> {
    let axis_min = bounds.axis_min(axis);
    (0..axis_len)
        .map(|offset| {
            let axis_value = axis_min + offset as i32;
            cells.get(&coord_for(axis, axis_value, lane_key)).cloned()
        })
        .collect()
}

/// Split a lane into preserved empty edges and a dense occupied core.
fn split_lane(lane: Vec<Option<ReplayUnit>>) -> (usize, usize, Vec<ReplayUnit>) {
    let prefix = lane.iter().take_while(|cell| cell.is_none()).count();
    let suffix = lane.iter().rev().take_while(|cell| cell.is_none()).count();
    let core_end = lane.len().saturating_sub(suffix);
    let dense_core = if prefix >= core_end {
        Vec::new()
    } else {
        lane[prefix..core_end]
            .iter()
            .filter_map(|cell| cell.clone())
            .collect()
    };
    (prefix, suffix, dense_core)
}

/// Rebuild a full XYZ coordinate from one axis coordinate and a lane key.
fn coord_for(axis: Axis, axis_value: i32, lane_key: (i32, i32)) -> (i32, i32, i32) {
    match axis {
        Axis::X => (axis_value, lane_key.0, lane_key.1),
        Axis::Y => (lane_key.0, axis_value, lane_key.1),
        Axis::Z => (lane_key.0, lane_key.1, axis_value),
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    /// Build a fixture ref whose UUID encodes the supplied integer.
    fn fref(id: u128) -> FixtureRef {
        FixtureRef {
            fixture_uid: Uuid::from_u128(id),
            index: Some(1),
        }
    }

    /// Project a linear resolved source through spatial clauses.
    fn project_linear(clauses: Vec<SpatialClause>) -> ResolvedSelection {
        let source = (1..=8).map(fref).collect::<Vec<_>>();
        let selection = SpatialSelection {
            source: SelectionExpr::Resolved(source),
            clauses,
            union: Vec::new(),
        };

        project_resolved_spatial_selection(&selection)
            .unwrap()
            .value
    }

    /// Grid reclustering uses the current resolved indexes rather than the original source.
    #[test]
    fn grid_reclusters_current_resolved_indexes() {
        let resolved = project_linear(vec![
            SpatialClause::Grid(GridSize::Width(4)),
            SpatialClause::Grid(GridSize::Width(2)),
        ]);

        let fixture_ids = resolved
            .indexes()
            .iter()
            .map(|index| {
                index
                    .members
                    .iter()
                    .map(|member| member.fixture.fixture_uid.as_u128())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(fixture_ids, vec![vec![1, 5, 3, 7], vec![2, 6, 4, 8]]);
    }

    /// Resolved sources without a fixture resolver are seeded as one projection unit per fixture ref.
    #[test]
    fn resolved_source_creates_per_fixture_spans() {
        let resolved = project_linear(vec![SpatialClause::Take(2)]);

        assert_eq!(resolved.indexes().len(), 2);
        assert_eq!(resolved.canonical_fixtures(), &[fref(1), fref(2)]);
    }

    /// Merge combines all current iterator steps into one resolved index.
    #[test]
    fn merge_combines_current_indexes() {
        let resolved = project_linear(vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Merge,
        ]);

        let fixture_ids = resolved.indexes()[0]
            .members
            .iter()
            .map(|member| member.fixture.fixture_uid.as_u128())
            .collect::<Vec<_>>();

        assert_eq!(resolved.indexes().len(), 1);
        assert_eq!(fixture_ids, vec![1, 2, 3, 4, 5, 6, 7, 8]);
    }

    /// Split breaks each current top-level projection unit into fixture-level indexes.
    #[test]
    fn split_breaks_current_indexes_into_members() {
        let resolved = project_linear(vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Split,
        ]);

        let fixture_ids = resolved
            .indexes()
            .iter()
            .map(|index| {
                index
                    .members
                    .iter()
                    .map(|member| member.fixture.fixture_uid.as_u128())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(
            fixture_ids,
            vec![
                vec![1],
                vec![2],
                vec![3],
                vec![4],
                vec![5],
                vec![6],
                vec![7],
                vec![8],
            ]
        );
    }

    /// Expand resolves current projection unit members in place.
    #[test]
    fn expand_preserves_current_indexes() {
        let resolved = project_linear(vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Expand { depth: Some(1) },
        ]);

        let fixture_ids = resolved
            .indexes()
            .iter()
            .map(|index| {
                index
                    .members
                    .iter()
                    .map(|member| member.fixture.fixture_uid.as_u128())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(
            fixture_ids,
            vec![vec![1, 2], vec![3, 4], vec![5, 6], vec![7, 8]]
        );
    }

    /// Expand depth zero leaves the current projection shape unchanged.
    #[test]
    fn expand_zero_preserves_current_indexes() {
        let resolved = project_linear(vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Expand { depth: Some(0) },
        ]);

        let fixture_ids = resolved
            .indexes()
            .iter()
            .map(|index| {
                index
                    .members
                    .iter()
                    .map(|member| member.fixture.fixture_uid.as_u128())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(
            fixture_ids,
            vec![vec![1, 2], vec![3, 4], vec![5, 6], vec![7, 8]]
        );
    }
}
