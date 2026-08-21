// Small, deterministic camera motion primitives. Keeping the waveform out of
// the renderer makes its bounds and timing easy to test without WebGL.

export interface CameraMotionOffset {
    yaw: number;
    pitch: number;
}

export const CAMERA_MOTION = {
    pitchAmplitude: 0.07,
    rotationPeriod: 12,
    pitchCyclesPerRotation: 1,
};

const TWO_PI = Math.PI * 2;

export function sampleCameraMotion(seconds: number): CameraMotionOffset {
    const elapsed = Math.max(0, seconds);
    return {
        // Keep yaw unwrapped so the renderer can apply a constant forward
        // delta across the 2π boundary instead of jumping back to zero.
        yaw: TWO_PI * elapsed / CAMERA_MOTION.rotationPeriod,
        pitch: CAMERA_MOTION.pitchAmplitude * Math.sin(
            TWO_PI * elapsed * CAMERA_MOTION.pitchCyclesPerRotation / CAMERA_MOTION.rotationPeriod,
        ),
    };
}
