// Small, deterministic camera motion primitives. Keeping the waveform out of
// the renderer makes its bounds and timing easy to test without WebGL.

export interface CameraMotionOffset {
    yaw: number;
    pitch: number;
}

export const CAMERA_MOTION = {
    yawAmplitude: 0.14,
    pitchAmplitude: 0.07,
    yawPeriod: 22,
    pitchPeriod: 31,
};

const TWO_PI = Math.PI * 2;

export function sampleCameraMotion(seconds: number): CameraMotionOffset {
    const elapsed = Math.max(0, seconds);
    return {
        yaw: CAMERA_MOTION.yawAmplitude * Math.sin(TWO_PI * elapsed / CAMERA_MOTION.yawPeriod),
        pitch: CAMERA_MOTION.pitchAmplitude * Math.sin(TWO_PI * elapsed / CAMERA_MOTION.pitchPeriod),
    };
}
