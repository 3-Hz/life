import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MOTION, sampleCameraMotion } from '../dist/camera-motion.js';

test('camera motion starts at a neutral offset', () => {
    assert.deepEqual(sampleCameraMotion(0), { yaw: 0, pitch: 0 });
});

test('camera elevation stays inside its configured amplitude', () => {
    for (let seconds = 0; seconds < 100; seconds += 0.07) {
        const { yaw, pitch } = sampleCameraMotion(seconds);
        assert.ok(yaw >= 0, 'yaw should keep advancing around the orbit');
        assert.ok(Math.abs(pitch) <= CAMERA_MOTION.pitchAmplitude);
    }
});

test('camera motion is deterministic and changes over time', () => {
    assert.deepEqual(sampleCameraMotion(3.5), sampleCameraMotion(3.5));
    assert.notDeepEqual(sampleCameraMotion(0), sampleCameraMotion(3.5));
});

test('camera completes one full orbit while elevation follows a sine wave', () => {
    const quarter = sampleCameraMotion(CAMERA_MOTION.rotationPeriod / 4);
    const half = sampleCameraMotion(CAMERA_MOTION.rotationPeriod / 2);
    const threeQuarter = sampleCameraMotion(CAMERA_MOTION.rotationPeriod * 3 / 4);
    const full = sampleCameraMotion(CAMERA_MOTION.rotationPeriod);

    assert.ok(Math.abs(quarter.yaw - Math.PI / 2) < 1e-12);
    assert.ok(Math.abs(quarter.pitch - CAMERA_MOTION.pitchAmplitude) < 1e-12);
    assert.ok(Math.abs(half.yaw - Math.PI) < 1e-12);
    assert.ok(Math.abs(half.pitch) < 1e-12);
    assert.ok(Math.abs(threeQuarter.yaw - Math.PI * 3 / 2) < 1e-12);
    assert.ok(Math.abs(threeQuarter.pitch + CAMERA_MOTION.pitchAmplitude) < 1e-12);
    assert.ok(Math.abs(full.yaw - Math.PI * 2) < 1e-12);
    assert.ok(Math.abs(full.pitch) < 1e-12);
});
