// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  clamp,
  Fn,
  float,
  If,
  ivec2,
  select,
  textureLoad,
  uniform,
  vec2,
  vec4,
} from "three/tsl";
import {
  BoxGeometry,
  type Camera,
  type Color,
  DepthTexture,
  FloatType,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PerspectiveCamera,
  RendererUtils,
  RenderTarget,
  Scene,
  Vector2,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type WebGPURenderer,
} from "three/webgpu";

/** Generic projector state; fixture identity and DMX interpretation stay outside shadow rendering. */
export interface OpticalShadowSource {
  /**
   * Small pool-assigned key identifying this source in shaders; 0 while unregistered.
   * Keys stay exact in float attributes and textures, unlike scene object IDs.
   */
  shadowKey: number;
  visible: boolean;
  position: Vector3;
  apertureRight: Vector3;
  apertureUp: Vector3;
  apertureForward: Vector3;
  optics: { radius: number; slopeX: number; slopeY: number };
  beamLength: number;
  intensity: number;
  color: Color;
}

/** A fixed pair of maps bounds memory and shader sampling independently of emitter count. */
const SHADOW_MAP_COUNT = 2;
/**
 * Refresh cycles (one refresh per slot each) a map may miss before it expires. Maps
 * outlive routine cadence jitter and readback latency, but stale occluders are bounded.
 */
const MAP_AGE_REFRESH_CYCLES = 5;
const SHADOW_MAP_SIZE = 512;
/**
 * Depth comparisons happen in metres along the projector axis: non-linear depth
 * compresses at stage throws, so a fixed depth-buffer bias would hide occluders
 * metres in front of a distant receiver.
 */
const SHADOW_DEPTH_BIAS_METRES = 0.02;
/** Extra bias per shadow-map texel footprint, absorbing sloped-receiver acne at any throw. */
const SHADOW_SLOPE_BIAS_TEXELS = 1.5;
// Depth textures use [0, 1] on both backends; WebGL clip coordinates use [-1, 1].
const WEBGL_DEPTH_TO_TEXTURE = new Matrix4().set(
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0.5,
  0.5,
  0,
  0,
  0,
  1,
);

/** Creates a reusable map and its shader-visible pose without allocating during playback. */
function createShadowSlot() {
  const target = new RenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  target.texture.name = "optical-shadow";
  target.depthTexture = new DepthTexture(
    SHADOW_MAP_SIZE,
    SHADOW_MAP_SIZE,
    FloatType,
  );
  const camera = new PerspectiveCamera(45, 1, 0.02, 40);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  return {
    target,
    camera,
    source: undefined as OpticalShadowSource | undefined,
    /** Shadow key of the source whose map is currently valid; 0 disables sampling. */
    key: uniform(0),
    projection: uniform(new Matrix4()),
    /** Projector near/far planes, for recovering metric distance from stored depth. */
    depthRange: uniform(new Vector2(0.02, 40)),
    /** World-space width of one map texel per metre of distance from the projector. */
    texelSlope: uniform(0),
    position: new Vector3(),
    right: new Vector3(),
    up: new Vector3(),
    forward: new Vector3(),
    radius: 0,
    slopeX: 0,
    slopeY: 0,
    beamLength: 0,
    refreshedAt: -Infinity,
  };
}

/** One reusable depth map, its projector camera, and the pose it was rendered from. */
export type ShadowSlot = ReturnType<typeof createShadowSlot>;

/** Shares bounded, selectively refreshed visibility maps between surface and atmospheric shaders. */
export class OpticalShadowPool {
  private readonly sources = new Set<OpticalShadowSource>();
  private readonly slots = Array.from(
    { length: SHADOW_MAP_COUNT },
    createShadowSlot,
  );
  private readonly depthMaterial = new MeshBasicNodeMaterial({
    colorWrite: false,
    lights: false,
  });
  private readonly inverseBasis = new Matrix4();
  private readonly direction = new Vector3();
  private readonly corner = new Vector3();
  private readonly targetPosition = new Vector3();
  private readonly viewPosition = new Vector3();
  private readonly selected: Array<OpticalShadowSource | undefined> = new Array(
    SHADOW_MAP_COUNT,
  );
  private readonly scores = new Float64Array(SHADOW_MAP_COUNT);
  private readonly freeKeys: number[] = [];
  private keyCount = 0;
  private disposed = false;

