// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST node definitions for strict CLI parsing.

use thiserror::Error;

/// Error returned when strict parsing cannot produce a command AST.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AstError {
    #[error("failed strict parse: {0}")]
    Strict(String),
}

/// Raw numeric or symbolic value token preserved from the command text.
#[derive(Debug, Clone, PartialEq)]
pub struct ValueAst<'i>(pub &'i str);

/// How a parameter value should be applied to its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParameterValueMode {
    /// Assign the parsed value as an absolute target.
    Absolute,
    /// Apply the parsed value as an offset from the current target value.
    Relative,
}

/// Signed offset token used by commands that store relative fixture adjustments.
#[derive(Debug, Clone, PartialEq)]
pub struct OffsetValueAst<'i>(pub &'i str);

/// A range of values for fanning across fixtures.
/// - 1 value = single value
/// - 2 values = linear fan from start to end
/// - 3+ values = envelope with interpolated waypoints
#[derive(Debug, Clone, PartialEq)]
pub struct ValueRangeAst<'i> {
    pub mode: ParameterValueMode,
    pub values: Vec<ValueAst<'i>>,
}

/// Marker value requested by attribute assignment commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueMarkerAst {
    /// Clear a tracked cue value from the target onward.
    Release,
    /// Keep position values out of lookahead handling.
    HoldPosition,
}

impl ValueMarkerAst {
    /// Parses a marker token surface accepted after an attribute value operator.
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "release" | "r" => Some(Self::Release),
            "hold" | "h" => Some(Self::HoldPosition),
            _ => None,
        }
    }
}

/// Integer token kept as source text until command conversion validates the range.
#[derive(Debug, Clone, PartialEq)]
pub struct IntegerAst<'i>(pub &'i str);

/// Unquoted word token captured from the command line.
#[derive(Debug, Clone, PartialEq)]
pub struct WordAst<'i>(pub &'i str);

/// Root AST node for a parsed command line.
#[derive(Debug, Clone, PartialEq)]
pub struct ProgramAst<'i> {
    pub command: CommandAst<'i>,
}

/// Top-level command families recognized by the strict parser.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandAst<'i> {
    General(GeneralCommandAst<'i>),
    Flow(FlowCommandAst),
    FxModule(FxModuleCommandAst),
    Fx(FxCommandAst<'i>),
    Clip(ClipCommandAst),
    Timecode(TimecodeCommandAst),
    Timeline(TimelineCommandAst),
    Channel(ChannelCommandAst<'i>),
    PatchAdd(PatchAddCommandAst<'i>),
    RmPatch(RmPatchCommandAst<'i>),
    FixturePlacement(FixturePlacementCommandAst<'i>),
    Selection(SelectionCommandAst<'i>),
    Attribute(AttributeCommandAst<'i>),
    ActiveSelectionAttribute(ActiveSelectionAttributeCommandAst<'i>),
}

/// Marker node for the `fx` command keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FxKeyword;

/// Marker node for the `flow` command keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowKeyword;

/// Marker node for the merge flag accepted by fx module storage commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FxModuleMergeFlagAst;

/// Marker node for the select flag accepted by cue recall commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecallCueSelectFlagAst;

/// Marker node for the `clip` command keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClipKeyword;

/// Marker node for the `timecode` command keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimecodeKeyword;

/// Marker node for the `timeline` command keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimelineKeyword;

/// Marker node for direct DMX channel commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelKeyword;

/// Marker node for the channel target inside `release` commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReleaseChannelKeyword;

/// Marker node for the `attribute` qualifier keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttributeKeyword;

/// Console object kinds accepted by generic commands such as rename, delete, and debug.
#[derive(Debug, Clone, PartialEq)]
pub enum ObjectTypeAst {
    Fx,
    Flow,
    Fixture,
    Parameter,
    Group,
    Clip,
    Cue,
    Sequence,
    Timecode,
    Timeline,
    Blueprint,
    ColorPath,
}

/// Marker node for the `fixture` command keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixtureKeyword;

/// Marker node for the `parameter` object keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParameterKeyword;

/// Marker node for the `group` object keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupKeyword;

/// Marker node for the `cue` object keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CueKeyword;

/// Marker node for the `sequence` object keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SequenceKeyword;

/// Marker node for the `blueprint` object keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlueprintKeyword;

/// Parsed fixture, parameter, or group selection command, including its original text.
#[derive(Debug, Clone)]
pub struct SelectionCommandAst<'i> {
    pub source: &'i str,
    pub selection: SelectionAst,
}

impl PartialEq for SelectionCommandAst<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (
            crate::parse_spatial_selection_text(self.source),
            crate::parse_spatial_selection_text(other.source),
        ) {
            (Ok(lhs), Ok(rhs)) => lhs == rhs,
            _ => self.selection == other.selection,
        }
    }
}

/// Attribute edits that apply to the current active selection.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveSelectionAttributeCommandAst<'i> {
    pub actions: AttributeActionsAst<'i>,
    pub timings: Option<TimingsAst<'i>>,
}

/// Attribute edits that include an explicit selection target.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributeCommandAst<'i> {
    pub selection: SelectionArgumentAst<'i>,
    pub actions: AttributeActionsAst<'i>,
    pub timings: Option<TimingsAst<'i>>,
}

/// Selection expression scoped to fixtures, parameters, or groups.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectionAst {
    pub selection_type: SelectionTypeAst,
    pub ids: IdentifierExpressionAst,
}

/// Selection argument that keeps both parsed structure and source text for later spatial parsing.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectionArgumentAst<'i> {
    pub source: &'i str,
    pub selection: SelectionAst,
}

/// Target namespace used when interpreting a selection expression.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionTypeAst {
    Fixture,
    Parameter,
    Group,
}

/// Parenthesized identifier expression.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupedExprAst {
    pub expr: Box<IdentifierExpressionAst>,
}

/// Inclusive range between two selection targets.
#[derive(Debug, Clone, PartialEq)]
pub struct RangeAst {
    pub start: SingleIdAst,
    pub end: SingleIdAst,
}

