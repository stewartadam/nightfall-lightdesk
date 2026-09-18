// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowCounterClockwiseIcon } from "@squidlab/phosphor-solid/arrow-counter-clockwise";
import { ArrowRightIcon } from "@squidlab/phosphor-solid/arrow-right";
import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import type { DockviewApi } from "dockview";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  clearDelegatedEvents,
  DelegatedEvents,
  delegateEvents,
  render,
} from "solid-js/web";
import { Input, InputGroup } from "../components/ui/form-controls";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import "dockview/dist/styles/dockview.css";
import "../index.css";
import "./styles.css";
import GlobalContextMenuHost from "../components/overlays/context-menu";
import { useCommand } from "../components/providers/command-registry";
import {
  closeContextMenu,
  openContextMenu,
} from "../components/providers/context-menu";
import { ShellOverlayCoordinatorProvider } from "../components/providers/shell-overlay-coordinator";
import { CommandPaletteProvider } from "../components/shell/command-palette/provider";
import {
  DockviewHost,
  visualLanguageDockTheme,
} from "../components/shell/docking/dockview/dockview-host";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import { MenuHeading } from "../components/ui/menu";
import { AccentPicker } from "../components/ui/visual-language/accent-picker";
import {
  visualLanguageAccents as accents,
  defaultAccent,
} from "../components/ui/visual-language/accents";
import { Button } from "../components/ui/visual-language/button";
import type { TabAlignment } from "../components/ui/visual-language/tab-alignment-select";
import { PrelineAdvancedSelect } from "../components/widgets/advanced-select";
import { ObjectTile } from "../components/widgets/object-tile";
import { getLogger } from "../lib/logger";
import { initializePrelineRuntime } from "../lib/preline-runtime";
import { pushToast } from "../state/appStores";
import { AnimationsDemo } from "./animations-demo";
import { ColorPickerDemo } from "./color-picker-demo";
import { ButtonDemo, DockingDemo, SliderDemo } from "./component-demos";
import { ComponentIndex } from "./component-index";
import { AttributeDemo, FaderDemo, SwitchDemo } from "./control-demos";
import { DataGridDemo } from "./data-grid-demo";
import { SparklineDemo, TooltipDemo } from "./feedback-demos";
import { InputFormsDemo } from "./input-forms-demo";
import { CommandPaletteDemo, ShortcutsDemo } from "./keyboard-demos";
import { InlineRenameDemo, ObjectSelectorDemo } from "./object-demos";
import { PopoutPreview, PopupDemo } from "./popup-demo";
import { ToastDemo } from "./toast-demo";
import { ToolbarDemo } from "./toolbar-demo";

const log = getLogger(import.meta.url);
const SESSION_LAYOUT_KEY = "nightfall.design-lab.layout";

const componentDemos = [
  { id: "animations", title: "Animations", component: "animations" },
  { id: "groups", title: "Object tiles", component: "groups" },
  { id: "buttons", title: "Buttons", component: "buttons" },
  { id: "toolbars", title: "Toolbars", component: "toolbars" },
  { id: "data-grid", title: "Data grid", component: "dataGrid" },
  { id: "selects", title: "Selects", component: "selects" },
  { id: "input-forms", title: "Input forms", component: "inputForms" },
  {
    id: "command-palette",
    title: "Command palette",
    component: "commandPalette",
  },
  { id: "shortcuts", title: "Shortcuts", component: "shortcuts" },
  { id: "menus", title: "Context menus", component: "menus" },
  { id: "sliders", title: "Sliders", component: "sliders" },
  { id: "switches", title: "Switches", component: "switches" },
  { id: "faders", title: "Vertical faders", component: "faders" },
  { id: "attributes", title: "Attribute sliders", component: "attributes" },
  {
    id: "object-selector",
    title: "Object selector",
    component: "objectSelector",
  },
  { id: "inline-rename", title: "Inline rename", component: "inlineRename" },
  { id: "sparklines", title: "Sparklines", component: "sparklines" },
  { id: "tooltips", title: "Tooltips", component: "tooltips" },
  { id: "color-picker", title: "Color picker", component: "colorPicker" },
  { id: "docking", title: "Docking", component: "docking" },
  { id: "popups", title: "Popups & popouts", component: "popups" },
  { id: "toasts", title: "Toasts", component: "toasts" },
];