  /** Allocates maps and compiles ordinary and instanced depth pipelines before the render loop starts. */
  async prepare(renderer: WebGPURenderer): Promise<void> {
    const saved = RendererUtils.saveRendererState(renderer);
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const mesh = new Mesh(geometry, this.depthMaterial);
    const instances = new InstancedMesh(geometry, this.depthMaterial, 1);
    const camera = this.slots[0].camera;
    camera.position.z = 2;
    camera.lookAt(0, 0, 0);
    scene.add(mesh, instances);
    try {
      RendererUtils.resetRendererState(renderer, saved);
      for (const slot of this.slots) renderer.initRenderTarget(slot.target);
      renderer.setRenderTarget(this.slots[0].target);
      await renderer.compileAsync(scene, camera);
    } finally {
      RendererUtils.restoreRendererState(renderer, saved);
      instances.dispose();
      geometry.dispose();
    }
  }

  /**
   * Registers persistent emitter state and assigns it the smallest free shadow key;
   * changing its fields never allocates another map.
   */
  register(source: OpticalShadowSource): void {
    if (this.sources.has(source)) return;
    this.sources.add(source);
    source.shadowKey = this.freeKeys.pop() ?? ++this.keyCount;
  }

  /**
   * Immediately invalidates removed emitters and recycles their key; a recycled
   * key or map can therefore never shadow another source with stale depth.
   */
  unregister(source: OpticalShadowSource): void {
    if (!this.sources.delete(source)) return;
    for (const slot of this.slots)
      if (slot.source === source) {
        slot.source = undefined;
        slot.key.value = 0;
      }
    // Reuse keeps keys bounded by the peak number of registered sources.
    this.freeKeys.push(source.shadowKey);
    source.shadowKey = 0;
  }

  /** Reports whether shaders currently sample a map for this source. */
  hasValidMap(source: OpticalShadowSource): boolean {
    return this.slots.some(
      (slot) => slot.source === source && slot.key.value > 0,
    );
  }

  /** Builds a shared visibility expression; emitters without a valid map (key 0 included) remain unshadowed. */
  sample(worldPosition: Node<"vec3">, shadowKey: Node<"float">): Node<"float"> {
    return Fn(() => {
      const visibility = float(1).toVar();
      for (const slot of this.slots) {
        If(slot.key.greaterThan(0).and(shadowKey.equal(slot.key)), () => {
          const clip = slot.projection.mul(vec4(worldPosition, 1));
          const ndc = clip.xyz.div(clip.w);
          const uv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
          const inside = clip.w
            .greaterThan(0)
            .and(uv.x.greaterThanEqual(0))
            .and(uv.x.lessThanEqual(1))
            .and(uv.y.greaterThanEqual(0))
            .and(uv.y.lessThanEqual(1))
            .and(ndc.z.greaterThanEqual(0))
            .and(ndc.z.lessThanEqual(1));
          If(inside, () => {
            const depth = textureLoad(
              slot.target.depthTexture!,
              ivec2(clamp(uv.mul(SHADOW_MAP_SIZE), 0, SHADOW_MAP_SIZE - 1)),
            ).r;
            // Both backends store [0, 1] perspective depth; invert it to metres along the axis.
            const near = slot.depthRange.x;
            const far = slot.depthRange.y;
            const occluder = near
              .mul(far)
              .div(far.sub(depth.mul(far.sub(near))));
            // Perspective clip w is the receiver's distance along the same axis.
            const receiver = clip.w;
            const bias = float(SHADOW_DEPTH_BIAS_METRES).add(
              receiver.mul(slot.texelSlope).mul(SHADOW_SLOPE_BIAS_TEXELS),
            );
            visibility.assign(
              select(
                receiver.lessThanEqual(occluder.add(bias)),
                float(1),
                float(0),
              ),
            );
          });
        });
      }
      return visibility;
    })();
  }

