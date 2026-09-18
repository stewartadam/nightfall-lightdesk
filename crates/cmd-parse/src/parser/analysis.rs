// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Prefix/strict parser analysis contracts.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use smol_str::SmolStr;

use crate::ast::CommandAst;
use crate::slots::contracts::{ClauseId, SlotId};

/// Grammar rule identifiers used in parser analysis output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrammarRuleId {
    Program,
    Command,
    GeneralCommand,
    SelectionCommand,
    SelectionType,
    Selection,
    IdentifierExpression,
    SimpleIdentifierExpression,
    Term,
    SimpleTerm,
    Range,
    GroupedExpr,
    SingleId,
    SimpleId,
    ObjectType,
    SetAttribute,
    AttributeActions,
    AttributeType,
    SetIntensity,
    SetFullIntensity,
    ValueRange,
    Value,
    Integer,
    Uinteger,
    Timings,
    TimingKeyword,
    Fades,
    Delays,
    DurationValue,
    DurationUnit,
    FixturePlacementCommand,
    PlacementActions,
    Axis,
    FxCommand,
    FxActions,
    SetFxRate,
    FxStep,
    StepFxSelectionHead,
    FxAttributeSteps,
    CurveName,
    PatchCommand,
    PatchEndpoint,
    TransportName,
    TransportEndpoint,
    ConsoleKeyword,
    UniverseRange,
    Address,
    DmxChannelExpression,
    DmxChannelTerm,
    DmxChannelSingle,
    DmxChannelRef,
    ReleaseCommand,
    ReleaseTarget,
    ReleaseDmxTarget,
    ReleaseChannelKeyword,
    ReleaseDmxChannelExpression,
    ReleaseDmxChannelTerm,
    ReleaseDmxChannelSingle,
    ReleaseDmxChannelRef,
    CueRef,
    Sequence,
    Cue,
    FlowCommand,
    FlowActions,
    TimecodeActions,
    TimelineActions,
    TimecodeCommand,
    TimelineCommand,
    LogCommands,
    LogFilterCommands,
    LogFixtureCommand,
    SleepCommand,
    SetFpsCommand,
    RecallCueCommand,
    RecallBlueprintCommand,
    CreateFlow,
    DeleteFlow,
    RenameFlow,
    StartFlow,
    StopFlow,
    GoFlow,
    CreateStepFx,
    StartFx,
    StopFx,
    PlaybackActions,
}

/// Semantic token identifiers recognized by command parser analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenId {
    Pipe,
    Equals,
    StepFx,
    FxModule,
    Stale,
    Inputs,
    Save,
    Load,
    New,
    Showfile,
    Help,
    Quit,
    Undo,
    Redo,
    Block,
    Unblock,
    Overwrite,
    Set,
    Copy,
    Label,
    Target,

    AtSign,
    DoubleAtSign,
    Dot,
    Colon,
    Tilde,
    Plus,
    Minus,
    GreaterThan,
    LeftParen,
    RightParen,
    LeftBrace,
    RightBrace,
    Semicolon,
    Quote,
    Fixture,
    Group,
    Parameter,
    Fx,
    Module,
    Step,
    Patch,
    Channel,
    Clip,
    Flow,
    Timecode,
    Timeline,
    Store,
    Rename,
    Rm,
    Clear,
    Release,
    Recall,
    Debug,
    Sleep,
    Fps,
    Log,
    Fade,
    Delay,
    In,
    Out,
    Start,
    Stop,
    Pause,
    Go,
    Back,
    Goto,
    Rate,
    Width,
    Ramp,
    Steps,
    ThreeD,
    Pos,
    Rot,
    X,
    Y,
    Z,
    Console,
    Sacn,
    Artnet,
    Udmx,
    Disabled,
    Intensity,
    Red,
    Green,
    Blue,
    White,
    Attribute,
    Attr,
    Type,
    Filter,
    Values,
    Selected,
    Blueprint,
    Absolute,
    Cue,
    Sequence,
    Path,
    Level,
    Create,
}

