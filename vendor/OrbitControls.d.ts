export class OrbitControls {
    constructor(camera: unknown, domElement: HTMLElement);
    enableDamping: boolean;
    dampingFactor: number;
    target: { set(x: number, y: number, z: number): void };
    enablePan: boolean;
    minDistance: number;
    maxDistance: number;
    update(): void;
}