type Sample = {
  id: number;
  name: string;
  detail: string;
  kind: "group" | "flow";
  tags?: string[];
};
const groups: Sample[] = [
  {
    id: 3,
    name: "Bstrip 1 left",
    detail: "12 fixtures · Stage left",
    tags: ["Wash", "Stage left"],
    kind: "group",
  },
  {
    id: 4,
    name: "Bstrip 1 right",
    detail: "12 fixtures · Stage right",
    tags: ["Wash", "Stage right"],
    kind: "group",
  },
  {
    id: 13,
    name: "Spots Front",
    detail: "8 fixtures · Downstage",
    tags: ["Spots"],
    kind: "group",
  },
  {
    id: 15,
    name: "Manual Strobes",
    detail: "6 fixtures · Overhead",
    kind: "group",
  },
  {
    id: 16,
    name: "Rotating Wash",
    detail: "16 fixtures · Main rig",
    tags: ["Movement", "Wash", "Main rig"],
    kind: "group",
  },
  {
    id: 17,
    name: "Rotating Wash (Left & Right)",
    detail: "24 fixtures · Full stage",
    tags: ["Movement", "Full stage"],
    kind: "group",
  },
];
const flows: Sample[] = [
  {
    id: 1,
    name: "Metronome pulse with alternating accents",
    detail: "6 nodes · 2 outputs",
    tags: ["Rhythm", "Intensity"],
    kind: "flow",
  },
  {
    id: 2,
    name: "Modulated wash intensity",
    detail: "8 nodes · 1 output",
    tags: ["Wash"],
    kind: "flow",
  },
  {
    id: 3,
    name: "Staggered movement across the rig",
    detail: "12 nodes · 3 outputs",
    kind: "flow",
  },
];
/** Presents a sandbox of real dock panels and local sample controls for design iteration. */
function DesignLab() {
  const [accent, setAccent] =
    createSignal<(typeof accents)[number]>(defaultAccent);
  const [compact, setCompact] = createSignal(false);
  const [roundedCorners, setRoundedCorners] = createSignal(true);
  const [muteUnfocusedAccents, setMuteUnfocusedAccents] = createSignal(false);
  const [tabPosition, setTabPosition] = createSignal<"top" | "bottom">("top");
  const [tabAlignment, setTabAlignment] = createSignal<TabAlignment>("justify");
  const [selected, setSelected] = createSignal<Sample>(groups[1]);
  const [gridLines, setGridLines] = createSignal(false);
  /** Displays action feedback without adding a persistent workspace status strip. */
  function showNotice(message: string) {
    pushToast("info", message);
  }
  const [hiddenTiles, setHiddenTiles] = createSignal<Sample[]>([]);
  const [activeDemo, setActiveDemo] = createSignal<string>();
  let dockHost!: HTMLDivElement;
  let dock: DockviewApi | undefined;
  const popoutWindows = new Set<Window>();

  for (const demo of componentDemos) {
    useCommand({
      id: `design-lab.open.${demo.id}`,
      name: `Open ${demo.title}`,
      description: `Open or focus the ${demo.title.toLowerCase()} panel`,
      category: "Components",
      execute: () => openDemo(demo),
    });
  }
  useCommand({
    id: "design-lab.toggle-density",
    name: "Toggle density",
    description: "Toggle Comfort / Compact density",
    category: "Appearance",
    shortcut: "Alt+Shift+d",
    execute: () => setCompact((current) => !current),
  });
  useCommand({
    id: "design-lab.next-accent",
    name: "Next accent",
    description: "Cycle the lab accent color",
    category: "Appearance",
    shortcut: "Alt+Shift+c",
    execute: () =>
      setAccent(
        (current) => accents[(accents.indexOf(current) + 1) % accents.length],
      ),
  });

  /** Moves one reusable sample panel into a floating region or a separate Dockview window. */
  async function openDetachedPreview(popout: boolean) {
    if (!dock) return;
    const panel =
      dock.getPanel("detached-preview") ??
      dock.addPanel({
        id: "detached-preview",
        component: "detachedPreview",
        title: "Detached preview",
      });
    try {
      if (popout) {
        if (panel.api.location.type === "popout") {
          for (const popoutWindow of popoutWindows) popoutWindow.focus();
          return;
        }
        const opened = await dock.addPopoutGroup(panel, {
          popoutUrl: "/design-lab-popout.html",
          position: {
            left: window.screenX + 100,
            top: window.screenY + 100,
            width: 520,
            height: 340,
          },
          /** Applies the shared theme to the new window after its document loads. */
          onDidOpen: ({ window: popoutWindow }) => {
            popoutWindows.add(popoutWindow);
            /** Mirrors the active palette into the detached document. */
            const applyTheme = () => {
              delegateEvents([...DelegatedEvents], popoutWindow.document);
              popoutWindow.document.documentElement.style.setProperty(
                "--accent",
                accent().value,
              );
              popoutWindow.document.documentElement.style.setProperty(
                "--nf-corner-radius",
                roundedCorners() ? "var(--nf-corner-radius-default)" : "0px",
              );
              popoutWindow.document.title = "Nightfall · Detached preview";
              popoutWindow.document.body.dataset.tabAlignment = tabAlignment();
              popoutWindow.document.body.dataset.muteUnfocusedAccents = String(
                muteUnfocusedAccents(),
              );
            };
            applyTheme();
            popoutWindow.addEventListener("load", applyTheme, { once: true });
          },
          onWillClose: ({ window: popoutWindow }) => {
            clearDelegatedEvents(popoutWindow.document);
            popoutWindows.delete(popoutWindow);
          },
        });
        if (!opened)
          showNotice(
            "The pop-out could not open. Check this site's popup permission.",
          );
      } else {
        dock.addFloatingGroup(panel, {
          width: 440,
          height: 280,
          position: { left: 80, top: 60 },
        });
        panel.api.setActive();
      }
    } catch (error) {
      log.error("Failed to open design lab preview", error);
      showNotice("The detached preview could not open.");
    }
  }

  /** Opens a missing demo or activates its existing panel without duplicating or resetting it. */
  function openDemo(demo: (typeof componentDemos)[number]) {
    if (!dock) return;
    const reference = dock.getPanel("groups") ?? dock.panels[0];
    const panel =
      dock.getPanel(demo.id) ??
      dock.addPanel({
        ...demo,
        position: reference
          ? { referencePanel: reference, direction: "within" }
          : undefined,
      });
    panel.api.setActive();
    dock.focus();
  }

  /** Restores the component and Properties panes while keeping global appearance choices. */
  function resetLayout() {
    if (!dock) return;
    dock.clear();
    // Dockview must finish queued overlay updates before these panel IDs are reused.
    requestAnimationFrame(() => {
      if (!dock || !dockHost.isConnected) return;
      dock.layout(dockHost.clientWidth, dockHost.clientHeight);
      const groupPanel = dock.addPanel({
        id: "groups",
        component: "groups",
        title: "Groups",
      });
      dock.addPanel({
        id: "flows",
        component: "flows",
        title: "Flows",
        position: { referencePanel: groupPanel, direction: "within" },
        inactive: true,
      });
      const propertiesPanel = dock.addPanel({
        id: "properties",
        component: "properties",
        title: "Properties",
        position: {
          referencePanel: groupPanel,
          direction: dockHost.clientWidth < 640 ? "below" : "right",
        },
        initialWidth: 285,
        initialHeight: 250,
      });
      if (dockHost.clientWidth >= 640)
        propertiesPanel.api.setSize({ width: 285 });
      groupPanel.api.setActive();
    });
  }

  /** Applies the shared theme above body-portaled selects and context menus. */
  onMount(() => {
    const previousAccent =
      document.documentElement.style.getPropertyValue("--accent");
    const previousRadius =
      document.documentElement.style.getPropertyValue("--nf-corner-radius");
    onCleanup(() => {
      if (previousAccent)
        document.documentElement.style.setProperty("--accent", previousAccent);
      else document.documentElement.style.removeProperty("--accent");
      if (previousRadius)
        document.documentElement.style.setProperty(
          "--nf-corner-radius",
          previousRadius,
        );
      else document.documentElement.style.removeProperty("--nf-corner-radius");
      closeContextMenu();
    });
  });
  /** Keeps the selected accent consistent in panel content and portaled overlays. */
  createEffect(() => {
    const value = accent().value;
    document.documentElement.style.setProperty("--accent", value);
    for (const popoutWindow of popoutWindows) {
      if (!popoutWindow.closed)
        popoutWindow.document.documentElement.style.setProperty(
          "--accent",
          value,
        );
    }
  });

  /** Shares the corner preference with panel content, body portals, and detached windows. */
  createEffect(() => {
    const radius = roundedCorners() ? "var(--nf-corner-radius-default)" : "0px";
    document.documentElement.style.setProperty("--nf-corner-radius", radius);
    for (const popoutWindow of popoutWindows) {
      if (!popoutWindow.closed)
        popoutWindow.document.documentElement.style.setProperty(
          "--nf-corner-radius",
          radius,
        );
    }
  });

  /** Applies tab alignment to the workspace, floating groups, and detached windows. */
  createEffect(() => {
    const alignment = tabAlignment();
    document.body.dataset.tabAlignment = alignment;
    for (const popoutWindow of popoutWindows) {
      if (!popoutWindow.closed)
        popoutWindow.document.body.dataset.tabAlignment = alignment;
    }
  });

  /** Keeps inactive panel accents consistent across the workspace and detached windows. */
  createEffect(() => {
    const enabled = String(muteUnfocusedAccents());
    document.body.dataset.muteUnfocusedAccents = enabled;
    for (const popoutWindow of popoutWindows) {
      if (!popoutWindow.closed)
        popoutWindow.document.body.dataset.muteUnfocusedAccents = enabled;
    }
  });

  /** Opens shared context-menu commands for one sample object. */
  function showTileMenu(
    sample: Sample,
    event: { clientX: number; clientY: number; preventDefault: () => void },
  ) {
    event.preventDefault();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { type: "heading", id: "heading", label: sample.name },
        {
          id: "inspect",
          label: "Inspect properties",
          checked: selected() === sample,
          onSelect: () => {
            setSelected(sample);
            dock?.getPanel("properties")?.api.setActive();
          },
        },
        {
          type: "submenu",
          id: "accent",
          label: "Accent color",
          items: accents.map((option) => ({
            id: option.name,
            label: option.name,
            checked: accent().name === option.name,
            onSelect: () => setAccent(option),
          })),
        },
        { type: "separator", id: "separator" },
        {
          id: "live",
          label: "Send to live output",
          disabled: true,
          onSelect: () => undefined,
        },
        {
          id: "hide",
          label: "Hide tile",
          danger: true,
          onSelect: () => {
            setHiddenTiles((current) => [...current, sample]);
            showNotice(`Hidden ${sample.name} from this preview`);
          },
        },
        {
          id: "restore",
          label: "Restore hidden tiles",
          disabled: hiddenTiles().length === 0,
          onSelect: () => setHiddenTiles([]),
        },
      ],
    });
  }

  /** Demonstrates shared Preline single and searchable multi-select widgets. */
  function Selects() {
    const [mode, setMode] = createSignal<readonly string[]>(["manual"]);
    const [zones, setZones] = createSignal<readonly string[]>([
      "left",
      "right",
    ]);
    const zoneOptions = [
      { value: "left", label: "Stage left" },
      { value: "right", label: "Stage right" },
      { value: "front", label: "Downstage" },
      { value: "rear", label: "Upstage" },
      { value: "overhead", label: "Overhead" },
    ];
    return (
      <section class="properties lab-panel" aria-label="Select examples">
        <div class="eyebrow">SHARED WIDGETS</div>
        <h2>Choose one. Or several.</h2>
        <div class="property-section demo-select">
          <div class="section-label">Trigger mode</div>
          <PrelineAdvancedSelect
            options={[
              { value: "manual", label: "Manual" },
              { value: "previous", label: "After previous" },
              { value: "timecode", label: "Timecode" },
            ]}
            selectedValues={mode()}
            onSelectedValuesChange={setMode}
            ariaLabel="Trigger mode"
          />
          <p class="field-help">
            One value. Keyboard navigation and a custom menu.
          </p>
        </div>
        <div class="property-section demo-select">
          <div class="section-label">Fixture zones</div>
          <PrelineAdvancedSelect
            options={zoneOptions}
            selectedValues={zones()}
            onSelectedValuesChange={setZones}
            ariaLabel="Fixture zones"
            multiple
            searchable
          />
          <p class="field-help" role="status">
            {zones().length} zones selected
          </p>
          <div class="selected-tags">
            <For
              each={zoneOptions.filter((option) =>
                zones().includes(option.value),
              )}
            >
              {(option) => <span>{option.label}</span>}
            </For>
          </div>
        </div>
      </section>
    );
  }

  /** Demonstrates the same menu primitives through dropdown and context-menu interactions. */
  function Menus() {
    const [checked, setChecked] = createSignal(true);
    const [lastAction, setLastAction] = createSignal("No action selected");
    return (
      <section class="properties lab-panel" aria-label="Context menu examples">
        <div class="eyebrow">MENUS</div>
        <h2>Actions in context.</h2>
        <div class="property-section">
          <div class="section-label">Context menu</div>
          <Button
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              showTileMenu(selected(), {
                clientX: rect.left,
                clientY: rect.bottom + 4,
                preventDefault: () => undefined,
              });
            }}
          >
            Object actions
          </Button>
          <p class="field-help">
            Also available on tiles and cue cells with right-click. Includes
            nested, checked, disabled, and destructive items.
          </p>
        </div>
        <div class="property-section">
          <div class="section-label">Dropdown menu</div>
          <DropdownMenu
            trigger={<span class="nf-button">Menu actions</span>}
            triggerLabel="Menu actions"
            placement="below"
          >
            <MenuHeading>Shared menu components</MenuHeading>
            <DropdownMenuItem
              icon={ArrowRightIcon}
              shortcut="↵"
              onClick={() => setLastAction("Opened selection")}
            >
              Open selection
            </DropdownMenuItem>
            <DropdownMenuItem
              checked={checked()}
              onClick={() => setChecked((value) => !value)}
            >
              Show details
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled
              onClick={() => setLastAction("Unavailable action")}
            >
              Unavailable action
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              onClick={() => setLastAction("Removed selection")}
            >
              Remove selection
            </DropdownMenuItem>
          </DropdownMenu>
          <p class="field-help" role="status">
            {lastAction()}
          </p>
        </div>
        <div
          class="menu-demo-target"
          onContextMenu={(event) => showTileMenu(selected(), event)}
        >
          Right-click here to explore nested, checked, disabled, and destructive
          actions.
        </div>
      </section>
    );
  }

  /** Renders readable, selectable tiles with separate identity, title, and metadata. */
  function Library(props: { kind: "group" | "flow" }) {
    const samples = props.kind === "group" ? groups : flows;
    const [query, setQuery] = createSignal("");
    /** Filters visible sample tiles while retaining independent searches per library. */
    const visibleSamples = createMemo(() =>
      samples.filter(
        (sample) =>
          !hiddenTiles().includes(sample) &&
          sample.name.toLowerCase().includes(query().toLowerCase()),
      ),
    );
    return (
      <section
        class="library lab-panel"
        aria-label={props.kind === "group" ? "Group library" : "Flow library"}
      >
        <div class="panel-toolbar">
          <span class="toolbar-title">
            {props.kind === "group" ? "Fixture groups" : "Flow library"}{" "}
            <span class="count">{samples.length}</span>
          </span>
          <InputGroup class="search h-8">
            <MagnifyingGlassIcon size={16} />
            <Input
              density="compact"
              aria-label={`Search ${props.kind}s`}
              placeholder="Search"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </InputGroup>
        </div>
        <div class="tile-grid">
          <For each={visibleSamples()}>
            {(sample) => (
              <ObjectTile
                identity={`${props.kind === "flow" ? "FLOW" : "GRP"} ${String(sample.id).padStart(2, "0")}`}
                title={sample.name}
                detail={sample.detail}
                tags={sample.tags}
                selected={selected() === sample}
                onSelect={() => setSelected(sample)}
                onContextMenu={(event) => showTileMenu(sample, event)}
                onKeyDown={(event) => {
                  if (
                    event.key === "ContextMenu" ||
                    (event.shiftKey && event.key === "F10")
                  ) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    showTileMenu(sample, {
                      clientX: rect.left,
                      clientY: rect.bottom,
                      preventDefault: () => event.preventDefault(),
                    });
                  }
                }}
              />
            )}
          </For>
          <Show when={visibleSamples().length === 0}>
            <p class="empty">
              No visible matches. Try another search or restore hidden tiles.
            </p>
          </Show>
        </div>
        <div class="panel-footnote">
          Select a tile · Right-click for actions{" "}
          <span>Hover for full names and details</span>
        </div>
      </section>
    );
  }

  /** Keeps global appearance and layout controls available beside the active component demo. */
  function Properties() {
    return (
      <section
        class="design-properties lab-panel"
        aria-label="Design properties"
      >
        <div class="control-group">
          <AccentPicker value={accent().value} onChange={setAccent} />
        </div>
        <div class="control-group">
          <ToggleSwitch
            ariaLabel="Mute accents in unfocused panels"
            label="Mute accents in unfocused panels"
            checked={muteUnfocusedAccents()}
            onChange={setMuteUnfocusedAccents}
          />
        </div>
        <div class="control-group">
          <h2>Density</h2>
          <div class="segmented">
            <Button aria-pressed={!compact()} onClick={() => setCompact(false)}>
              Comfort
            </Button>
            <Button aria-pressed={compact()} onClick={() => setCompact(true)}>
              Compact
            </Button>
          </div>
        </div>
        <div class="control-group corner-control">
          <ToggleSwitch
            ariaLabel="Rounded corners"
            label="Rounded corners"
            checked={roundedCorners()}
            onChange={setRoundedCorners}
          />
        </div>
        <Button class="text-button reset-layout" onClick={resetLayout}>
          <ArrowCounterClockwiseIcon size={14} />
          Reset layout
        </Button>
      </section>
    );
  }

  return (
    <div
      class="design-lab"
      classList={{ compact: compact() }}
      style={{ "--accent": accent().value }}
    >
      <GlobalContextMenuHost />
      <header class="masthead">
        <a class="brand" href="/design-lab.html">
          <span class="brand-mark" aria-hidden="true">
            n<span>.</span>
          </span>
          nightfall
          <span class="brand-divider" />{" "}
          <span class="brand-context">Design lab</span>
        </a>
        <span class="edition">
          VISUAL LANGUAGE <b>01</b>
        </span>
      </header>
      <div class="lab-layout">
        <aside class="design-controls" aria-label="Design controls">
          <ComponentIndex
            demos={componentDemos}
            activeDemo={activeDemo()}
            onOpen={openDemo}
          />
        </aside>
        <main>
          <DockviewHost
            tabPosition={tabPosition()}
            class="workspace"
            ariaLabel="Interactive dock workspace"
            options={{ theme: visualLanguageDockTheme }}
            components={{
              groups: () => <Library kind="group" />,
              flows: () => <Library kind="flow" />,
              properties: Properties,
              selects: Selects,
              inputForms: InputFormsDemo,
              commandPalette: CommandPaletteDemo,
              shortcuts: () => (
                <ShortcutsDemo compact={compact()} accentName={accent().name} />
              ),
              menus: Menus,
              sliders: SliderDemo,
              switches: SwitchDemo,
              faders: FaderDemo,
              attributes: AttributeDemo,
              objectSelector: ObjectSelectorDemo,
              inlineRename: InlineRenameDemo,
              sparklines: SparklineDemo,
              tooltips: TooltipDemo,
              colorPicker: ColorPickerDemo,
              buttons: ButtonDemo,
              toolbars: ToolbarDemo,
              popups: () => (
                <PopupDemo
                  onFloat={() => void openDetachedPreview(false)}
                  onPopout={() => void openDetachedPreview(true)}
                />
              ),
              detachedPreview: () => (
                <PopoutPreview
                  onClose={() =>
                    dock?.getPanel("detached-preview")?.api.close()
                  }
                />
              ),
              toasts: ToastDemo,
              animations: AnimationsDemo,
              docking: () => (
                <DockingDemo
                  position={tabPosition()}
                  onPosition={setTabPosition}
                  alignment={tabAlignment()}
                  onAlignment={setTabAlignment}
                  onReset={resetLayout}
                />
              ),
              dataGrid: () => (
                <DataGridDemo
                  compact={compact()}
                  columnGuides={gridLines()}
                  onColumnGuides={setGridLines}
                  onNotice={showNotice}
                />
              ),
            }}
            onReady={(api, element) => {
              dock = api;
              dockHost = element;
              const activeSubscription = api.onDidActivePanelChange((panel) =>
                setActiveDemo(panel.panel?.id),
              );
              /** Captures panel positions, sizes, and active tabs for this browser session. */
              const saveSessionLayout = () => {
                try {
                  sessionStorage.setItem(
                    SESSION_LAYOUT_KEY,
                    JSON.stringify(api.toJSON()),
                  );
                } catch (error) {
                  log.warn("Failed to save design lab session layout", error);
                }
              };
              let restored = false;
              try {
                const saved = sessionStorage.getItem(SESSION_LAYOUT_KEY);
                if (saved) {
                  api.fromJSON(JSON.parse(saved));
                  restored = true;
                }
              } catch (error) {
                log.warn("Failed to restore design lab session layout", error);
              }
              const layoutSubscription =
                api.onDidLayoutChange(saveSessionLayout);
              /** Flushes pending layout changes before the host disposes its panels. */
              onCleanup(() => {
                saveSessionLayout();
                layoutSubscription.dispose();
                activeSubscription.dispose();
              });
              if (!restored) resetLayout();
            }}
          />
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById("design-lab");
let disposed = false;
let disposeDesignLab: (() => void) | undefined;

/** Releases global shortcuts and dock resources before Vite replaces this module. */
import.meta.hot?.dispose(() => {
  disposed = true;
  disposeDesignLab?.();
});

if (root) {
  void initializePrelineRuntime()
    .then(() => {
      if (disposed) return;
      disposeDesignLab = render(
        () => (
          <ShellOverlayCoordinatorProvider>
            <CommandPaletteProvider>
              <DesignLab />
            </CommandPaletteProvider>
          </ShellOverlayCoordinatorProvider>
        ),
        root,
      );
    })
    .catch((error: unknown) => {
      if (disposed) return;
      log.error("Failed to initialize design lab", error);
      root.textContent =
        "The design lab could not load its controls. Reload to try again.";
    });
}
