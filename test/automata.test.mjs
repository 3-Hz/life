// The Bun test script builds the TypeScript modules before running these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lattice, parseRule, formatRule, RULE_PRESETS } from '../dist/automata.js';
import { mulberry32 } from '../dist/rng.js';

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

// step() no longer calls computeCounts() -- it fuses the z-pass into the rule
// application. Without this test the separable-vs-naive test above would still
// pass while covering code nothing runs.
test('the fused step counts neighbors exactly as the naive oracle does', () => {
    for (const n of [4, 7, 12]) {
        for (const wrap of [true, false]) {
            const lattice = randomLattice(n, wrap, n * 13 + (wrap ? 2 : 0));
            const rule = parseRule('S7-12/B9-12');
            for (let generation = 0; generation < 5; generation++) {
                // Oracle reads the board as it stands, before the step mutates it.
                const expected = new Uint8Array(lattice.size);
                for (let z = 0; z < n; z++) {
                    for (let y = 0; y < n; y++) {
                        for (let x = 0; x < n; x++) {
                            expected[lattice.index(x, y, z)] = lattice.countNeighborsNaive(x, y, z);
                        }
                    }
                }
                lattice.step(rule);
                assert.deepEqual(
                    Array.from(lattice.counts), Array.from(expected),
                    `fused counts diverged at n=${n}, wrap=${wrap}, gen=${generation}`,
                );
            }
        }
    }
});