/// Inclusive fixture id range used by fixture-to-element maps.
#[derive(Debug, Clone, PartialEq)]
pub struct FixtureRangeAst {
    pub start: u32,
    pub end: u32,
}

/// Fixture element selector, either a single element or an inclusive range.
#[derive(Debug, Clone, PartialEq)]
pub enum ElementSelectorAst {
    Single(u32),
    Range { start: u32, end: u32 },
}

/// Mapping from a fixture id range to a fixture element selector.
#[derive(Debug, Clone, PartialEq)]
pub struct FixtureMapAst {
    pub fixtures: FixtureRangeAst,
    pub elements: ElementSelectorAst,
}

/// Single selection target, including fixture element addressing when present.
#[derive(Debug, Clone, PartialEq)]
pub struct SingleIdAst {
    pub target: TargetAst,
}

/// Address forms accepted for a single selection target.
#[derive(Debug, Clone, PartialEq)]
pub enum TargetAst {
    FixtureRef {
        fixture_id: u32,
    },
    ElementRef {
        fixture_id: u32,
        element_index: Option<u32>,
    },
}

/// One selectable term inside a full identifier expression.
#[derive(Debug, Clone, PartialEq)]
pub enum TermAst {
    Grouped(GroupedExprAst),
    FixtureMap(FixtureMapAst),
    Range(RangeAst),
    Single(SingleIdAst),
}

/// Set operation joining terms in an identifier expression.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetOperatorAst {
    Add,
    Remove,
}

/// Additional term in an identifier expression together with its set operator.
#[derive(Debug, Clone, PartialEq)]
pub struct OpTermAst {
    pub op: SetOperatorAst,
    pub term: TermAst,
}

/// Selection expression made from a first term plus optional add/remove terms.
#[derive(Debug, Clone, PartialEq)]
pub struct IdentifierExpressionAst {
    pub head: TermAst,
    pub tail: Vec<OpTermAst>,
}

/// Parenthesized expression for ids that do not support fixture element addressing.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleGroupedExprAst {
    pub expr: Box<SimpleIdentifierExpressionAst>,
}

/// Inclusive range between two plain numeric ids.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleRangeAst {
    pub start: SimpleIdAst,
    pub end: SimpleIdAst,
}

/// Plain numeric id used by non-fixture object commands.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleIdAst {
    pub id: u32,
}

/// One term in a plain numeric id expression.
#[derive(Debug, Clone, PartialEq)]
pub enum SimpleTermAst {
    Grouped(SimpleGroupedExprAst),
    Range(SimpleRangeAst),
    Single(SimpleIdAst),
}

/// Additional plain-id term together with its set operator.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleOpTermAst {
    pub op: SetOperatorAst,
    pub term: SimpleTermAst,
}

/// Add/remove expression over plain numeric ids.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleIdentifierExpressionAst {
    pub head: SimpleTermAst,
    pub tail: Vec<SimpleOpTermAst>,
}

/// Attribute name forms accepted by attribute and timing commands.
#[derive(Debug, Clone, PartialEq)]
pub enum AttributeTypeAst<'i> {
    Aliased(AttributeAliasAst),
    Quoted(&'i str),
    Other(&'i str),
}

/// Marker node for the `intensity` attribute alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntensityAlias;

/// Marker node for the `red` attribute alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedAlias;

/// Marker node for the `green` attribute alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GreenAlias;

/// Marker node for the `blue` attribute alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlueAlias;

/// Marker node for the `white` attribute alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WhiteAlias;

/// Built-in shorthand names for common fixture attributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeAliasAst {
    Intensity,
    Red,
    Green,
    Blue,
    White,
}

/// Attribute reference parsed through a built-in alias.
#[derive(Debug, Clone, PartialEq)]
pub struct AliasedAttributeAst {
    pub alias: AttributeAliasAst,
}

/// Raw text inside a quoted attribute name.
#[derive(Debug, Clone, PartialEq)]
pub struct QuotedAttributeInnerAst<'i>(pub &'i str);

/// Attribute reference whose name was quoted in the command text.
#[derive(Debug, Clone, PartialEq)]
pub struct QuotedAttributeAst<'i> {
    pub name: QuotedAttributeInnerAst<'i>,
}

/// Unquoted attribute name that is not one of the built-in aliases.
#[derive(Debug, Clone, PartialEq)]
pub struct OtherAttributeAst<'i>(pub &'i str);

/// Attribute assignment with an explicit attribute name and value fan.
#[derive(Debug, Clone, PartialEq)]
pub struct SetAttributeAst<'i> {
    pub target: AttributeTargetAst<'i>,
    pub source: AttributeValueSourceAst<'i>,
}

/// Logical target selected on the left-hand side of an attribute assignment.
#[derive(Debug, Clone, PartialEq)]
pub enum AttributeTargetAst<'i> {
    /// One logical fixture attribute.
    Attribute(AttributeTypeAst<'i>),
    /// Every Blueprint attribute in one canonical category.
    Category(AttributeCategoryAst),
}

/// Canonical attribute category parsed from an unquoted operator token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeCategoryAst {
    Dimmer,
    Position,
    Gobo,
    Color,
    Beam,
    Focus,
    Control,
    Other,
}

/// Value source accepted by the shared attribute-assignment grammar.
#[derive(Debug, Clone, PartialEq)]
pub enum AttributeValueSourceAst<'i> {
    /// Direct scalar or fanned logical values.
    Direct(ValueRangeAst<'i>),
    /// Values selected from a stored Blueprint.
    Blueprint(BlueprintSourceAst<'i>),
}

/// Numeric or label address preserved until stateful command execution.
#[derive(Debug, Clone, PartialEq)]
pub enum BlueprintAddressAst<'i> {
    Id(u32),
    Label(&'i str),
}

/// Parsed Blueprint value source and its source-local resolution mode.
#[derive(Debug, Clone, PartialEq)]
pub struct BlueprintSourceAst<'i> {
    pub address: BlueprintAddressAst<'i>,
    pub resolution: BlueprintResolutionAst,
}

/// Whether a parsed Blueprint source remains live or resolves immediately.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum BlueprintResolutionAst {
    #[default]
    Reference,
    Absolute,
}