/// Placeholder value categories accepted by command parser slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueKind {
    /// Runtime Blueprint ID or label accepted at this grammar position.
    BlueprintAddress,
    /// Compact color-path object reference, such as `path101`.
    ColorPathReference,
    /// Free-form text accepted by a grammar-owned name or label slot.
    Text,
    NumericDigit,
    IdentifierExpression,
    ValueRange,
    DurationValue,
    DmxAddress,
}

/// Completion expectations produced by parser analysis.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum ExpectedToken {
    Token(TokenId),
    Placeholder(ValueKind),
    Literal(SmolStr),
}

/// High-level parser outcome after analyzing an input string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    Ok,
    Error,
}

/// Half-open byte range attached to parser analysis nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord, Hash)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

/// Concrete parsed occurrence of a grammar clause and its span.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ClauseInstance {
    pub clause: ClauseId,
    pub instance: u32,
}

/// Reference from parser analysis output back to a grammar slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotRef {
    pub slot: SlotId,
    pub clause: Option<ClauseInstance>,
}

/// Identifies one clause node inside an observed parse tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord, Hash)]
#[serde(transparent)]
pub struct ClauseNodeId(pub u32);

/// One filled slot attached to a clause node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClauseSlotFill {
    pub slot: SlotId,
    pub value: FilledValue,
    pub span: Span,
}

/// One observed clause node built from parser analysis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClauseNode {
    pub clause: ClauseInstance,
    pub occurrence: u32,
    pub parent: Option<ClauseNodeId>,
    pub children: Vec<ClauseNodeId>,
    pub fills: Vec<ClauseSlotFill>,
    pub span: Option<Span>,
    pub explicit: bool,
}

/// Observed clause tree for a parsed command prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ClauseParseTree {
    pub roots: Vec<ClauseNodeId>,
    pub nodes: Vec<ClauseNode>,
}

/// Branch-local token position and furthest accepted progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseCursor {
    pub token_index: usize,
    pub furthest_pos: usize,
}

/// Current lifecycle phase for a clause frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClausePhase {
    Entered,
    Filling,
    Completed,
}

/// Whether a clause frame is speculative or semantically committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClauseCommitState {
    Speculative,
    Committed,
}

/// One clause frame on a parse branch stack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClauseFrame {
    pub clause: ClauseInstance,
    pub phase: ClausePhase,
    pub commit_state: ClauseCommitState,
}

/// Normalized semantic value used for clause-local constraints.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum NormalizedFilledValue {
    Attribute(SmolStr),
    Property(SmolStr),
    Identifier(SmolStr),
    Literal(SmolStr),
    Keyword(TokenId),
}

/// One consumed semantic item with provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumedSemanticItem {
    pub slot: SlotRef,
    pub clause: ClauseInstance,
    pub surface: SmolStr,
    pub normalized_value: Option<NormalizedFilledValue>,
    pub source_span: Span,
    pub source_token_start: usize,
    pub source_token_end: usize,
}

/// Clause-local consumed normalized values that affect future legality.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClauseUsageState {
    pub clause: ClauseInstance,
    pub used_values: BTreeSet<NormalizedFilledValue>,
}

/// Structural target of a branch-local continuation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContinuationTarget {
    Slot(SlotRef),
    Clause(ClauseId),
}

/// Semantic category of a continuation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuationKind {
    CommandHead,
    ClauseEntry,
    SlotValue,
    AttributeName,
    AttributeValue,
    PropertyName,
    PropertyValue,
    IdentifierExpr,
    Terminator,
}

/// One legal next continuation from a parse branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClauseExpectation {
    /// This alternative edits the active lexeme instead of appending a continuation.
    pub replace_active_token: bool,
    pub target: ContinuationTarget,
    pub continuation_kind: ContinuationKind,
    pub expected_tokens: Vec<ExpectedToken>,
    pub rule: GrammarRuleId,
}

