declare module "three" {
    const THREE: any;
    export = THREE;
}

interface Window {
    webkitAudioContext?: typeof AudioContext;
    __life?: unknown;
}