  /**
   * Refreshes at most one map; callers can deny optional work when their frame budget is exhausted.
   *
   * Maps expire after several missed refresh cycles at the caller's current cadence,
   * so routine scheduling never lets them lapse. A source whose pose or optics changed
   * keeps sampling its slightly stale map and is refreshed ahead of unchanged sources.
   */
  update(
    renderer: WebGPURenderer,
    scene: Scene,
    viewCamera: Camera,
    now: number,
    allowRefresh: boolean,
    refreshIntervalMs: number,
  ): number {
    if (this.disposed) return 0;
    const selected = this.selected;
    selected.fill(undefined);
    this.scores.fill(-Infinity);
    viewCamera.getWorldPosition(this.viewPosition);
    for (const source of this.sources) {
      if (!source.visible || source.intensity <= 0) continue;
      const luminance = Math.max(
        source.color.r,
        source.color.g,
        source.color.b,
      );
      const retained = this.slots.some((slot) => slot.source === source)
        ? 1.25
        : 1;
      const score =
        (retained * source.intensity * luminance) /
        Math.max(1, source.position.distanceToSquared(this.viewPosition));
      if (!Number.isFinite(score) || score <= 0) continue;
      for (let i = 0; i < SHADOW_MAP_COUNT; i++) {
        if (
          score < this.scores[i] ||
          (score === this.scores[i] &&
            source.shadowKey > selected[i]!.shadowKey)
        )
          continue;
        for (let j = SHADOW_MAP_COUNT - 1; j > i; j--) {
          selected[j] = selected[j - 1];
          this.scores[j] = this.scores[j - 1];
        }
        selected[i] = source;
        this.scores[i] = score;
        break;
      }
    }
    // One full cycle refreshes every slot once at the caller's cadence.
    const cycleMs = Math.max(0, refreshIntervalMs) * SHADOW_MAP_COUNT;
    for (const slot of this.slots) {
      if (!slot.source || !selected.includes(slot.source)) {
        slot.source = undefined;
        slot.key.value = 0;
      }
      if (now - slot.refreshedAt > cycleMs * MAP_AGE_REFRESH_CYCLES)
        slot.key.value = 0;
    }
    for (const source of selected) {
      if (!source) continue;
      if (this.slots.some((slot) => slot.source === source)) continue;
      const slot = this.slots.find((entry) => !entry.source)!;
      slot.source = source;
      slot.key.value = 0;
      slot.refreshedAt = -Infinity;
    }
    if (!allowRefresh) return 0;
    let slot: ShadowSlot | undefined;
    let slotPriority = Infinity;
    for (const entry of this.slots) {
      if (!entry.source) continue;
      // Moved sources count as one cycle older, without starving unchanged ones.
      const priority =
        entry.refreshedAt - (this.poseChanged(entry) ? cycleMs : 0);
      if (!slot || priority < slotPriority) {
        slot = entry;
        slotPriority = priority;
      }
    }
    if (!slot) return 0;
    const source = slot.source!;
    if (!this.fitCamera(slot.camera, source)) {
      // Degenerate apertures stay unshadowed and wait their turn instead of monopolizing refreshes.
      slot.key.value = 0;
      slot.refreshedAt = now;
      return 0;
    }
    this.renderMap(renderer, scene, slot);
    slot.projection.value.multiplyMatrices(
      slot.camera.projectionMatrix,
      slot.camera.matrixWorldInverse,
    );
    if (slot.camera.coordinateSystem === WebGLCoordinateSystem)
      slot.projection.value.premultiply(WEBGL_DEPTH_TO_TEXTURE);
    slot.depthRange.value.set(slot.camera.near, slot.camera.far);
    const halfHeight = Math.tan((slot.camera.fov * Math.PI) / 360);
    slot.texelSlope.value =
      (2 * halfHeight * Math.max(1, slot.camera.aspect)) / SHADOW_MAP_SIZE;
    slot.key.value = source.shadowKey;
    slot.position.copy(source.position);
    slot.right.copy(source.apertureRight);
    slot.up.copy(source.apertureUp);
    slot.forward.copy(source.apertureForward);
    slot.radius = source.optics.radius;
    slot.slopeX = source.optics.slopeX;
    slot.slopeY = source.optics.slopeY;
    slot.beamLength = source.beamLength;
    slot.refreshedAt = now;
    return 1;
  }

