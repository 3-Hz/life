declare module "three" {
    const THREE: any;
    export = THREE;
}

interface SoundCloudSound {
    title?: string;
}

interface SoundCloudWidget {
    bind(event: string, callback: (sound?: SoundCloudSound) => void): void;
    getCurrentSound(callback: (sound?: SoundCloudSound) => void): void;
    load(url: string, options: {
        auto_play: boolean;
        show_artwork: boolean;
        callback: () => void;
    }): void;
    play(): void;
    pause(): void;
}

interface SoundCloudWidgetFactory {
    (iframe: HTMLIFrameElement): SoundCloudWidget;
    Events: Record<string, string>;
}

interface SoundCloudNamespace {
    Widget: SoundCloudWidgetFactory;
}

interface Window {
    SC?: SoundCloudNamespace;
    webkitAudioContext?: typeof AudioContext;
    __life?: unknown;
}
