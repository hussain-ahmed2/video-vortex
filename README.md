# Video Vortex

> Find the video playing on a page and save it. A Chrome extension, everything local.

Video Vortex watches the page you are on for media, lists what it finds in a small popup, and hands it to Chrome's download manager. Nothing is uploaded, and nothing is fetched from a service on your behalf.

## What works today

The honest state of the build, so you know what to expect before you install it.

- Detects direct media files by watching network requests: `.mp4`, `.webm`, `.ogg`, `.m4v`, and it spots `.m3u8` and `.mpd` streams by their extension.
- On YouTube, reads the player's own data and lists the formats that carry a direct link, with quality, size and channel name.
- One click per stream, through Chrome's download manager, with a progress bar and a clean file name.
- Works entirely offline. No account, no server, no telemetry.

## What does not work yet

Stated plainly, because a downloader that silently fails is worse than one that admits it.

- **Most real sites show nothing.** The detector matches file extensions in request URLs. Most sites never request a video file; the browser assembles the stream in memory from many small requests instead. Catching that is the next build.
- **The list forgets.** Detected media is held in the service worker's memory, and Chrome stops that worker after 30 seconds of quiet, so a video found a minute ago can be gone by the time you open the popup. This is the main thing the rebuild fixes.
- **YouTube's protected formats are missing.** The formats YouTube signs are not offered, because reading them normally means asking a server for help, and this extension makes no network requests of its own.
- **An HLS or DASH stream downloads as a playlist file**, which is text, not a playable video.
- **Audio and video stay separate.** A high quality video and its audio track are two separate downloads, with nothing merging them.
- **The page scan never runs.** The content script can walk the DOM for `<video>` and `<audio>` elements and their nested `<source>` tags, but nothing asks it to, so that path is dead today. It gets wired up in the rebuild.

## Install from source

You need Node.js and Chrome. `npm install` will tell you if your Node version is too old for the build.

```bash
git clone https://github.com/hussain-ahmed2/video-vortex.git
cd video-vortex
npm install
npm run build
```

Then in Chrome: open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the `dist` folder the build produced. Reload the extension there after every rebuild.

`npm run dev` starts a dev server for the popup only. The service worker and the content script do not hot reload, so use the build for anything that touches them.

## Tech stack

- [React 19](https://react.dev/) and [Vite 8](https://vitejs.dev/), in [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS v4](https://tailwindcss.com/), with [shadcn/ui](https://ui.shadcn.com/) components
- [Motion](https://motion.dev/) for animation, [Lucide](https://lucide.dev/) for icons
- Chrome Manifest V3: one service worker, one content script, one popup

## How it works

Three runtimes and a popup:

- **Service worker** (`src/background.ts`) watches requests through `chrome.webRequest`, keeps what it finds per tab, and owns the downloads.
- **Content script** (`src/content.ts`) runs on every page. It reads the DOM, and on YouTube it injects a script into the page to read the player's own data, because a content script cannot see the page's JavaScript.
- **Popup** (`src/App.tsx`) asks the worker for the tab's list, shows each stream, and sends the download request.

## What is being rebuilt

Those three files each know a little about everything, which is why they disagree with each other and why the list forgets. The rebuild replaces them with one pure engine that all three import, keeps each tab's findings in session storage so they survive the worker being stopped, and moves site support into a registry of extractors, so adding a site becomes a new file rather than a change to the engine.

- The plan: [`docs/scope/scope.md`](docs/scope/scope.md)
- The architecture decision: [`docs/specs/0001-detection-engine-architecture/index.md`](docs/specs/0001-detection-engine-architecture/index.md)

## Privacy

All detection happens on your machine. No data leaves your browser, and the extension makes no network request of its own: the only bytes it fetches are the media you choose to save. That is a design constraint rather than a promise, so please do not ask for a feature that would need a server.

Please respect the copyright and the terms of the sites you visit. This is for personal and educational archiving.

## License

Not chosen yet. Add a `LICENSE` file before you publish, with the year and the copyright holder in it. Until one exists, nobody else may legally reuse this.
