// A 3D cellular automaton on an N x N x N lattice.
//
// This module is pure: no DOM, no three.js, no audio, no imports. That is
// deliberate -- it loads straight into node, which is how the rules get tested.

const MAX_NEIGHBORS = 26;

//-------RULES-------
// Bays' four-digit notation: survival min/max, birth min/max. "4555" survives
// on 4-5 neighbors and is born on exactly 5. Counts above 9 need the range
// form ("4-5/5-5"), since a single digit cannot express them.
export function parseRule(input) {
    if (typeof input !== 'string') throw new TypeError('rule must be a string');
    const text = input.trim();

    let parts;
    if (/^\d{4}$/.test(text)) {
        parts = [Number(text[0]), Number(text[1]), Number(text[2]), Number(text[3])];
    } else {
        const match = text.match(/^S?(\d+)(?:-(\d+))?\s*\/\s*B?(\d+)(?:-(\d+))?$/i);
        if (!match) throw new Error(`unparseable rule: ${input}`);
        const sMin = Number(match[1]);
        const bMin = Number(match[3]);
        parts = [sMin, match[2] === undefined ? sMin : Number(match[2]),
                 bMin, match[4] === undefined ? bMin : Number(match[4])];
    }

    const [sMin, sMax, bMin, bMax] = parts;
    for (const value of parts) {
        if (!Number.isInteger(value) || value < 0 || value > MAX_NEIGHBORS) {
            throw new Error(`rule bounds must be 0-${MAX_NEIGHBORS}: ${input}`);
        }
    }
    if (sMin > sMax) throw new Error(`survival min exceeds max: ${input}`);
    if (bMin > bMax) throw new Error(`birth min exceeds max: ${input}`);

    return { sMin, sMax, bMin, bMax };
}

// Round-trips through parseRule when every bound is a single digit.
export function formatRule(rule) {
    const { sMin, sMax, bMin, bMax } = rule;
    if ([sMin, sMax, bMin, bMax].every((v) => v < 10)) return `${sMin}${sMax}${bMin}${bMax}`;
    return `S${sMin}-${sMax}/B${bMin}-${bMax}`;
}

export const RULE_PRESETS = {
    '4555': 'Bays 4555',
    '5766': 'Bays 5766',
    '4-5/5-5': 'Clouds-ish',
    '5-7/6-8': 'Dense',
};

//-------LATTICE-------
export class Lattice {
    constructor(n, { wrap = true } = {}) {
        if (!Number.isInteger(n) || n < 3) throw new Error('lattice size must be an integer >= 3');
        this.n = n;
        this.wrap = wrap;
        this.size = n * n * n;

        this.cells = new Uint8Array(this.size);
        this.next = new Uint8Array(this.size);
        // Age drives color and scale in the renderer; the simulation never reads it.
        this.age = new Uint8Array(this.size);
        // Box sums stay under 27, so Uint8 is enough for every intermediate pass.
        this.counts = new Uint8Array(this.size);
        this._bufA = new Uint8Array(this.size);
        this._bufB = new Uint8Array(this.size);

        this.generation = 0;
    }

    index(x, y, z) {
        const n = this.n;
        return x + n * (y + n * z);
    }

    get(x, y, z) {
        return this.cells[this.index(x, y, z)];
    }

    set(x, y, z, value) {
        this.cells[this.index(x, y, z)] = value ? 1 : 0;
    }

    clear() {
        this.cells.fill(0);
        this.next.fill(0);
        this.age.fill(0);
        this.generation = 0;
    }

    population() {
        let total = 0;
        for (let i = 0; i < this.size; i++) total += this.cells[i];
        return total;
    }

    // Fills the lattice at random. Interior-biased so the first frame reads as a
    // cloud rather than a slab against the bounds.
    seedRandom(density, rng, { margin = 0 } = {}) {
        const n = this.n;
        this.clear();
        for (let z = margin; z < n - margin; z++) {
            for (let y = margin; y < n - margin; y++) {
                for (let x = margin; x < n - margin; x++) {
                    if (rng() < density) {
                        const i = this.index(x, y, z);
                        this.cells[i] = 1;
                        this.age[i] = 1;
                    }
                }
            }
        }
    }