/// Branch-projected continuation together with its committed clause ancestry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedClauseExpectation {
    /// Clause transition represented by this slot projection, when it enters a new clause.
    pub entry_clause: Option<ClauseId>,
    /// Ancestry of the slot or clause reached by this particular continuation.
    pub frontier_path: Vec<ClauseInstance>,
    /// Parser-owned edit range within this command segment.
    pub replace: Span,
    /// Index of the branch whose semantic evidence owns this expectation.
    pub branch_index: usize,
    pub clause_path: Vec<ClauseInstance>,
    pub expectation: ClauseExpectation,
}

/// Lifecycle status of one parse branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathStatus {
    Live,
    Completed,
    Rejected,
}

/// One viable interpretation branch within a command segment.
#[derive(Debug, Clone, PartialEq)]
pub struct ParseBranchState<'i> {
    pub cursor: ParseCursor,
    pub clause_stack: Vec<ClauseFrame>,
    pub clause_tree: ClauseParseTree,
    pub clause_usage: Vec<ClauseUsageState>,
    pub consumed_items: Vec<ConsumedSemanticItem>,
    pub status: PathStatus,
    pub frontier: Vec<ClauseExpectation>,
    /// AST materialized from this branch when it accepts the entire input.
    pub ast: Option<CommandAst<'i>>,
}

impl<'i> ParseBranchState<'i> {
    /// Returns the semantically committed clause path for this branch.
    pub fn committed_clause_path(&self) -> Vec<ClauseInstance> {
        self.clause_stack
            .iter()
            .take_while(|frame| frame.commit_state == ClauseCommitState::Committed)
            .map(|frame| frame.clause.clone())
            .collect()
    }

    /// Returns the real or proposed ancestry of one parser continuation.
    pub fn frontier_path(&self, expectation: &ClauseExpectation) -> Vec<ClauseInstance> {
        let target = match &expectation.target {
            ContinuationTarget::Slot(slot) => slot.clause.clone(),
            ContinuationTarget::Clause(clause) => Some(ClauseInstance {
                clause: *clause,
                instance: crate::slots::contracts::clause_parent(*clause).map_or(0, |parent| {
                    crate::parser::structural::next_child_clause_instance(self, parent, *clause)
                }),
            }),
        };
        target.map_or_else(Vec::new, |clause| self.path_to_clause(&clause))
    }

    /// Resolves an existing node through its tree parents, or a proposed node through its active parent.
    fn path_to_clause(&self, clause: &ClauseInstance) -> Vec<ClauseInstance> {
        if let Some(index) = self
            .clause_tree
            .nodes
            .iter()
            .position(|node| node.clause == *clause)
        {
            let mut path = Vec::new();
            let mut next = Some(ClauseNodeId(index as u32));
            while let Some(id) = next {
                let node = &self.clause_tree.nodes[id.0 as usize];
                path.push(node.clause.clone());
                next = node.parent;
            }
            path.reverse();
            return path;
        }
        let mut path =
            crate::slots::contracts::clause_parent(clause.clause).map_or_else(Vec::new, |parent| {
                let parent_instance = self
                    .clause_stack
                    .iter()
                    .rev()
                    .find(|frame| frame.clause.clause == parent)
                    .map(|frame| frame.clause.clone())
                    .unwrap_or_else(|| ClauseInstance {
                        clause: parent,
                        instance: crate::slots::contracts::clause_parent(parent).map_or(
                            0,
                            |grandparent| {
                                crate::parser::structural::next_child_clause_instance(
                                    self,
                                    grandparent,
                                    parent,
                                )
                            },
                        ),
                    });
                self.path_to_clause(&parent_instance)
            });
        path.push(clause.clone());
        path
    }

    /// Collects continuation ancestry without attaching sibling clauses to the active leaf.
    pub fn projected_clause_paths(&self) -> Vec<Vec<ClauseInstance>> {
        let mut paths = Vec::new();
        for expectation in &self.frontier {
            let path = self.frontier_path(expectation);
            if !path.is_empty() && !paths.contains(&path) {
                paths.push(path);
            }
        }
        paths
    }
}