/// Marker node for setting the active selection to full intensity.
#[derive(Debug, Clone, PartialEq)]
pub struct SetFullIntensityAst;

/// Intensity assignment that omits the attribute name.
#[derive(Debug, Clone, PartialEq)]
pub struct SetIntensityAst<'i> {
    pub value: ValueRangeAst<'i>,
}

/// Attribute operations accepted after a selection target.
#[derive(Debug, Clone, PartialEq)]
pub enum AttributeActionAst<'i> {
    SetFullIntensity,
    SetIntensity(ValueRangeAst<'i>),
    SetAttribute(SetAttributeAst<'i>),
    /// Apply every compatible value from a Blueprint source.
    ApplyBlueprint(BlueprintSourceAst<'i>),
}

/// Ordered attribute operations where the first action may use shorthand syntax.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributeActionsAst<'i> {
    pub first: AttributeActionAst<'i>,
    pub rest: Vec<SetAttributeAst<'i>>,
}

/// Per-attribute timing override inside a fade or delay clause.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributeOverrideAst<'i> {
    pub attribute: AttributeTypeAst<'i>,
    pub value: DurationRangeAst<'i>,
}

/// Direction qualifier for fade or delay timing clauses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimingDirectionAst {
    /// Timing applies while values assert into the current look.
    In,
    /// Timing applies while values move out of the current look.
    Out,
}

/// One fade or delay timing clause attached to an attribute command.
#[derive(Debug, Clone, PartialEq)]
pub struct TimingClauseAst<'i> {
    pub direction: Option<TimingDirectionAst>,
    pub value: Option<DurationRangeAst<'i>>,
    pub overrides: Vec<AttributeOverrideAst<'i>>,
}

/// Fade timing clause with an optional default and per-attribute overrides.
#[derive(Debug, Clone, PartialEq)]
pub struct FadesAst<'i> {
    pub direction: Option<TimingDirectionAst>,
    pub value: Option<DurationRangeAst<'i>>,
    pub overrides: Vec<AttributeOverrideAst<'i>>,
    pub additional: Vec<TimingClauseAst<'i>>,
}

/// Delay timing clause with an optional default and per-attribute overrides.
#[derive(Debug, Clone, PartialEq)]
pub struct DelaysAst<'i> {
    pub direction: Option<TimingDirectionAst>,
    pub value: Option<DurationRangeAst<'i>>,
    pub overrides: Vec<AttributeOverrideAst<'i>>,
    pub additional: Vec<TimingClauseAst<'i>>,
}

/// Optional fade and delay clauses attached to an attribute command.
#[derive(Debug, Clone, PartialEq)]
pub struct TimingsAst<'i> {
    pub fades: Option<FadesAst<'i>>,
    pub delays: Option<DelaysAst<'i>>,
}

/// Marker node for the `on` playback action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OnKeyword;

/// Marker node for the `off` playback action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OffKeyword;

/// Marker node for the `go` playback action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GoKeyword;

/// Marker node for the `back` playback action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackKeyword;

/// Playback action that jumps to a numbered position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GotoKeyword {
    pub position: u32,
}

/// Playback actions accepted by clip commands.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PlaybackActionAst {
    On,
    Off,
    Go,
    Back,
    Goto(u32),
    Rate(f32),
}

/// Clip command targeting one or more clip ids.
#[derive(Debug, Clone, PartialEq)]
pub struct ClipCommandAst {
    pub _clip: ClipKeyword,
    pub clip_id: SimpleIdentifierExpressionAst,
    pub action: PlaybackActionAst,
}

/// Marker node for the `start` keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartKeyword;

/// Marker node for the `pause` keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PauseKeyword;

/// Marker node for the `stop` keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopKeyword;

/// Start/stop action used by timeline-like commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartStopAst {
    Start,
    Stop,
}

/// Transport actions accepted by timecode commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimecodeActionAst {
    Start,
    Pause,
    Stop,
}

/// Timecode transport command targeting one or more timecode ids.
#[derive(Debug, Clone, PartialEq)]
pub struct TimecodeCommandAst {
    pub _timecode: TimecodeKeyword,
    pub timecode_id: SimpleIdentifierExpressionAst,
    pub action: TimecodeActionAst,
}

/// Timeline start or stop command targeting one or more timeline ids.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineCommandAst {
    pub _timeline: TimelineKeyword,
    pub timeline_id: SimpleIdentifierExpressionAst,
    pub action: StartStopAst,
}

/// Optional unit suffix attached to a duration value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DurationUnitAst<'i>(pub &'i str);

/// Duration token plus its optional unit suffix.
#[derive(Debug, Clone, PartialEq)]
pub struct DurationValueAst<'i> {
    pub value: ValueAst<'i>,
    pub unit: Option<DurationUnitAst<'i>>,
}

/// A range of durations for fanning across fixtures.
/// - 1 value = single duration
/// - 2 values = linear fan from start to end
/// - 3+ values = envelope with interpolated waypoints
#[derive(Debug, Clone, PartialEq)]
pub struct DurationRangeAst<'i> {
    pub values: Vec<DurationValueAst<'i>>,
}

/// Four control-point values for a custom cubic Bezier ramp curve.
#[derive(Debug, Clone, PartialEq)]
pub struct BezierControlPointsAst<'i> {
    pub x1: ValueAst<'i>,
    pub y1: ValueAst<'i>,
    pub x2: ValueAst<'i>,
    pub y2: ValueAst<'i>,
}

/// Ramp curve names accepted by Step FX commands.
#[derive(Debug, Clone, PartialEq)]
pub enum CurveNameAst<'i> {
    Linear,
    Ease,
    Easein,
    Easeout,
    Snap,
    Bezier(BezierControlPointsAst<'i>),
}

/// One step in a step FX attribute sequence.
#[derive(Debug, Clone, PartialEq)]
pub struct FxStepAst<'i> {
    pub source: FxValueSourceAst<'i>,
    pub width: Option<ValueAst<'i>>,
    pub ramp: Option<ValueAst<'i>>,
    pub curve: Option<CurveNameAst<'i>>,
}

