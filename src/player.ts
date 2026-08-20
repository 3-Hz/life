// SoundCloud widget embed.
//
// The widget cannot feed Web Audio directly -- it is a cross-origin iframe, and
// nothing in the platform turns that into samples. Its job is to put the music
// inside our own tab so that getDisplayMedia({preferCurrentTab:true}) can
// capture it, which is the one route to song audio that works on macOS too.

const API_URL = 'https://w.soundcloud.com/player/api.js';
const DEFAULT_TRACK = 'https://soundcloud.com/soundcloud/sets/soundcloud-weekly';

let apiPromise: Promise<SoundCloudNamespace> | null = null;

function loadWidgetApi(): Promise<SoundCloudNamespace> {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise<SoundCloudNamespace>((resolve, reject) => {
        const sc = window.SC;
        if (sc?.Widget) return resolve(sc);
        const script = document.createElement('script');
        script.src = API_URL;
        script.async = true;
        script.onload = () => {
            const loaded = window.SC;
            if (loaded?.Widget) resolve(loaded);
            else reject(new Error('widget API loaded but empty'));
        };
        script.onerror = () => reject(new Error('could not reach w.soundcloud.com'));
        document.head.appendChild(script);
    });
    return apiPromise;
}

export class SoundCloudPlayer {
    iframe: HTMLIFrameElement;
    widget: SoundCloudWidget | null;
    available: boolean;
    error: string | null;
    playing: boolean;
    title: string;
    onStateChange: (player: SoundCloudPlayer) => void;

    constructor(iframe: HTMLIFrameElement) {
        this.iframe = iframe;
        this.widget = null;
        this.available = false;
        this.error = null;
        this.playing = false;
        this.title = '';
        this.onStateChange = () => {};
    }

    // Resolves false rather than throwing when SoundCloud is unreachable: this
    // one source disables itself, the other four keep working.
    async init(trackUrl: string = DEFAULT_TRACK): Promise<boolean> {
        let api: SoundCloudNamespace;
        try {
            api = await loadWidgetApi();
        } catch (err) {
            this.error = err instanceof Error ? err.message : String(err);
            this.available = false;
            return false;
        }

        this.iframe.src = widgetUrl(trackUrl);
        this.widget = api.Widget(this.iframe);

        const Events = api.Widget.Events;
        this.widget.bind(Events.READY, () => {
            this.available = true;
            this.widget!.getCurrentSound((sound) => {
                this.title = sound?.title ?? '';
                this.onStateChange(this);
            });
        });
        this.widget.bind(Events.PLAY, () => {
            this.playing = true;
            this.onStateChange(this);
        });
        this.widget.bind(Events.PAUSE, () => {
            this.playing = false;
            this.onStateChange(this);
        });
        this.widget.bind(Events.FINISH, () => {
            this.playing = false;
            this.onStateChange(this);
        });

        this.available = true;
        return true;
    }

    load(trackUrl: string): void {
        if (!this.widget) return;
        this.widget.load(trackUrl, {
            auto_play: true,
            show_artwork: true,
            callback: () => {
                this.widget!.getCurrentSound((sound) => {
                    this.title = sound?.title ?? '';
                    this.onStateChange(this);
                });
            },
        });
    }

    play(): void { this.widget?.play(); }
    pause(): void { this.widget?.pause(); }
}

function widgetUrl(trackUrl: string): string {
    const params = new URLSearchParams({
        url: trackUrl,
        auto_play: 'false',
        show_artwork: 'true',
        show_comments: 'false',
        visual: 'false',
    });
    return `https://w.soundcloud.com/player/?${params}`;
}
