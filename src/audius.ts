// Audius track discovery and streaming.
//
// This is the one music source that survives the cross-origin problem described
// in audio.ts. A SoundCloud or Spotify embed is an iframe whose audio the page
// can never touch; Audius serves its streams with Access-Control-Allow-Origin,
// so a track loads into an <audio> element we own and Web Audio reads every
// sample of it. No iframe, no SDK, no key -- which is also what makes it the
// only song source that works on a phone, where screen capture does not exist.

// Two known-good discovery nodes. The second is the load balancer in front of
// the first; either answers the same /v1 routes, so it doubles as a fallback.
const HOSTS = ['https://discoveryprovider.audius.co', 'https://api.audius.co'];
// Identifies us in Audius' analytics. Read-only access needs no key; one only
// raises the rate limit.
const APP_NAME = 'life';
const LIMIT = 20;
const TIMEOUT_MS = 8000;

// The subset of the response we read. The API returns a great deal more.
interface ApiUser {
    name?: string;
    handle?: string;
}

interface ApiArtwork {
    '150x150'?: string;
    '480x480'?: string;
}

interface ApiTrack {
    id?: string;
    title?: string;
    duration?: number;
    is_streamable?: boolean;
    user?: ApiUser;
    artwork?: ApiArtwork | null;
}

// What the rest of the app sees. Normalizing here keeps the API's optionals
// from leaking into the UI, which would otherwise need a fallback per field.
export interface AudiusTrack {
    id: string;
    title: string;
    artist: string;
    duration: number;
    artwork: string | null;
}

function normalize(track: ApiTrack): AudiusTrack | null {
    // A track with no id cannot be streamed, and one flagged unstreamable is
    // usually gated or still transcoding.
    if (!track.id || track.is_streamable === false) return null;
    return {
        id: track.id,
        title: track.title?.trim() || 'untitled',
        artist: track.user?.name?.trim() || track.user?.handle || 'unknown artist',
        duration: track.duration ?? 0,
        artwork: track.artwork?.['150x150'] ?? track.artwork?.['480x480'] ?? null,
    };
}

export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export class AudiusClient {
    host: string;
    available: boolean;
    error: string | null;
    private _trending: AudiusTrack[] | null;

    constructor() {
        this.host = HOSTS[0];
        this.available = false;
        this.error = null;
        this._trending = null;
    }

    // Resolves false rather than throwing when Audius is unreachable, so this
    // one source disables itself and the others keep working.
    async init(): Promise<boolean> {
        for (const host of HOSTS) {
            try {
                await this._fetch(host, '/v1/tracks/trending', { limit: '1' });
                this.host = host;
                this.available = true;
                this.error = null;
                return true;
            } catch (err) {
                this.error = err instanceof Error ? err.message : String(err);
            }
        }
        this.available = false;
        return false;
    }

    // The stream URL is built, never fetched: handing it straight to an <audio>
    // element lets the browser range-request it, which is what makes seeking
    // work. The endpoint 302s to a CDN and both hops carry the CORS header.
    streamUrl(id: string): string {
        return `${this.host}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=${APP_NAME}`;
    }

    // Cached: the panel asks for this every time it opens, and the list is the
    // same for everyone for hours at a time.
    async trending(): Promise<AudiusTrack[]> {
        if (this._trending) return this._trending;
        const body = await this._fetch(this.host, '/v1/tracks/trending', { limit: String(LIMIT) });
        this._trending = tracksFrom(body);
        return this._trending;
    }

    async search(query: string): Promise<AudiusTrack[]> {
        const trimmed = query.trim();
        if (!trimmed) return this.trending();
        // A pasted link is a search that can only have one answer, so spend the
        // request on resolving it instead of matching its text.
        if (/^https?:\/\/(www\.)?audius\.co\//i.test(trimmed)) return this.resolve(trimmed);
        const body = await this._fetch(this.host, '/v1/tracks/search', {
            query: trimmed,
            limit: String(LIMIT),
        });
        return tracksFrom(body);
    }

    async resolve(url: string): Promise<AudiusTrack[]> {
        // /v1/resolve redirects to the canonical resource; fetch follows it, and
        // a track link lands on a single object rather than a list.
        const body = await this._fetch(this.host, '/v1/resolve', { url });
        return tracksFrom(body);
    }

    private async _fetch(host: string, path: string, params: Record<string, string>): Promise<unknown> {
        const query = new URLSearchParams({ ...params, app_name: APP_NAME });
        // A discovery node that has gone quiet would otherwise hang the panel
        // until the browser's own timeout, which is minutes.
        const response = await fetch(`${host}${path}?${query}`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Audius returned ${response.status}`);
        return response.json();
    }
}

// Search and trending answer with a list, resolve with a single object. Both
// arrive under `data`, so unwrap once and let normalize drop what it cannot use.
function tracksFrom(body: unknown): AudiusTrack[] {
    const data = (body as { data?: ApiTrack | ApiTrack[] } | null)?.data;
    if (!data) return [];
    const list = Array.isArray(data) ? data : [data];
    return list.map(normalize).filter((track): track is AudiusTrack => track !== null);
}