/// Step sequence for one attribute in a step FX definition.
#[derive(Debug, Clone, PartialEq)]
pub struct FxAttributeStepsAst<'i> {
    pub attribute: AttributeTypeAst<'i>,
    /// Per-attribute base value for relative steps (e.g., int @ 50 steps ~25 ~-25)
    pub base_value: Option<FxValueSourceAst<'i>>,
    pub steps: Vec<FxStepAst<'i>>,
}

/// Scalar value source accepted by a Step FX baseline or target step.
#[derive(Debug, Clone, PartialEq)]
pub enum FxValueSourceAst<'i> {
    /// One numeric value with its absolute or relative mode.
    Direct {
        mode: ParameterValueMode,
        value: ValueAst<'i>,
    },
    /// One scalar attribute value selected from a stored Blueprint.
    Blueprint(BlueprintSourceAst<'i>),
}

/// Payload for creating a step FX over a selected fixture set.
#[derive(Debug, Clone, PartialEq)]
pub struct CreateStepFxAst<'i> {
    pub selection: SelectionArgumentAst<'i>,
    pub duration: DurationValueAst<'i>,
    pub base_value: Option<ValueAst<'i>>,
    pub attributes: Vec<FxAttributeStepsAst<'i>>,
}

/// Marker node for the `start flow` action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartFlowKeyword;

/// Marker node for the `stop flow` action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopFlowKeyword;

/// Marker node for the `go flow` action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GoFlowKeyword;

/// Marker node for the `delete flow` action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleteFlowKeyword;

/// New id expression for a flow rename command.
#[derive(Debug, Clone, PartialEq)]
pub struct RenameFlowAst {
    pub to: SimpleIdentifierExpressionAst,
}

/// Actions accepted by flow commands.
#[derive(Debug, Clone, PartialEq)]
pub enum FlowActionAst {
    Start,
    Stop,
    Go,
    Delete,
    Rename(RenameFlowAst),
}

/// Flow command targeting one or more flow ids.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowCommandAst {
    pub _flow: FlowKeyword,
    pub flow_id: SimpleIdentifierExpressionAst,
    pub action: FlowActionAst,
}

/// Marker node for starting an FX module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartFxModuleKeyword;

/// Marker node for stopping an FX module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopFxModuleKeyword;

/// Runtime actions accepted by FX module commands.
#[derive(Debug, Clone, PartialEq)]
pub enum FxModuleActionAst {
    Start,
    Stop,
}

/// FX module runtime command targeting one or more module ids.
#[derive(Debug, Clone, PartialEq)]
pub struct FxModuleCommandAst {
    pub _fx: FxKeyword,
    pub fx_id: SimpleIdentifierExpressionAst,
    pub action: FxModuleActionAst,
}

/// Marker node for starting an FX.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartFxKeyword;

/// Marker node for stopping an FX.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopFxKeyword;

/// Rate value for an FX speed update.
#[derive(Debug, Clone, PartialEq)]
pub struct SetFxRateAst<'i> {
    pub value: ValueAst<'i>,
}

/// Actions accepted by FX commands.
#[derive(Debug, Clone, PartialEq)]
pub enum FxActionAst<'i> {
    CreateStep(CreateStepFxAst<'i>),
    Start,
    Stop,
    SetRate(SetFxRateAst<'i>),
}

/// FX command targeting one or more FX ids.
#[derive(Debug, Clone, PartialEq)]
pub struct FxCommandAst<'i> {
    pub _fx: FxKeyword,
    pub fx_id: SimpleIdentifierExpressionAst,
    pub action: FxActionAst<'i>,
}

/// Command that waits for a parsed duration.
#[derive(Debug, Clone, PartialEq)]
pub struct SleepCommandAst<'i> {
    pub duration: DurationValueAst<'i>,
}

/// Command that exits the application.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuitCommandAst;

/// Command that displays command-line help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelpCommandAst;

/// Command that saves the current showfile.
#[derive(Debug, Clone, PartialEq)]
pub struct SaveCommandAst<'i> {
    pub name: Option<WordAst<'i>>,
}

/// Command that loads a showfile.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadCommandAst<'i> {
    pub name: Option<WordAst<'i>>,
}

/// Clear target that removes the active selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClearSelectionAst;

/// Clear target that removes programmer values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClearValuesAst;

/// Fixture target used by clear and release commands.
#[derive(Debug, Clone, PartialEq)]
pub struct FixtureSelectionAst {
    pub _fixture: FixtureKeyword,
    pub ids: IdentifierExpressionAst,
}

/// Attribute filter attached to a command target.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributeQualifierAst<'i> {
    pub _attr: AttributeKeyword,
    pub attributes: Vec<AttributeTypeAst<'i>>,
}

/// Clear target limited to fixtures and optionally to specific attributes.
#[derive(Debug, Clone, PartialEq)]
pub struct ClearFixtureTargetAst<'i> {
    pub selection: FixtureSelectionAst,
    pub attributes: Option<AttributeQualifierAst<'i>>,
}

/// Clear target limited to attributes on the active selection.
#[derive(Debug, Clone, PartialEq)]
pub struct ClearAttributeTargetAst<'i> {
    pub attributes: AttributeQualifierAst<'i>,
}

/// Targets accepted by the `clear` command.
#[derive(Debug, Clone, PartialEq)]
pub enum ClearTargetAst<'i> {
    Selection(ClearSelectionAst),
    Values(ClearValuesAst),
    Fixture(ClearFixtureTargetAst<'i>),
    Attribute(ClearAttributeTargetAst<'i>),
}

/// Clear command containing one or more explicit targets.
#[derive(Debug, Clone, PartialEq)]
pub struct ClearCommandAst<'i> {
    pub targets: Vec<ClearTargetAst<'i>>,
}

/// Command that reverts the last undoable action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UndoCommandAst;

/// Command that reapplies the last reverted action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedoCommandAst;

/// Release target limited to fixtures and optionally to specific attributes.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseFixtureTargetAst<'i> {
    pub selection: FixtureSelectionAst,
    pub attributes: Option<AttributeQualifierAst<'i>>,
}