/// Aggregate segment-level parser snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandPrefixSnapshot<'i> {
    pub context: CommandPrefixContext,
    pub branches: Vec<ParseBranchState<'i>>,
    /// Parser states before the active token, used exclusively for replacement edits.
    pub replacement_branches: Vec<ParseBranchState<'i>>,
    /// Expectations at the furthest executed position, before completion-specific text filtering.
    pub diagnostic_expectations: Vec<ClauseExpectation>,
}

impl<'i> CommandPrefixSnapshot<'i> {
    /// Enumerates continuation and replacement owners in the order used by projected source indices.
    pub fn completion_branches(&self) -> impl Iterator<Item = &ParseBranchState<'i>> {
        self.branches.iter().chain(&self.replacement_branches)
    }
    /// Returns the aggregate parse status across all non-rejected branches.
    pub fn status(&self) -> ParseStatus {
        if self
            .branches
            .iter()
            .any(|branch| branch.status == PathStatus::Completed)
        {
            ParseStatus::Ok
        } else {
            ParseStatus::Error
        }
    }

    /// Returns the furthest accepted byte position across branches.
    pub fn furthest_pos(&self) -> usize {
        self.branches
            .iter()
            .map(|branch| branch.cursor.furthest_pos)
            .max()
            .unwrap_or(0)
    }

    /// Returns the longest semantically committed clause-instance prefix shared by all non-rejected branches.
    pub fn committed_clause_path(&self) -> Vec<ClauseInstance> {
        let mut committed_paths = self
            .branches
            .iter()
            .filter(|branch| branch.status != PathStatus::Rejected)
            .map(ParseBranchState::committed_clause_path);

        let Some(mut prefix) = committed_paths.next() else {
            return Vec::new();
        };

        for path in committed_paths {
            let shared_len = prefix
                .iter()
                .zip(path.iter())
                .take_while(|(left, right)| left == right)
                .count();
            prefix.truncate(shared_len);
        }

        prefix
    }

    /// Returns distinct ancestry paths for both continuation and replacement frontiers.
    pub fn projected_clause_paths(&self) -> Vec<Vec<ClauseInstance>> {
        let mut paths = Vec::new();
        for source in self.projected_expectations() {
            if !source.frontier_path.is_empty() && !paths.contains(&source.frontier_path) {
                paths.push(source.frontier_path);
            }
        }
        paths
    }

    /// Returns consumed semantic items across all non-rejected branches.
    pub fn consumed_items(&self) -> Vec<&ConsumedSemanticItem> {
        self.branches
            .iter()
            .filter(|branch| branch.status != PathStatus::Rejected)
            .flat_map(|branch| branch.consumed_items.iter())
            .collect()
    }

    /// Returns parser-owned branch expectations annotated with committed clause ancestry.
    pub fn projected_expectations(&self) -> Vec<ProjectedClauseExpectation> {
        let mut projected = Vec::new();
        for (branch_index, branch) in self
            .completion_branches()
            .enumerate()
            .filter(|(_, branch)| branch.status != PathStatus::Rejected)
        {
            for raw in &branch.frontier {
                let entry_clause = match raw.target {
                    ContinuationTarget::Clause(clause) => Some(clause),
                    _ => None,
                };
                let expectations = entry_clause.map_or_else(
                    || vec![raw.clone()],
                    |clause| crate::parser::structural::entry_slot_expectations(branch, clause),
                );
                for mut expectation in expectations {
                    expectation
                        .expected_tokens
                        .retain(|token| raw.expected_tokens.contains(token));
                    if expectation.expected_tokens.is_empty() {
                        continue;
                    }
                    expectation.replace_active_token = raw.replace_active_token;
                    let source = ProjectedClauseExpectation {
                        entry_clause,
                        frontier_path: branch.frontier_path(&expectation),
                        replace: if expectation.replace_active_token
                            || (!self.context.has_trailing_whitespace
                                && branch.cursor.furthest_pos <= self.context.active_token_start)
                        {
                            Span {
                                start: self.context.active_token_start,
                                end: self.context.active_token_end,
                            }
                        } else {
                            Span {
                                start: self.context.cursor,
                                end: self.context.cursor,
                            }
                        },
                        branch_index,
                        clause_path: branch.committed_clause_path(),
                        expectation,
                    };
                    if !projected.contains(&source) {
                        projected.push(source);
                    }
                }
            }
        }
        projected
    }

    /// Projects branch-owned expectations into alternatives and their derived rule/token unions.
    pub fn frontier(&self) -> ParserFrontier {
        let mut alternatives = Vec::<FrontierAlternative>::new();
        let mut expected_rules = BTreeSet::<GrammarRuleId>::new();
        let mut expected_tokens = BTreeSet::<ExpectedToken>::new();

        for projected in self.projected_expectations() {
            let expectation = &projected.expectation;
            expected_rules.insert(expectation.rule);
            for token in &expectation.expected_tokens {
                expected_tokens.insert(token.clone());
            }
            let (slot, next_clause) = match &expectation.target {
                ContinuationTarget::Slot(slot) => (Some(slot.clone()), projected.entry_clause),
                ContinuationTarget::Clause(clause) => (None, Some(*clause)),
            };
            alternatives.push(FrontierAlternative {
                frontier_path: projected.frontier_path,
                replace: projected.replace,
                rule: expectation.rule,
                clause_path: projected.clause_path,
                slot,
                next_clause,
                expected_tokens: expectation.expected_tokens.clone(),
            });
        }

        ParserFrontier {
            alternatives,
            expected_rules: expected_rules.into_iter().collect(),
            expected_tokens: expected_tokens.into_iter().collect(),
        }
    }

    /// Returns the completed AST with the deepest committed path and greatest consumed evidence.
    pub fn completed_ast(&self) -> Option<CommandAst<'i>> {
        self.branches
            .iter()
            .filter(|branch| branch.status == PathStatus::Completed)
            .max_by_key(|branch| {
                (
                    branch.committed_clause_path().len(),
                    branch.consumed_items.len(),
                )
            })
            .and_then(|branch| branch.ast.clone())
    }
}

