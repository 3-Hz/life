// Small, deterministic camera motion primitives. Keeping the waveform out of
// the renderer makes its bounds and timing easy to test without WebGL.

export interface CameraMotionOffset {
    yaw: number;
    pitch: number;
}

const DEFAULT_CAMERA_ELEVATION = Math.atan2(0.85, Math.hypot(1.1, 1.35));
const PITCH_AMPLITUDE = 0.24;

export const CAMERA_MOTION = {
    // Derived from the camera's initial position, not from the user's current
    // pose, so automation never adopts a near-top-down manual angle.
    baselineElevation: DEFAULT_CAMERA_ELEVATION,
    pitchAmplitude: PITCH_AMPLITUDE, // about 14° above and below the baseline
    minElevation: DEFAULT_CAMERA_ELEVATION - PITCH_AMPLITUDE,
    maxElevation: DEFAULT_CAMERA_ELEVATION + PITCH_AMPLITUDE,
    rotationPeriod: 12,
    pitchCyclesPerRotation: 1,
    recenterDuration: 0.75,
};

const TWO_PI = Math.PI * 2;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function cameraElevation(pitch: number): number {
    return clamp(
        CAMERA_MOTION.baselineElevation + pitch,
        CAMERA_MOTION.minElevation,
        CAMERA_MOTION.maxElevation,
    );
}

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