    // What a beat calls: scatter live cells through a sphere. Returns how many
    // cells it actually brought to life.
    injectSphere(cx, cy, cz, radius, density, rng) {
        const n = this.n;
        const r2 = radius * radius;
        const lo = Math.floor(-radius);
        const hi = Math.ceil(radius);
        let born = 0;

        for (let dz = lo; dz <= hi; dz++) {
            for (let dy = lo; dy <= hi; dy++) {
                for (let dx = lo; dx <= hi; dx++) {
                    if (dx * dx + dy * dy + dz * dz > r2) continue;
                    let x = cx + dx, y = cy + dy, z = cz + dz;
                    if (this.wrap) {
                        x = ((x % n) + n) % n;
                        y = ((y % n) + n) % n;
                        z = ((z % n) + n) % n;
                    } else if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) {
                        continue;
                    }
                    if (rng() >= density) continue;
                    const i = this.index(x, y, z);
                    if (!this.cells[i]) born++;
                    this.cells[i] = 1;
                    this.age[i] = 1;
                }
            }
        }
        return born;
    }

    //-------NEIGHBOR COUNTING-------
    // The 3x3x3 box sum is separable, so three one-dimensional passes replace 26
    // loads per cell with about six. At N=48 that is the difference between 2.9M
    // and 700k reads a tick. countNeighborsNaive below is the reference the
    // tests check this against.
    computeCounts() {
        const n = this.n;
        const wrap = this.wrap;
        const cells = this.cells;
        const bufA = this._bufA;
        const bufB = this._bufB;
        const counts = this.counts;

        // Pass 1: sum along x.
        for (let z = 0; z < n; z++) {
            for (let y = 0; y < n; y++) {
                const row = n * (y + n * z);
                for (let x = 0; x < n; x++) {
                    let sum = cells[row + x];
                    if (x > 0) sum += cells[row + x - 1];
                    else if (wrap) sum += cells[row + n - 1];
                    if (x < n - 1) sum += cells[row + x + 1];
                    else if (wrap) sum += cells[row];
                    bufA[row + x] = sum;
                }
            }
        }

        // Pass 2: sum along y.
        for (let z = 0; z < n; z++) {
            const plane = n * n * z;
            for (let y = 0; y < n; y++) {
                const row = plane + n * y;
                const up = y > 0 ? row - n : (wrap ? plane + n * (n - 1) : -1);
                const down = y < n - 1 ? row + n : (wrap ? plane : -1);
                for (let x = 0; x < n; x++) {
                    let sum = bufA[row + x];
                    if (up >= 0) sum += bufA[up + x];
                    if (down >= 0) sum += bufA[down + x];
                    bufB[row + x] = sum;
                }
            }
        }

        // Pass 3: sum along z, then drop the cell itself out of its own box.
        const planeSize = n * n;
        for (let z = 0; z < n; z++) {
            const plane = planeSize * z;
            const back = z > 0 ? plane - planeSize : (wrap ? planeSize * (n - 1) : -1);
            const front = z < n - 1 ? plane + planeSize : (wrap ? 0 : -1);
            for (let i = 0; i < planeSize; i++) {
                let sum = bufB[plane + i];
                if (back >= 0) sum += bufB[back + i];
                if (front >= 0) sum += bufB[front + i];
                counts[plane + i] = sum - cells[plane + i];
            }
        }

        return counts;
    }

    // Reference implementation. Correctness oracle for computeCounts, not used
    // in the render path.
    countNeighborsNaive(x, y, z) {
        const n = this.n;
        let neighbors = 0;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    let nx = x + dx, ny = y + dy, nz = z + dz;
                    if (this.wrap) {
                        nx = ((nx % n) + n) % n;
                        ny = ((ny % n) + n) % n;
                        nz = ((nz % n) + n) % n;
                    } else if (nx < 0 || ny < 0 || nz < 0 || nx >= n || ny >= n || nz >= n) {
                        continue;
                    }
                    neighbors += this.cells[this.index(nx, ny, nz)];
                }
            }
        }
        return neighbors;
    }

    //-------STEP-------
    step(rule) {
        const { sMin, sMax, bMin, bMax } = rule;
        const counts = this.computeCounts();
        const cells = this.cells;
        const next = this.next;
        const age = this.age;

        for (let i = 0; i < this.size; i++) {
            const alive = cells[i];
            const c = counts[i];
            const survives = alive ? (c >= sMin && c <= sMax) : (c >= bMin && c <= bMax);
            next[i] = survives ? 1 : 0;
            if (!survives) age[i] = 0;
            else if (alive) age[i] = age[i] < 255 ? age[i] + 1 : 255;
            else age[i] = 1;
        }

        this.cells = next;
        this.next = cells;
        this.generation++;
        return this.cells;
    }
}
