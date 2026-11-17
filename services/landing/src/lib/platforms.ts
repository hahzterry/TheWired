import { REPO, RELEASES_URL } from '../data/site';

/** One downloadable build of the desktop app. */
export type BuildId = 'macos' | 'macos-intel' | 'windows' | 'linux' | 'linux-deb';
export type Build = {
  id: BuildId;
  os: 'macOS' | 'Windows' | 'Linux';
  detail: string;
  /** File name in the release; null when the release could not be read. */
  file: string | null;
  url: string;
};
export type Release = { version: string | null; builds: Build[] };

const MATCHERS: { id: BuildId; os: Build['os']; detail: string; pattern: RegExp }[] = [
  { id: 'macos', os: 'macOS', detail: 'Apple Silicon', pattern: /aarch64\.dmg$/ },
  { id: 'macos-intel', os: 'macOS', detail: 'Intel', pattern: /_x64\.dmg$/ },
  { id: 'windows', os: 'Windows', detail: 'x64 installer', pattern: /x64-setup\.exe$/ },
  { id: 'linux', os: 'Linux', detail: 'AppImage', pattern: /\.AppImage$/ },
  { id: 'linux-deb', os: 'Linux', detail: '.deb', pattern: /\.deb$/ },
];

/** The builds with every link pointing at the releases page. */
export function fallbackRelease(): Release {
  return {
    version: null,
    builds: MATCHERS.map(({ id, os, detail }) => ({ id, os, detail, file: null, url: RELEASES_URL })),
  };
}

type GithubRelease = { tag_name?: unknown; assets?: unknown };
type GithubAsset = { name?: unknown; browser_download_url?: unknown };

/** Map a GitHub "latest release" response onto our builds. */
export function parseRelease(json: GithubRelease): Release {
  const version = typeof json.tag_name === 'string' ? json.tag_name.replace(/^v/, '') : null;
  const assets = Array.isArray(json.assets) ? (json.assets as GithubAsset[]) : [];
  const builds = MATCHERS.map(({ id, os, detail, pattern }) => {
    const asset = assets.find((a) => typeof a.name === 'string' && pattern.test(a.name));
    const url =
      asset && typeof asset.browser_download_url === 'string' &&
      asset.browser_download_url.startsWith(`https://github.com/${REPO}/`)
        ? asset.browser_download_url
        : RELEASES_URL;
    return { id, os, detail, file: asset && typeof asset.name === 'string' ? asset.name : null, url };
  });
  return { version, builds };
}

export async function fetchLatestRelease(timeoutMs = 8000): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return parseRelease(await res.json());
}

export type Device = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown';

/** Best guess at the visitor's device. iPads report as Macs, so check touch. */
export function detectDevice(nav: Navigator = navigator): Device {
  const ua = nav.userAgent.toLowerCase();
  if (/android/.test(ua)) return 'android';
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/mac/.test(ua)) return nav.maxTouchPoints > 1 ? 'ios' : 'macos';
  if (/windows|win64|win32/.test(ua)) return 'windows';
  if (/linux|x11|cros/.test(ua)) return 'linux';
  return 'unknown';
}

/** The build to offer first for a desktop device. Macs default to Apple Silicon. */
export function primaryBuildFor(device: Device): BuildId | null {
  switch (device) {
    case 'macos': return 'macos';
    case 'windows': return 'windows';
    case 'linux': return 'linux';
    default: return null;
  }
}
