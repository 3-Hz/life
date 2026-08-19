import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

// Live cells are drawn as one instanced draw call. Per tick the CPU writes five
// bytes per live cell -- lattice coordinate, age, neighbor count -- and nothing
// else. Placement, color, scale, ambient occlusion and fog are all resolved on
// the GPU, so the per-frame audio reaction costs a handful of uniform writes
// rather than a rebuild of every instance.
//
// Cell coordinates travel as unsigned bytes, which caps the lattice at 255^3 and
// keeps the per-tick upload four times smaller than float offsets would.

const VERTEX_SHADER = /* glsl */ `
    attribute vec4 aCell;  // xyz = lattice coordinate, w = age
    attribute vec2 aData;  // x = live neighbors 0-26, y = state (0 steady, 1 born, 2 dying)

    uniform float uScale;
    uniform float uHalf;
    uniform float uPhase; // progress toward the next generation, 0-1

    varying float vAge;
    varying float vCount;
    varying float vDying;
    varying vec3 vNormal;
    varying float vDepth;

    void main() {
        vAge = aCell.w / 255.0;
        vCount = aData.x;
        vNormal = normalMatrix * normal;

        // Births grow in and deaths shrink away across the gap between
        // generations, so the lattice moves continuously instead of snapping
        // between frozen frames. Above one step per frame there is no gap left
        // to animate and phase saturates, which correctly makes this a no-op.
        float eased = uPhase * uPhase * (3.0 - 2.0 * uPhase);
        float born = step(0.5, aData.y) * step(aData.y, 1.5);
        float dying = step(1.5, aData.y);
        vDying = dying;
        float life = mix(1.0, eased, born) * mix(1.0, 1.0 - eased, dying);

        vec3 world = position * uScale * life + (aCell.xyz - uHalf);
        vec4 viewPos = modelViewMatrix * vec4(world, 1.0);
        vDepth = -viewPos.z;
        gl_Position = projectionMatrix * viewPos;
    }
`;

const FRAGMENT_SHADER = /* glsl */ `
    precision mediump float;

    uniform vec3 uYoung;
    uniform vec3 uOld;
    uniform vec3 uTint;
    uniform vec3 uFogColor;
    uniform vec3 uKeyDir;
    uniform float uEmissive;
    uniform float uFogNear;
    uniform float uFogFar;
    uniform float uAo;

    varying float vAge;
    varying float vCount;
    varying float vDying;
    varying vec3 vNormal;
    varying float vDepth;

    void main() {
        vec3 normal = normalize(vNormal);

        // Wrapped lambert: a single dot product, no specular BRDF. The fragment
        // cost is what hurts on tiled mobile GPUs, so this stays cheap.
        float key = dot(normal, uKeyDir) * 0.5 + 0.5;
        float rim = pow(1.0 - abs(normal.z), 3.0) * 0.4;

        // Age ramp, matching the old CPU-side HSL walk: saturates around 22
        // generations, so young cells read hot and settled ones cool.
        // A dying cell's age was already reset to zero by the rule pass, so it
        // would otherwise flash back to the young colour on its way out. Hold it
        // at the far end of the ramp instead: cells cool as they go.
        float age = clamp(vAge * 6.0, 0.0, 1.0);
        age = max(age, vDying);
        vec3 base = mix(uYoung, uOld, age) * uTint;

        // Ambient occlusion for free: the simulation already counted these
        // neighbors, and a crowded cell is a cell down in a crevice.
        float occlusion = 1.0 - (vCount / 26.0) * uAo;

        vec3 color = base * (0.22 + 0.78 * key) * occlusion;
        color += base * rim;
        color += base * uEmissive * (1.0 - age); // young cells glow

        float fog = clamp((vDepth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
        gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
    }
`;

const BACKGROUND = 0x07070c;