/// One viable parser continuation branch at the cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrontierAlternative {
    pub frontier_path: Vec<ClauseInstance>,
    /// Segment-relative edit range for the tokens in this alternative.
    pub replace: Span,
    pub rule: GrammarRuleId,
    pub clause_path: Vec<ClauseInstance>,
    pub slot: Option<SlotRef>,
    pub next_clause: Option<ClauseId>,
    pub expected_tokens: Vec<ExpectedToken>,
}

/// Parser-owned frontier alternatives plus derived union views.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ParserFrontier {
    pub alternatives: Vec<FrontierAlternative>,
    pub expected_rules: Vec<GrammarRuleId>,
    pub expected_tokens: Vec<ExpectedToken>,
}

/// Value forms captured when parser analysis fills a slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum FilledValue {
    Token(TokenId),
    Placeholder(ValueKind, SmolStr),
    Lexeme(SmolStr),
}

/// Parser context returned for the current command prefix and completion position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandPrefixContext {
    pub segment_start: usize,
    pub segment_end: usize,
    pub cursor: usize,
    pub token_count: usize,
    pub active_token_start: usize,
    pub active_token_end: usize,
    pub has_trailing_whitespace: bool,
    pub active_token_text: Option<SmolStr>,
}

impl Default for CommandPrefixContext {
    /// Builds an empty prefix context for callers that populate the fields incrementally.
    fn default() -> Self {
        Self {
            segment_start: 0,
            segment_end: 0,
            cursor: 0,
            token_count: 0,
            active_token_start: 0,
            active_token_end: 0,
            has_trailing_whitespace: false,
            active_token_text: None,
        }
    }
}
