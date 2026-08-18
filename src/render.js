import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

// Live cells are drawn as one InstancedMesh of cubes. Matrices and colors are
// rebuilt on simulation ticks only; the per-frame audio reaction rides on
// material and camera uniforms, which cost nothing per cell.

const MAX_INSTANCES = 150000;

export class VoxelRenderer {
    constructor(canvas, n) {
        this.canvas = canvas;
        this.n = n;

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x07070c);
        this.scene.fog = new THREE.Fog(0x07070c, n * 1.6, n * 4.5);

        this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
        this.camera.position.set(n * 1.1, n * 0.85, n * 1.35);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.07;
        this.controls.target.set(0, 0, 0);

        this.scene.add(new THREE.HemisphereLight(0x88aaff, 0x191024, 1.1));
        const key = new THREE.DirectionalLight(0xffffff, 1.4);
        key.position.set(1, 1.4, 0.8);
        this.scene.add(key);
        const rim = new THREE.DirectionalLight(0xff5599, 0.6);
        rim.position.set(-1, -0.6, -0.9);
        this.scene.add(rim);

        this.material = new THREE.MeshStandardMaterial({
            roughness: 0.42,
            metalness: 0.12,
            emissive: new THREE.Color(0x224466),
            emissiveIntensity: 0.2,
        });

        this.mesh = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            this.material,
            Math.min(n * n * n, MAX_INSTANCES),
        );
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false; // instances move every tick
        this.mesh.count = 0;
        this.scene.add(this.mesh);
        // Allocates the instanceColor buffer so per-cell colors can be written.
        this.mesh.setColorAt(0, new THREE.Color(0xffffff));

        this.bounds = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(n, n, n)),
            new THREE.LineBasicMaterial({ color: 0x2a3350 }),
        );
        this.scene.add(this.bounds);

        this._dummy = new THREE.Object3D();
        this._color = new THREE.Color();
        this._tint = new THREE.Color();
        this.drawn = 0;
        this.occlusionCull = true;

        this.resize();
    }

    // Rebuilding for a different lattice size means new geometry extents and a
    // new instance capacity, so the old mesh is thrown away.
    setLatticeSize(n) {
        if (n === this.n) return;
        this.scene.remove(this.mesh, this.bounds);
        this.mesh.geometry.dispose();
        this.mesh.dispose();
        this.bounds.geometry.dispose();
        this.bounds.material.dispose();

        this.n = n;
        this.scene.fog = new THREE.Fog(0x07070c, n * 1.6, n * 4.5);
        this.camera.position.setLength(n * 1.9);

        this.mesh = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            this.material,
            Math.min(n * n * n, MAX_INSTANCES),
        );
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false;
        this.mesh.count = 0;
        this.scene.add(this.mesh);
        this.mesh.setColorAt(0, new THREE.Color(0xffffff));

        this.bounds = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(n, n, n)),
            new THREE.LineBasicMaterial({ color: 0x2a3350 }),
        );
        this.scene.add(this.bounds);
    }

    // Called on simulation ticks. Walks live cells, skipping any that are fully
    // buried, and writes one instance each.
    syncLattice(lattice, visual) {
        const n = lattice.n;
        const cells = lattice.cells;
        const age = lattice.age;
        const wrap = lattice.wrap;
        const half = (n - 1) / 2;
        const scale = visual.voxelScale;
        const capacity = this.mesh.instanceMatrix.count;
        const dummy = this._dummy;
        const color = this._color;

        let k = 0;
        scan:
        for (let z = 0; z < n; z++) {
            for (let y = 0; y < n; y++) {
                const row = n * (y + n * z);
                for (let x = 0; x < n; x++) {
                    const i = row + x;
                    if (!cells[i]) continue;
                    if (this.occlusionCull && isBuried(cells, n, wrap, x, y, z)) continue;
                    if (k >= capacity) break scan; // lattice bigger than the instance cap

                    dummy.position.set(x - half, y - half, z - half);
                    dummy.scale.setScalar(scale);
                    dummy.updateMatrix();
                    this.mesh.setMatrixAt(k, dummy.matrix);

                    // Young cells read hot, old cells cool and settle.
                    const a = age[i] / 255;
                    color.setHSL(0.58 - Math.min(a * 6, 0.52), 0.75, 0.35 + Math.min(a * 3, 0.28));
                    this.mesh.setColorAt(k, color);
                    k++;
                }
            }
        }

        this.mesh.count = k;
        this.drawn = k;
        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    // Per-frame, per-scene reaction: no instance data is touched here.
    applyVisual(visual) {
        this._tint.setHSL((0.55 + visual.hueShift) % 1, 0.35, 0.62);
        this.material.color.copy(this._tint);
        this.material.emissiveIntensity = visual.emissive;
        this.camera.zoom = 1 + visual.dolly;
        this.camera.updateProjectionMatrix();
    }

    resize() {
        const width = this.canvas.clientWidth || window.innerWidth;
        const height = this.canvas.clientHeight || window.innerHeight;
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    render() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

// A cell with all six faces covered cannot be seen, so it is not worth an
// instance. On dense rules this removes most of the lattice.
function isBuried(cells, n, wrap, x, y, z) {
    return (
        neighborAlive(cells, n, wrap, x - 1, y, z) &&
        neighborAlive(cells, n, wrap, x + 1, y, z) &&
        neighborAlive(cells, n, wrap, x, y - 1, z) &&
        neighborAlive(cells, n, wrap, x, y + 1, z) &&
        neighborAlive(cells, n, wrap, x, y, z - 1) &&
        neighborAlive(cells, n, wrap, x, y, z + 1)
    );
}

function neighborAlive(cells, n, wrap, x, y, z) {
    if (wrap) {
        x = ((x % n) + n) % n;
        y = ((y % n) + n) % n;
        z = ((z % n) + n) % n;
    } else if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) {
        return false; // an exposed face at the bounds is still visible
    }
    return cells[x + n * (y + n * z)] === 1;
}