/// Release target limited to attributes on the active selection.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseAttributeTargetAst<'i> {
    pub attributes: AttributeQualifierAst<'i>,
}

/// Release target for direct DMX channels.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseDmxTargetAst {
    pub _channel: ReleaseChannelKeyword,
    pub channels: ReleaseDmxChannelExpressionAst,
}

/// Targets accepted by the `release` command.
#[derive(Debug, Clone, PartialEq)]
pub enum ReleaseTargetAst<'i> {
    Dmx(ReleaseDmxTargetAst),
    Fixture(ReleaseFixtureTargetAst<'i>),
    Attribute(ReleaseAttributeTargetAst<'i>),
    Selection(SelectionAst),
    StaleInputs,
}

/// Release command, with no target meaning the active selection.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseCommandAst<'i> {
    pub target: Option<ReleaseTargetAst<'i>>,
}

/// Command that updates the engine frame rate.
#[derive(Debug, Clone, PartialEq)]
pub struct SetFpsCommandAst<'i> {
    pub fps: IntegerAst<'i>,
}

/// Command that stores a fixture definition from make, model, and mode text.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreFixtureCommandAst<'i> {
    pub _fixture: FixtureKeyword,
    pub id: IdentifierExpressionAst,
    pub make: QuotedStringAst<'i>,
    pub model: QuotedStringAst<'i>,
    pub mode: WordAst<'i>,
}

/// Raw configuration entry passed to an FX module store command.
#[derive(Debug, Clone, PartialEq)]
pub struct FxModuleConfigEntryAst<'i>(pub &'i str);

/// Selection clause for an FX module store command.
#[derive(Debug, Clone, PartialEq)]
pub struct FxModuleSelectionClauseAst<'i> {
    pub selection: SelectionArgumentAst<'i>,
}

/// Grouped configuration entries for an FX module store command.
#[derive(Debug, Clone, PartialEq)]
pub struct FxModuleConfigClauseAst<'i> {
    pub entries: Vec<FxModuleConfigEntryAst<'i>>,
}

/// Optional parts that can appear in an FX module store command.
#[derive(Debug, Clone, PartialEq)]
pub enum FxModuleStorePartAst<'i> {
    Selection(FxModuleSelectionClauseAst<'i>),
    ConfigClause(FxModuleConfigClauseAst<'i>),
    Merge(FxModuleMergeFlagAst),
    ConfigEntry(FxModuleConfigEntryAst<'i>),
}

/// Command that stores an FX module by id, module name, and optional parts.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreFxModuleCommandAst<'i> {
    pub _fx: FxKeyword,
    pub id: SimpleIdentifierExpressionAst,
    pub module_name: WordAst<'i>,
    pub parts: Vec<FxModuleStorePartAst<'i>>,
}

/// Command that stores a step FX definition.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreStepFxCommandAst<'i> {
    pub _fx: FxKeyword,
    pub id: SimpleIdentifierExpressionAst,
    pub definition: CreateStepFxAst<'i>,
}

/// Command that stores a new clip with default configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreClipCommandAst {
    pub _clip: ClipKeyword,
    pub id: SimpleIdentifierExpressionAst,
}

/// Command that stores an empty flow, optionally from a serialized definition.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreFlowCommandAst<'i> {
    pub _flow: FlowKeyword,
    pub id: SimpleIdentifierExpressionAst,
    pub payload: Option<QuotedStringAst<'i>>,
}

/// Command that stores a new timecode with default configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreTimecodeCommandAst {
    pub _timecode: TimecodeKeyword,
    pub id: SimpleIdentifierExpressionAst,
}

/// Command that stores a new timeline with default configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreTimelineCommandAst {
    pub _timeline: TimelineKeyword,
    pub id: SimpleIdentifierExpressionAst,
}

/// Command that stores a relative offset for one fixture attribute.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreFixtureOffsetCommandAst<'i> {
    pub _fixture: FixtureKeyword,
    pub id: IdentifierExpressionAst,
    pub attribute: AttributeTypeAst<'i>,
    pub value: OffsetValueAst<'i>,
}

/// Command that stores the current selection as a group.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreGroupCommandAst {
    pub _group: GroupKeyword,
    pub id: SimpleIdentifierExpressionAst,
}

/// Quoted string token with quotes removed by the parser.
#[derive(Debug, Clone, PartialEq)]
pub struct QuotedStringAst<'i>(pub &'i str);

/// Command that stores a blueprint with an optional attribute filter.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreBlueprintCommandAst<'i> {
    pub _blueprint: BlueprintKeyword,
    pub id: SimpleIdentifierExpressionAst,
    pub filter: Vec<AttributeTypeAst<'i>>,
}

/// Cue address made from sequence id and cue id.
#[derive(Debug, Clone, PartialEq)]
pub struct CueRefAst {
    pub sequence_id: u32,
    pub cue_id: u32,
}

/// Mode flag that controls how a cue store command applies programmer values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreCueModeAst {
    /// Replace the stored cue or part contents with the programmer values.
    Replace,
    /// Upsert programmer values into the stored cue or part.
    Merge,
    /// Update only existing fixture and attribute values in the stored cue or part.
    Update,
    /// Remove programmer attributes from the stored cue or part.
    Remove,
}

/// Target addressed by a cue store command.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreCueTargetAst {
    /// Store into the exact cue reference.
    Cue(CueRefAst),
    /// Store into each cue selected by an expression within one sequence.
    Cues {
        sequence_id: u32,
        cue_ids: SimpleIdentifierExpressionAst,
    },
    /// Store into the next available cue in the sequence.
    NextCue { sequence_id: u32 },
    /// Store into the exact cue part reference.
    CuePart { cue_ref: CueRefAst, part_id: u32 },
    /// Store into the next available part in the cue.
    NextPart { cue_ref: CueRefAst },
}

/// Command that stores the current programmer state into a cue or cue part.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreCueCommandAst {
    pub _cue: CueKeyword,
    pub target: StoreCueTargetAst,
    pub mode: StoreCueModeAst,
}