export class VoxelRenderer {
    constructor(canvas, n, { mobile = false } = {}) {
        this.canvas = canvas;
        this.n = n;
        this.mobile = mobile;

        this.renderer = new THREE.WebGLRenderer({
            canvas,
            // MSAA is disproportionately expensive on tiled mobile GPUs.
            antialias: !mobile,
            powerPreference: 'high-performance',
        });
        this.maxPixelRatio = mobile ? 1.5 : 2;
        this.pixelRatio = Math.min(window.devicePixelRatio, this.maxPixelRatio);
        this.renderer.setPixelRatio(this.pixelRatio);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(BACKGROUND);

        this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
        this.camera.position.set(n * 1.1, n * 0.85, n * 1.35);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.07;
        this.controls.target.set(0, 0, 0);
        // Panning slides the lattice off-centre with no easy way back, which is
        // the one camera gesture that only ever gets in the way here. Rotate
        // (one finger, left drag) and zoom (pinch, wheel) stay.
        this.controls.enablePan = false;

        // Palette carried over from the material this shader replaces, so the
        // app still reads as itself.
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            uniforms: {
                uScale: { value: 0.9 },
                uHalf: { value: (n - 1) / 2 },
                uPhase: { value: 1 },
                uYoung: { value: new THREE.Color().setHSL(0.58, 0.75, 0.35) },
                uOld: { value: new THREE.Color().setHSL(0.06, 0.75, 0.63) },
                uTint: { value: new THREE.Color(1, 1, 1) },
                uFogColor: { value: new THREE.Color(BACKGROUND) },
                uKeyDir: { value: new THREE.Vector3(1, 1.4, 0.8).normalize() },
                uEmissive: { value: 0.2 },
                uFogNear: { value: n * 1.6 },
                uFogFar: { value: n * 4.5 },
                uAo: { value: 0.55 },
            },
        });

        this.buildMesh(n);

        this.bounds = null;
        this.rebuildBounds(n);

        this.drawn = 0;
        // Permanent chrome covering part of the canvas. The canvas stays
        // full-bleed -- the lattice shows through the translucent panel -- so
        // the camera is told which part of it the viewer can actually see.
        this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
        this.resize();
    }

    //-------GEOMETRY-------
    buildMesh(n) {
        const capacity = n * n * n;
        this.cellData = new Uint8Array(capacity * 4); // x, y, z, age
        this.stateData = new Uint8Array(capacity * 2); // live neighbors, state

        const box = new THREE.BoxGeometry(1, 1, 1);
        const geometry = new THREE.InstancedBufferGeometry();
        geometry.index = box.index;
        geometry.attributes.position = box.attributes.position;
        geometry.attributes.normal = box.attributes.normal;

        this.cellAttribute = new THREE.InstancedBufferAttribute(this.cellData, 4);
        this.cellAttribute.setUsage(THREE.DynamicDrawUsage);
        this.stateAttribute = new THREE.InstancedBufferAttribute(this.stateData, 2);
        this.stateAttribute.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('aCell', this.cellAttribute);
        geometry.setAttribute('aData', this.stateAttribute);
        geometry.instanceCount = 0;

        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.frustumCulled = false; // instances move every tick
        this.scene.add(this.mesh);
    }

    // The rectangle the viewer can actually see: the canvas minus permanent
    // chrome. Everything about framing and centring is expressed against this
    // rather than against the canvas.
    freeRect(width = this.canvas.clientWidth || window.innerWidth,
             height = this.canvas.clientHeight || window.innerHeight) {
        const { top, right, bottom, left } = this.insets;
        const w = Math.max(1, width - left - right);
        const h = Math.max(1, height - top - bottom);
        return { width, height, w, h, cx: left + w / 2, cy: top + h / 2 };
    }

    setChromeInsets({ top = 0, right = 0, bottom = 0, left = 0 } = {}) {
        this.insets = { top, right, bottom, left };
        this.resize();
    }

    // Shifts the frustum, without scaling it, so the orbit target -- which is
    // the lattice centre, since controls.target is the origin -- lands in the
    // middle of the visible area instead of the middle of the canvas. Centring
    // on the canvas put the lattice 28px low behind a 55px dock.
    //
    // This deliberately ignores the panel, even when open: the offset then
    // depends only on permanent chrome, so nothing slides when the panel is
    // toggled, and nothing drifts while the lattice is being rotated.
    applyViewOffset(free) {
        this.camera.setViewOffset(
            free.width, free.height,
            free.width / 2 - free.cx,
            free.height / 2 - free.cy,
            free.width, free.height,
        );
    }

    // Distance is chosen so the lattice fits whichever axis of the *visible*
    // rectangle is narrower. Deriving it from lattice size alone -- as this once
    // did -- crops badly on a tall narrow screen: at a 0.46 aspect the cube
    // projected well outside the frame on both sides.
    frameLattice(free) {
        const radius = this.n * Math.sqrt(3) / 2; // corner-to-centre of the cube
        const vFov = THREE.MathUtils.degToRad(this.camera.fov);
        // The free rect subtends a smaller angle than the whole canvas; both of
        // its axes are measured against the canvas height, which is what the
        // vertical field of view is defined over.
        const halfAngle = Math.atan(Math.tan(vFov / 2) * Math.min(free.w, free.h) / free.height);
        const distance = radius / Math.sin(halfAngle) * 1.05;
        // Keep the viewer's angle, change only how far out we sit.
        this.camera.position.setLength(distance);
        this.controls.minDistance = distance * 0.25;
        this.controls.maxDistance = distance * 3;
    }

    rebuildBounds(n) {
        if (this.bounds) {
            this.scene.remove(this.bounds);
            this.bounds.geometry.dispose();
            this.bounds.material.dispose();
        }
        this.bounds = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(n, n, n)),
            new THREE.LineBasicMaterial({ color: 0x2a3350 }),
        );
        this.scene.add(this.bounds);
    }

    setLatticeSize(n) {
        if (n === this.n) return;
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();

        this.n = n;
        this.material.uniforms.uHalf.value = (n - 1) / 2;
        this.material.uniforms.uFogNear.value = n * 1.6;
        this.material.uniforms.uFogFar.value = n * 4.5;

        this.buildMesh(n);
        this.rebuildBounds(n);
    }

    setPixelRatio(ratio) {
        const clamped = Math.min(ratio, this.maxPixelRatio);
        if (clamped === this.pixelRatio) return;
        this.pixelRatio = clamped;
        this.renderer.setPixelRatio(clamped);
        this.resize();
    }

    //-------PER-TICK-------
    // The whole per-cell cost of a tick: six bytes each, no matrices, no color
    // conversion. Cells with all 26 neighbors alive are skipped -- they cannot
    // be seen, and the test is free because the simulation already counted them.
    //
    // Cells that died this step are emitted too, flagged so the shader can
    // shrink them away rather than blinking them out. That costs extra instances
    // in proportion to churn: about +12% on a rule that replaces a quarter of
    // itself each step, and nearly double on one that replaces everything.
    syncLattice(lattice) {
        const n = lattice.n;
        const cells = lattice.cells;
        const previous = lattice.previous;
        const age = lattice.age;
        const counts = lattice.counts;
        const cellData = this.cellData;
        const stateData = this.stateData;

        let k = 0;
        for (let z = 0; z < n; z++) {
            for (let y = 0; y < n; y++) {
                const row = n * (y + n * z);
                for (let x = 0; x < n; x++) {
                    const i = row + x;
                    const alive = cells[i];
                    const was = previous[i];
                    if (!alive && !was) continue;
                    const count = counts[i];
                    if (alive && count === 26) continue;

                    const o = k * 4;
                    cellData[o] = x;
                    cellData[o + 1] = y;
                    cellData[o + 2] = z;
                    cellData[o + 3] = age[i];

                    const s = k * 2;
                    stateData[s] = count;
                    stateData[s + 1] = alive ? (was ? 0 : 1) : 2; // steady / born / dying
                    k++;
                }
            }
        }

        this.drawn = k;
        this.mesh.geometry.instanceCount = k;
        this.cellAttribute.needsUpdate = true;
        this.stateAttribute.needsUpdate = true;
    }

    // Progress toward the next generation, so births and deaths animate across
    // the gap rather than snapping at the moment of the step.
    setPhase(phase) {
        this.material.uniforms.uPhase.value = phase;
    }

    //-------PER-FRAME-------
    // Uniforms only. Voxel scale used to be baked into every instance matrix,
    // which meant the audio reaction forced a full rebuild; now it is one float.
    applyVisual(visual) {
        const uniforms = this.material.uniforms;
        uniforms.uScale.value = visual.voxelScale;
        uniforms.uEmissive.value = visual.emissive;
        uniforms.uTint.value.setHSL((0.55 + visual.hueShift) % 1, 0.25, 0.72);
        const zoom = 1 + visual.dolly;
        if (this.camera.zoom !== zoom) {
            this.camera.zoom = zoom;
            this.camera.updateProjectionMatrix();
        }
    }

    resize() {
        const width = this.canvas.clientWidth || window.innerWidth;
        const height = this.canvas.clientHeight || window.innerHeight;
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        const free = this.freeRect(width, height);
        this.applyViewOffset(free); // also updates the projection matrix
        this.frameLattice(free);
    }

    // Reports whether the camera is still settling, so the loop can skip draws
    // once everything has come to rest.
    updateControls() {
        const before = this._cameraKey();
        this.controls.update();
        return before !== this._cameraKey();
    }

    _cameraKey() {
        const p = this.camera.position;
        return `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)},${this.camera.zoom.toFixed(4)}`;
    }

    render() {
        this.renderer.render(this.scene, this.camera);
    }
}
