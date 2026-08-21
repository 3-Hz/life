import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MOTION, sampleCameraMotion } from '../dist/camera-motion.js';

test('camera motion starts at a neutral offset', () => {
    assert.deepEqual(sampleCameraMotion(0), { yaw: 0, pitch: 0 });
});

test('camera motion stays inside its configured amplitudes', () => {
    for (let seconds = 0; seconds < 100; seconds += 0.07) {
        const { yaw, pitch } = sampleCameraMotion(seconds);
        assert.ok(Math.abs(yaw) <= CAMERA_MOTION.yawAmplitude);
        assert.ok(Math.abs(pitch) <= CAMERA_MOTION.pitchAmplitude);
    }
});

test('camera motion is deterministic and changes over time', () => {
    assert.deepEqual(sampleCameraMotion(3.5), sampleCameraMotion(3.5));
    assert.notDeepEqual(sampleCameraMotion(0), sampleCameraMotion(3.5));
});

test('camera motion repeats at each axis period', () => {
    const start = sampleCameraMotion(2);
    const afterYawPeriod = sampleCameraMotion(2 + CAMERA_MOTION.yawPeriod);
    const afterPitchPeriod = sampleCameraMotion(2 + CAMERA_MOTION.pitchPeriod);
    assert.ok(Math.abs(start.yaw - afterYawPeriod.yaw) < 1e-12);
    assert.ok(Math.abs(start.pitch - afterPitchPeriod.pitch) < 1e-12);
});