/// Operation applied to values that match cue tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockCueOperationAst {
    /// Assert values tracked into the target cue.
    Block,
    /// Remove assertions that still match values tracked into the target cue.
    Unblock,
}

/// Command that blocks or unblocks tracked values in a cue or cue part.
#[derive(Debug, Clone, PartialEq)]
pub struct BlockCueCommandAst {
    pub _cue: CueKeyword,
    pub cue_ref: CueRefAst,
    pub part_id: Option<u32>,
    pub operation: BlockCueOperationAst,
    pub overwrite: bool,
}

/// Command that deletes a cue.
#[derive(Debug, Clone, PartialEq)]
pub struct DeleteCueCommandAst {
    pub _cue: CueKeyword,
    pub cue_ref: CueRefAst,
}

/// Command that renumbers or moves a cue reference.
#[derive(Debug, Clone, PartialEq)]
pub struct RenameCueCommandAst {
    pub _cue: CueKeyword,
    pub from: CueRefAst,
    pub to: CueRefAst,
}

/// Command that assigns or clears a color path on a cue.
#[derive(Debug, Clone, PartialEq)]
pub struct SetCueColorPathCommandAst {
    pub _cue: CueKeyword,
    pub cue_ref: CueRefAst,
    pub color_path_id: Option<u32>,
}

/// Command that creates a custom color path definition.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreColorPathCommandAst<'i> {
    pub id: SimpleIdentifierExpressionAst,
    pub label: Option<WordAst<'i>>,
}

/// Command that updates a color path label.
#[derive(Debug, Clone, PartialEq)]
pub struct LabelColorPathCommandAst<'i> {
    pub id: SimpleIdentifierExpressionAst,
    pub label: WordAst<'i>,
}

/// Command that duplicates a color path definition into a new numeric ID.
#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateColorPathCommandAst {
    pub id: SimpleIdentifierExpressionAst,
    pub new_id: SimpleIdentifierExpressionAst,
}

/// Command that lists known color path definitions.
#[derive(Debug, Clone, PartialEq)]
pub struct ListColorPathsCommandAst;

/// Command that assigns or clears a whole-fixture default color path.
#[derive(Debug, Clone, PartialEq)]
pub struct SetFixtureColorPathCommandAst {
    pub _fixture: FixtureKeyword,
    pub id: IdentifierExpressionAst,
    pub color_path_id: Option<u32>,
}

/// Command that recalls a cue or cue part into the programmer.
#[derive(Debug, Clone, PartialEq)]
pub struct RecallCueCommandAst {
    pub _cue: CueKeyword,
    pub cue_ref: CueRefAst,
    pub part_id: Option<u32>,
    pub select: bool,
}

/// Generic rename command for object types addressed by numeric id.
#[derive(Debug, Clone, PartialEq)]
pub struct RenameCommandAst {
    pub object_type: ObjectTypeAst,
    pub from: SimpleIdentifierExpressionAst,
    pub to: SimpleIdentifierExpressionAst,
}

/// Generic delete command for object types addressed by numeric id.
#[derive(Debug, Clone, PartialEq)]
pub struct DeleteCommandAst {
    pub object_type: ObjectTypeAst,
    pub id: SimpleIdentifierExpressionAst,
}

/// Property name accepted by generic object property assignment commands.
#[derive(Debug, Clone, PartialEq)]
pub enum SetObjectPropertyAst {
    Target,
}

/// Assignable object families accepted as `target` property values.
#[derive(Debug, Clone, PartialEq)]
pub enum SetObjectTargetTypeAst {
    Sequence,
    Fx,
    StepFx,
    FxModule,
    Flow,
}

/// Object reference assigned as the value of a generic object property.
#[derive(Debug, Clone, PartialEq)]
pub struct SetObjectPropertyTargetAst {
    pub object_type: SetObjectTargetTypeAst,
    pub id: SimpleIdentifierExpressionAst,
}

/// Generic object property assignment parsed from `set <object> <id> <property>=<target> <id>`.
#[derive(Debug, Clone, PartialEq)]
pub struct SetObjectPropertyCommandAst {
    pub object_type: ObjectTypeAst,
    pub id: SimpleIdentifierExpressionAst,
    pub property: SetObjectPropertyAst,
    pub target: SetObjectPropertyTargetAst,
}

/// Command that recalls a blueprint into the programmer.
#[derive(Debug, Clone, PartialEq)]
pub struct RecallBlueprintCommandAst<'i> {
    pub _blueprint: BlueprintKeyword,
    pub source: BlueprintSourceAst<'i>,
}

/// Debug command targeting one object type and id expression.
#[derive(Debug, Clone, PartialEq)]
pub struct DebugCommandAst {
    pub object_type: ObjectTypeAst,
    pub id: SimpleIdentifierExpressionAst,
}

/// Log span field name used by instrumentation filters.
#[derive(Debug, Clone, PartialEq)]
pub struct SpanFieldNameAst<'i> {
    pub name: WordAst<'i>,
}

/// Log span field value used by instrumentation filters.
#[derive(Debug, Clone, PartialEq)]
pub struct SpanFieldValueAst<'i> {
    pub value: WordAst<'i>,
}

/// Command payload that enables or updates one span field filter.
#[derive(Debug, Clone, PartialEq)]
pub struct SetSpanFilterAst<'i> {
    pub field: SpanFieldNameAst<'i>,
    pub value: Option<SpanFieldValueAst<'i>>,
}

/// Command payload that clears span filters.
#[derive(Debug, Clone, PartialEq)]
pub struct ClearSpanFilterAst;

/// Log filter operations accepted by `log filter`.
#[derive(Debug, Clone, PartialEq)]
pub enum LogFilterCommandAst<'i> {
    Set(SetSpanFilterAst<'i>),
    Clear(ClearSpanFilterAst),
}

/// Parsed log filter command payload.
#[derive(Debug, Clone, PartialEq)]
pub struct LogFilterCommandsAst<'i> {
    pub filter: LogFilterCommandAst<'i>,
}

/// Log level token preserved for later validation.
#[derive(Debug, Clone, PartialEq)]
pub struct LogLevelAst<'i>(pub &'i str);