test('step returns the population it just produced', () => {
    const lattice = randomLattice(10, true, 3);
    const rule = parseRule('S7-12/B9-12');
    for (let i = 0; i < 8; i++) {
        const returned = lattice.step(rule);
        assert.equal(returned, lattice.population(), 'returned population must match a full recount');
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

test('counts describe the current cells after seeding, clearing and injecting', () => {
    // The renderer reads counts[] every sync, including on frames where no step
    // ran, so a stale array shows as wrong shading or a wrongly hidden cell.
    const lattice = new Lattice(9, { wrap: true });
    const check = (label) => {
        for (let z = 0; z < 9; z++) {
            for (let y = 0; y < 9; y++) {
                for (let x = 0; x < 9; x++) {
                    assert.equal(
                        lattice.counts[lattice.index(x, y, z)],
                        lattice.countNeighborsNaive(x, y, z),
                        `stale count at ${x},${y},${z} after ${label}`,
                    );
                }
            }
        }
    };
    lattice.seedRandom(0.3, mulberry32(11));
    check('seedRandom');
    lattice.injectSphere(4, 4, 4, 3, 0.8, mulberry32(12));
    check('injectSphere');
    lattice.clear();
    check('clear');
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

//-------Presets-------
// The test that matters most here. An earlier default shipped dead: it was
// chosen against a denser, full-lattice seeding and collapsed to 29 live cells
// under the seeding the app actually uses. Every preset now has to survive the
// real thing.
test('every shipped preset stays alive and in range from the app\'s own seeding', () => {
    const N = 48;
    const SEED_DENSITY = 0.18;          // must mirror main.ts
    const MARGIN = Math.floor(N / 4);   // must mirror main.ts

    for (const preset of RULE_PRESETS) {
        if (preset.fragile) continue;   // Bays' classics need beats, by design

        const lattice = new Lattice(N, { wrap: true });
        const rule = parseRule(preset.rule);
        lattice.seedRandom(SEED_DENSITY, mulberry32(0xC0FFEE), { margin: MARGIN });
        for (let g = 0; g < 200; g++) lattice.step(rule);

        const population = lattice.population();
        const share = population / lattice.size;
        assert.ok(
            share >= 0.05 && share <= 0.40,
            `${preset.rule}: ${population} live (${(100 * share).toFixed(1)}%) after 200 generations, outside 5-40%`,
        );

        const before = lattice.cells.slice();
        lattice.step(rule);
        let changed = 0;
        for (let i = 0; i < lattice.size; i++) if (before[i] !== lattice.cells[i]) changed++;
        const churn = changed / population;
        assert.ok(
            churn >= 0.02 && churn <= 1.7,
            `${preset.rule}: churn ${(100 * churn).toFixed(0)}% of live cells — frozen or re-rolling`,
        );
    }
});

test('preset metadata is coherent and exactly one is the default', () => {
    const defaults = RULE_PRESETS.filter((p) => p.default);
    assert.equal(defaults.length, 1, 'exactly one preset must be marked default');
    assert.ok(!defaults[0].fragile, 'the default must not be a rule that dies from soup');

    for (const preset of RULE_PRESETS) {
        assert.doesNotThrow(() => parseRule(preset.rule), `unparseable preset: ${preset.rule}`);
        assert.ok(preset.label, `preset ${preset.rule} needs a label`);
    }
});

//-------Previous generation, for the render animation-------
test('previous holds the prior generation, so births and deaths are separable', () => {
    const lattice = new Lattice(12, { wrap: true });
    const rule = parseRule('4733');
    lattice.seedRandom(0.25, mulberry32(4));

    for (let g = 0; g < 6; g++) {
        const before = lattice.cells.slice();
        lattice.step(rule);
        assert.deepEqual(
            Array.from(lattice.previous), Array.from(before),
            'previous must be the board the step read from',
        );

        // The classification the renderer derives from it must match a direct
        // comparison of the two boards.
        let born = 0, steady = 0, dying = 0;
        for (let i = 0; i < lattice.size; i++) {
            const now = lattice.cells[i], was = lattice.previous[i];
            if (now && !was) born++;
            else if (now && was) steady++;
            else if (!now && was) dying++;
        }
        let expectBorn = 0, expectSteady = 0, expectDying = 0;
        for (let i = 0; i < lattice.size; i++) {
            if (lattice.cells[i] && !before[i]) expectBorn++;
            else if (lattice.cells[i] && before[i]) expectSteady++;
            else if (!lattice.cells[i] && before[i]) expectDying++;
        }
        assert.deepEqual({ born, steady, dying }, { born: expectBorn, steady: expectSteady, dying: expectDying });
        assert.equal(born + steady, lattice.population());
    }
});

//-------BIRTH THINNING-------
// The density controller's lever. It must be invisible when unused, and when
// used it must only ever take away births.
test('the default step is untouched by the thinning parameter', () => {
    const rule = parseRule('4733');
    const plain = randomLattice(12, true, 909);
    const withArgs = randomLattice(12, true, 909);
    for (let i = 0; i < 8; i++) {
        plain.step(rule);
        withArgs.step(rule, { birthChance: 1, rng: mulberry32(1) });
    }
    assert.deepEqual([...withArgs.cells], [...plain.cells]);
    assert.deepEqual([...withArgs.age], [...plain.age]);
});

test('thinning removes births and leaves survivors alone', () => {
    const rule = parseRule('4733');
    const full = randomLattice(16, true, 4242);
    const thinned = randomLattice(16, true, 4242);

    const before = [...full.cells];
    full.step(rule);
    const thinnedAlive = thinned.step(rule, { birthChance: 0.3, rng: mulberry32(7) });

    assert.ok(thinnedAlive < full.population(), 'thinning must actually cost cells');
    for (let i = 0; i < full.size; i++) {
        if (thinned.cells[i] && !before[i]) {
            assert.ok(full.cells[i], 'thinning may only remove births, never add them');
        }
        if (before[i] && full.cells[i]) {
            assert.equal(thinned.cells[i], 1, 'a survivor must survive either way');
        }
    }
});

test('a zero birth chance leaves nothing but survivors', () => {
    const rule = parseRule('4733');
    const lattice = randomLattice(12, true, 55);
    const before = [...lattice.cells];
    lattice.step(rule, { birthChance: 0, rng: mulberry32(3) });
    for (let i = 0; i < lattice.size; i++) {
        if (lattice.cells[i]) assert.equal(before[i], 1, 'nothing new may be born');
    }
});

test('thinning is reproducible from the same seed', () => {
    const rule = parseRule('4733');
    const run = () => {
        const lattice = randomLattice(12, true, 77);
        const rng = mulberry32(0xBEEF);
        for (let i = 0; i < 6; i++) lattice.step(rule, { birthChance: 0.5, rng });
        return [...lattice.cells];
    };
    assert.deepEqual(run(), run());
});
