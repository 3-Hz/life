// Zero-dependency tests: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lattice, parseRule, formatRule } from '../src/automata.js';
import { mulberry32 } from '../src/rng.js';

function randomLattice(n, wrap, seed, density = 0.3) {
    const lattice = new Lattice(n, { wrap });
    lattice.seedRandom(density, mulberry32(seed));
    return lattice;
}

//-------The load-bearing test: the fast path must match the obvious one-------
test('separable counts match the naive oracle, cell for cell', () => {
    for (const n of [3, 5, 8, 16]) {
        for (const wrap of [true, false]) {
            const lattice = randomLattice(n, wrap, n * 31 + (wrap ? 1 : 0));
            const counts = lattice.computeCounts();
            for (let z = 0; z < n; z++) {
                for (let y = 0; y < n; y++) {
                    for (let x = 0; x < n; x++) {
                        assert.equal(
                            counts[lattice.index(x, y, z)],
                            lattice.countNeighborsNaive(x, y, z),
                            `mismatch at ${x},${y},${z} (n=${n}, wrap=${wrap})`,
                        );
                    }
                }
            }
        }
    }
});

test('counts stay correct as the lattice evolves', () => {
    const lattice = randomLattice(8, true, 7);
    const rule = parseRule('4555');
    for (let generation = 0; generation < 10; generation++) {
        lattice.step(rule);
        const counts = lattice.computeCounts();
        for (let i = 0; i < 40; i++) {
            const x = i % 8, y = (i * 3) % 8, z = (i * 5) % 8;
            assert.equal(counts[lattice.index(x, y, z)], lattice.countNeighborsNaive(x, y, z));
        }
    }
});

//-------Neighborhood shape-------
test('a full wrapped lattice gives every cell 26 neighbors', () => {
    const lattice = new Lattice(5, { wrap: true });
    lattice.cells.fill(1);
    const counts = lattice.computeCounts();
    assert.equal(counts[lattice.index(0, 0, 0)], 26);
    assert.equal(counts[lattice.index(2, 2, 2)], 26);
});

test('without wrap a corner sees 7 and a face center sees 17', () => {
    const lattice = new Lattice(5, { wrap: false });
    lattice.cells.fill(1);
    const counts = lattice.computeCounts();
    assert.equal(counts[lattice.index(0, 0, 0)], 7);
    assert.equal(counts[lattice.index(2, 2, 0)], 17);
    assert.equal(counts[lattice.index(2, 2, 2)], 26);
});

test('a lone cell has no neighbors and dies under any rule needing one', () => {
    const lattice = new Lattice(6, { wrap: true });
    lattice.set(3, 3, 3, 1);
    assert.equal(lattice.computeCounts()[lattice.index(3, 3, 3)], 0);
    lattice.step(parseRule('4555'));
    assert.equal(lattice.population(), 0);
});

//-------Rule application-------
test('an empty lattice stays empty when birth needs neighbors', () => {
    const lattice = new Lattice(6, { wrap: true });
    lattice.step(parseRule('4555'));
    assert.equal(lattice.population(), 0);
});

test('a rule born on 0-26 fills the lattice in one tick', () => {
    const lattice = new Lattice(6, { wrap: true });
    lattice.step({ sMin: 0, sMax: 26, bMin: 0, bMax: 26 });
    assert.equal(lattice.population(), 6 * 6 * 6);
});

test('surviving 0-26 with impossible birth leaves any board untouched', () => {
    const lattice = randomLattice(8, true, 99);
    const before = lattice.cells.slice();
    lattice.step({ sMin: 0, sMax: 26, bMin: 27, bMax: 27 });
    assert.deepEqual(Array.from(lattice.cells), Array.from(before));
});

test('age rises while a cell lives and resets when it dies', () => {
    const lattice = new Lattice(6, { wrap: true });
    const stayAlive = { sMin: 0, sMax: 26, bMin: 27, bMax: 27 };
    lattice.set(2, 2, 2, 1);
    lattice.age[lattice.index(2, 2, 2)] = 1;
    lattice.step(stayAlive);
    lattice.step(stayAlive);
    assert.equal(lattice.age[lattice.index(2, 2, 2)], 3);

    lattice.step({ sMin: 27, sMax: 27, bMin: 27, bMax: 27 });
    assert.equal(lattice.age[lattice.index(2, 2, 2)], 0);
});

//-------Determinism-------
test('same seed and rule give an identical lattice after 50 ticks', () => {
    const rule = parseRule('5766');
    const a = randomLattice(12, true, 2024);
    const b = randomLattice(12, true, 2024);
    for (let i = 0; i < 50; i++) {
        a.step(rule);
        b.step(rule);
    }
    assert.deepEqual(Array.from(a.cells), Array.from(b.cells));
    assert.equal(a.generation, 50);
});

test('injectSphere is seeded and wraps across the boundary', () => {
    const a = new Lattice(10, { wrap: true });
    const b = new Lattice(10, { wrap: true });
    a.injectSphere(0, 0, 0, 3, 1.0, mulberry32(5));
    b.injectSphere(0, 0, 0, 3, 1.0, mulberry32(5));
    assert.deepEqual(Array.from(a.cells), Array.from(b.cells));
    assert.equal(a.get(9, 0, 0), 1, 'sphere should wrap to the far face');

    const bounded = new Lattice(10, { wrap: false });
    bounded.injectSphere(0, 0, 0, 3, 1.0, mulberry32(5));
    assert.equal(bounded.get(9, 0, 0), 0, 'bounded lattice must not wrap');
});

//-------Rule notation-------
test('Bays notation parses and round-trips', () => {
    assert.deepEqual(parseRule('4555'), { sMin: 4, sMax: 5, bMin: 5, bMax: 5 });
    assert.deepEqual(parseRule('5766'), { sMin: 5, sMax: 7, bMin: 6, bMax: 6 });
    assert.equal(formatRule(parseRule('4555')), '4555');
});

test('range notation covers counts above nine', () => {
    assert.deepEqual(parseRule('S9-12/B10-11'), { sMin: 9, sMax: 12, bMin: 10, bMax: 11 });
    assert.deepEqual(parseRule('4-5/5'), { sMin: 4, sMax: 5, bMin: 5, bMax: 5 });
    assert.equal(formatRule({ sMin: 9, sMax: 12, bMin: 10, bMax: 11 }), 'S9-12/B10-11');
});

test('malformed rules throw', () => {
    for (const bad of ['', 'abcd', '455', '45555', '9-4/5-5', '4-5/9-2', 'S30-31/B5', '4,5,5,5']) {
        assert.throws(() => parseRule(bad), undefined, `expected "${bad}" to throw`);
    }
    assert.throws(() => parseRule(4555));
    assert.throws(() => new Lattice(2));
});