/// Command payload for setting the global or module log level.
#[derive(Debug, Clone, PartialEq)]
pub struct LogLevelCommandAst<'i> {
    pub level: LogLevelAst<'i>,
}

/// Command payload for inspecting one fixture attribute in logs.
#[derive(Debug, Clone, PartialEq)]
pub struct LogFixtureCommandAst<'i> {
    pub id: SingleIdAst,
    pub attribute: AttributeTypeAst<'i>,
}

/// Log subcommands accepted by the general command parser.
#[derive(Debug, Clone, PartialEq)]
pub enum LogCommandAst<'i> {
    Level(LogLevelCommandAst<'i>),
    Filter(LogFilterCommandsAst<'i>),
    Fixture(LogFixtureCommandAst<'i>),
}

/// Wrapper for a parsed log subcommand.
#[derive(Debug, Clone, PartialEq)]
pub struct LogCommandsAst<'i> {
    pub command: LogCommandAst<'i>,
}

/// Non-family-specific commands handled by the general command path.
#[derive(Debug, Clone, PartialEq)]
pub enum GeneralCommandAst<'i> {
    Sleep(SleepCommandAst<'i>),
    StoreFxModule(StoreFxModuleCommandAst<'i>),
    StoreStepFx(StoreStepFxCommandAst<'i>),
    StoreClip(StoreClipCommandAst),
    StoreFlow(StoreFlowCommandAst<'i>),
    StoreTimecode(StoreTimecodeCommandAst),
    StoreTimeline(StoreTimelineCommandAst),
    StoreBlueprint(StoreBlueprintCommandAst<'i>),
    StoreCue(StoreCueCommandAst),
    BlockCue(BlockCueCommandAst),
    StoreGroup(StoreGroupCommandAst),
    StoreFixtureOffset(StoreFixtureOffsetCommandAst<'i>),
    StoreFixture(StoreFixtureCommandAst<'i>),
    RenameCue(RenameCueCommandAst),
    SetCueColorPath(SetCueColorPathCommandAst),
    StoreColorPath(StoreColorPathCommandAst<'i>),
    LabelColorPath(LabelColorPathCommandAst<'i>),
    DuplicateColorPath(DuplicateColorPathCommandAst),
    ListColorPaths(ListColorPathsCommandAst),
    SetFixtureColorPath(SetFixtureColorPathCommandAst),
    Rename(RenameCommandAst),
    SetObjectProperty(SetObjectPropertyCommandAst),
    DeleteCue(DeleteCueCommandAst),
    Delete(DeleteCommandAst),
    NewShowfile(NewShowfileCommandAst),
    Save(SaveCommandAst<'i>),
    Load(LoadCommandAst<'i>),
    Help(HelpCommandAst),
    Quit(QuitCommandAst),
    Clear(ClearCommandAst<'i>),
    Release(ReleaseCommandAst<'i>),
    Debug(DebugCommandAst),
    SetFps(SetFpsCommandAst<'i>),
    Log(LogCommandsAst<'i>),
    RecallBlueprint(RecallBlueprintCommandAst<'i>),
    RecallCue(RecallCueCommandAst),
    Undo(UndoCommandAst),
    Redo(RedoCommandAst),
}

/// Command payload for starting a fresh showfile from the command line.
#[derive(Debug, Clone, PartialEq)]
pub struct NewShowfileCommandAst;

/// Direct DMX channel assignment command.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelCommandAst<'i> {
    pub _channel: ChannelKeyword,
    pub channels: DmxChannelExpressionAst,
    pub value: ValueAst<'i>,
}

/// Absolute DMX channel reference with universe and address.
#[derive(Debug, Clone, PartialEq)]
pub struct DmxChannelRefAst {
    pub universe: u16,
    pub address: u16,
}

/// Single direct DMX channel term.
#[derive(Debug, Clone, PartialEq)]
pub struct DmxChannelSingleAst {
    pub channel: DmxChannelRefAst,
}

/// Inclusive range between two direct DMX channel references.
#[derive(Debug, Clone, PartialEq)]
pub struct DmxChannelRangeAst {
    pub start: DmxChannelSingleAst,
    pub end: DmxChannelSingleAst,
}

/// Parenthesized direct DMX channel expression.
#[derive(Debug, Clone, PartialEq)]
pub struct DmxChannelGroupedAst {
    pub expr: Box<DmxChannelExpressionAst>,
}

/// One term in a direct DMX channel expression.
#[derive(Debug, Clone, PartialEq)]
pub enum DmxChannelTermAst {
    Grouped(DmxChannelGroupedAst),
    Range(DmxChannelRangeAst),
    Single(DmxChannelSingleAst),
}

/// Additional direct DMX channel term with its set operator.
#[derive(Debug, Clone, PartialEq)]
pub struct DmxChannelOpTermAst {
    pub op: SetOperatorAst,
    pub term: DmxChannelTermAst,
}

/// Add/remove expression over direct DMX channel terms.
#[derive(Debug, Clone, PartialEq)]
pub struct DmxChannelExpressionAst {
    pub head: DmxChannelTermAst,
    pub tail: Vec<DmxChannelOpTermAst>,
}

/// DMX channel reference for release commands, where the address may be omitted.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseDmxChannelRefAst {
    pub universe: u16,
    pub address: Option<u16>,
}

/// Single DMX channel release term.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseDmxChannelSingleAst {
    pub channel: ReleaseDmxChannelRefAst,
}

/// Inclusive range between two DMX channel release terms.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseDmxChannelRangeAst {
    pub start: ReleaseDmxChannelSingleAst,
    pub end: ReleaseDmxChannelSingleAst,
}

/// Parenthesized DMX channel release expression.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseDmxChannelGroupedAst {
    pub expr: Box<ReleaseDmxChannelExpressionAst>,
}

/// One term in a DMX channel release expression.
#[derive(Debug, Clone, PartialEq)]
pub enum ReleaseDmxChannelTermAst {
    Grouped(ReleaseDmxChannelGroupedAst),
    Range(ReleaseDmxChannelRangeAst),
    Single(ReleaseDmxChannelSingleAst),
}

/// Additional DMX release term with its set operator.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseDmxChannelOpTermAst {
    pub op: SetOperatorAst,
    pub term: ReleaseDmxChannelTermAst,
}

/// Add/remove expression over DMX channel release terms.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseDmxChannelExpressionAst {
    pub head: ReleaseDmxChannelTermAst,
    pub tail: Vec<ReleaseDmxChannelOpTermAst>,
}

/// Patch command that connects a source endpoint to a target endpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct PatchAddCommandAst<'i> {
    pub source: PatchEndpointAst<'i>,
    pub target: PatchEndpointAst<'i>,
    pub priority: Option<PatchPriorityAst<'i>>,
    pub clone: Option<PatchCloneAst>,
}

/// Patch command that removes bindings matching the supplied endpoint filters.
#[derive(Debug, Clone, PartialEq)]
pub struct RmPatchCommandAst<'i> {
    pub source: Option<PatchEndpointAst<'i>>,
    pub target: Option<PatchEndpointAst<'i>>,
    pub priority: Option<PatchPriorityAst<'i>>,
    pub clone: Option<PatchCloneAst>,
}

/// Endpoint forms accepted by patch add and remove commands.
#[derive(Debug, Clone, PartialEq)]
pub enum PatchEndpointAst<'i> {
    Console(ConsoleEndpointAst<'i>),
    Transport(TransportEndpointAst<'i>),
    Fixture(FixtureEndpointAst<'i>),
    Disabled(DisabledEndpointAst),
}

/// Console-side patch endpoint with optional universe range and address.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsoleEndpointAst<'i> {
    pub range: Option<UniverseRangeAst<'i>>,
    pub address: Option<AddressAst<'i>>,
}

/// Transport-side patch endpoint with optional universe range and address.
#[derive(Debug, Clone, PartialEq)]
pub struct TransportEndpointAst<'i> {
    pub transport: TransportNameAst<'i>,
    pub range: Option<UniverseRangeAst<'i>>,
    pub address: Option<AddressAst<'i>>,
}

/// Fixture-side patch endpoint, optionally narrowed to an element or parameter.
#[derive(Debug, Clone, PartialEq)]
pub struct FixtureEndpointAst<'i> {
    pub _fixture: FixtureKeyword,
    pub ids: IdentifierExpressionAst,
    pub target: Option<FixtureTargetAst<'i>>,
}

/// Optional element and parameter qualifier for a fixture endpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct FixtureTargetAst<'i> {
    pub element: Option<FixtureElementAst<'i>>,
    pub param: Option<FixtureParamAst<'i>>,
}

/// Fixture element index used inside patch endpoint syntax.
#[derive(Debug, Clone, PartialEq)]
pub struct FixtureElementAst<'i> {
    pub index: IntegerAst<'i>,
}

/// Fixture parameter name used inside patch endpoint syntax.
#[derive(Debug, Clone, PartialEq)]
pub struct FixtureParamAst<'i> {
    pub name: WordAst<'i>,
}

/// Endpoint marker for disabled bindings.
#[derive(Debug, Clone, PartialEq)]
pub struct DisabledEndpointAst;

/// Transport name token such as an output protocol.
#[derive(Debug, Clone, PartialEq)]
pub struct TransportNameAst<'i>(pub &'i str);

/// Inclusive universe range, or a single universe when `end` is absent.
#[derive(Debug, Clone, PartialEq)]
pub struct UniverseRangeAst<'i> {
    pub start: IntegerAst<'i>,
    pub end: Option<IntegerAst<'i>>,
}

/// DMX address token used by patch endpoints.
#[derive(Debug, Clone, PartialEq)]
pub struct AddressAst<'i> {
    pub value: IntegerAst<'i>,
}