  /** Detects pose or optics changes since the slot's map was rendered. */
  private poseChanged(slot: ShadowSlot): boolean {
    const source = slot.source;
    return (
      !!source &&
      (!slot.position.equals(source.position) ||
        !slot.right.equals(source.apertureRight) ||
        !slot.up.equals(source.apertureUp) ||
        !slot.forward.equals(source.apertureForward) ||
        slot.radius !== source.optics.radius ||
        slot.slopeX !== source.optics.slopeX ||
        slot.slopeY !== source.optics.slopeY ||
        slot.beamLength !== source.beamLength)
    );
  }

  /** Renders opaque stage occluders into a slot's depth map from its fitted projector camera. */
  protected renderMap(
    renderer: WebGPURenderer,
    scene: Scene,
    slot: ShadowSlot,
  ): void {
    const savedRenderer = RendererUtils.saveRendererState(renderer);
    const savedScene = RendererUtils.saveSceneState(scene);
    RendererUtils.resetRendererState(renderer, savedRenderer);
    RendererUtils.resetSceneState(scene, savedScene);
    try {
      scene.overrideMaterial = this.depthMaterial;
      renderer.setRenderTarget(slot.target);
      renderer.setRenderObjectFunction(
        (
          object,
          renderScene,
          camera,
          geometry,
          material,
          group,
          lights,
          clipping,
        ) => {
          if (
            !(object instanceof Mesh) ||
            object.userData.visualizerOutlineOnly === true
          )
            return;
          const original = Array.isArray(object.material)
            ? object.material[group?.materialIndex ?? 0]
            : object.material;
          // Emissive lenses and transparent effects do not act as opaque stage occluders.
          if (
            !original ||
            original.transparent ||
            original.opacity <= 0 ||
            (original as { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial
          )
            return;
          renderer.renderObject(
            object,
            renderScene,
            camera,
            geometry,
            material,
            group,
            lights,
            clipping,
          );
        },
      );
      renderer.render(scene, slot.camera);
    } finally {
      RendererUtils.restoreRendererState(renderer, savedRenderer);
      RendererUtils.restoreSceneState(scene, savedScene);
    }
  }

  /** Fits arbitrary affine prism rays conservatively, including rectangular and asymmetric apertures. */
  private fitCamera(
    camera: PerspectiveCamera,
    source: OpticalShadowSource,
  ): boolean {
    const r = source.apertureRight,
      u = source.apertureUp,
      f = source.apertureForward;
    this.inverseBasis.set(
      r.x,
      r.y,
      r.z,
      0,
      u.x,
      u.y,
      u.z,
      0,
      f.x,
      f.y,
      f.z,
      0,
      0,
      0,
      0,
      1,
    );
    if (Math.abs(this.inverseBasis.determinant()) < 1e-8) return false;
    this.inverseBasis.invert();
    this.direction.set(0, 0, 1).transformDirection(this.inverseBasis);
    camera.position.copy(source.position);
    camera.up.set(0, 1, 0).transformDirection(this.inverseBasis);
    camera.lookAt(
      this.targetPosition.copy(source.position).add(this.direction),
    );
    camera.updateMatrixWorld(true);
    let sx = 0,
      sy = 0,
      far = 0;
    for (const x of [-1, 1])
      for (const y of [-1, 1]) {
        this.corner
          .set(
            x *
              2 *
              (source.optics.radius + source.optics.slopeX * source.beamLength),
            y *
              2 *
              (source.optics.radius + source.optics.slopeY * source.beamLength),
            source.beamLength,
          )
          .applyMatrix4(this.inverseBasis)
          .add(source.position)
          .applyMatrix4(camera.matrixWorldInverse);
        if (this.corner.z >= -0.02) return false;
        sx = Math.max(sx, Math.abs(this.corner.x / this.corner.z));
        sy = Math.max(sy, Math.abs(this.corner.y / this.corner.z));
        far = Math.max(far, -this.corner.z);
      }
    camera.fov = Math.min(
      175,
      Math.max(1, (2 * Math.atan(sy) * 180) / Math.PI),
    );
    camera.aspect = Math.max(0.01, sx / Math.max(sy, 0.0001));
    camera.far = far + 1;
    camera.updateProjectionMatrix();
    return true;
  }

  /** Releases all fixed render targets and prevents subsequent GPU work. */
  dispose(): void {
    this.disposed = true;
    this.sources.clear();
    for (const slot of this.slots) {
      slot.key.value = 0;
      slot.target.dispose();
    }
    this.depthMaterial.dispose();
  }
}