/// Optional binding priority for patch commands.
#[derive(Debug, Clone, PartialEq)]
pub struct PatchPriorityAst<'i> {
    pub value: IntegerAst<'i>,
}

/// Marker node for patch clone mode.
#[derive(Debug, Clone, PartialEq)]
pub struct PatchCloneAst;

/// Command that updates fixture position and/or rotation.
#[derive(Debug, Clone, PartialEq)]
pub struct FixturePlacementCommandAst<'i> {
    pub _fixture: FixtureKeyword,
    pub ids: IdentifierExpressionAst,
    pub actions: PlacementActionsAst<'i>,
}

/// Position and rotation updates supplied to a fixture placement command.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacementActionsAst<'i> {
    pub position: Option<PositionActionAst<'i>>,
    pub rotation: Option<RotationActionAst<'i>>,
}

/// Position update value for a fixture placement command.
#[derive(Debug, Clone, PartialEq)]
pub struct PositionActionAst<'i> {
    pub value: PositionValueAst<'i>,
}

/// Rotation update value for a fixture placement command.
#[derive(Debug, Clone, PartialEq)]
pub struct RotationActionAst<'i> {
    pub value: RotationValueAst<'i>,
}

/// Three-axis value tuple in X, Y, Z order.
#[derive(Debug, Clone, PartialEq)]
pub struct TupleValueAst<'i> {
    pub x: ValueAst<'i>,
    pub y: ValueAst<'i>,
    pub z: ValueAst<'i>,
}

/// Single-axis placement value.
#[derive(Debug, Clone, PartialEq)]
pub struct AxisValueAst<'i> {
    pub axis: AxisAst,
    pub value: ValueAst<'i>,
}

/// Placement axes accepted by position and rotation commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AxisAst {
    X,
    Y,
    Z,
}

/// Position value forms: full tuple, one axis, or a chain of axis assignments.
#[derive(Debug, Clone, PartialEq)]
pub enum PositionValueAst<'i> {
    Tuple(TupleValueAst<'i>),
    Axis(AxisValueAst<'i>),
    AxisChain(Vec<AxisValueAst<'i>>),
}

/// Rotation value forms: full tuple, one axis, or a chain of axis assignments.
#[derive(Debug, Clone, PartialEq)]
pub enum RotationValueAst<'i> {
    Tuple(TupleValueAst<'i>),
    Axis(AxisValueAst<'i>),
    AxisChain(Vec<AxisValueAst<'i>>),
}
