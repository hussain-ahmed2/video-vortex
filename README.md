# Video Vortex

> Find the video playing on a page and save it. A Chrome extension, everything local.

Video Vortex watches the page you are on for media, lists what it finds in a small popup, and hands it to Chrome's download manager. Nothing is uploaded, and nothing is fetched from a service on your behalf.

## What works today

The honest state of the build, so you know what to expect before you install it.

- **Finds direct media files.** It watches network responses and keeps the ones that named themselves as video or audio, or whose path names a container it knows. Up to fifty per tab, and the popup says how many it is holding back when there are more.
- **The list survives.** Findings live in the tab's session storage rather than in the service worker's memory, so opening the popup an hour later still shows what was found.
- **Finds streams the browser assembles in memory.** Most real sites never request a video file; they fetch thousands of small chunks and stitch them together on the page. A small hook running in the page's own world watches that happening, along with `blob:` videos, so those sites are listed too.
- **Never receives a media byte.** For a stream, the page produces the file and starts the download itself. The extension holds a count and a few small signals, never the media.
- **Says when a stream cannot be saved.** A live broadcast, a stream that lost bytes, and one the browser refused are each labelled with the reason rather than offered as a file.
- **Names files predictably.** The page's own title first, then the media element's name for a stream, then the last part of the address, with the container as the extension.
- **Works entirely offline.** No account, no server, no telemetry.

## What does not work yet

Stated plainly, because a downloader that silently fails is worse than one that admits it.

- **Streams are not yet proven against real sites.** They are built and covered by tests, and one of them is the whole reason this slice was written, but nobody has yet run it against three real players in a browser. Expect surprises there. The README will change when they have.
- **YouTube is not supported.** The extractor that used to read the player's own data was retired with the rebuild and has not been rebuilt yet, so YouTube currently shows whatever its network requests happen to expose, which is close to nothing.
- **A stream that started before you opened the popup is missed.** The hook can only see what happens after it is installed, so media already playing when the extension wakes up is not listed until the page reloads. The popup says so while it is watching.
- **Encrypted streams are invisible.** Widevine and PlayReady scramble the bytes, so there is no file to save. Nothing is listed for them, because a row that offers to save something unplayable is worse than no row.
- **An HLS or DASH playlist downloads as a playlist file**, which is text, not a playable video.
- **Audio and video stay separate.** A high quality video and its audio track are two separate downloads, with nothing merging them.
- **A page that was already playing when the popup opened may show nothing at all** until it reloads. That is the honest limit of watching from outside the page.

## Install from source

You need Node.js and Chrome. `npm install` will tell you if your Node version is too old for the build.

```bash
git clone https://github.com/hussain-ahmed2/video-vortex.git
cd video-vortex
npm install
npm run build
```

Then in Chrome: open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick the `dist` folder the build produced. Reload the extension there after every rebuild.

The build produces three files that must land flat in `dist`: `background.js`, `content.js` and `hook.js`. The first two are named by the manifest and the third by the worker's injection call, so renaming any of the three build inputs breaks the extension without saying so.

`npm run dev` starts a dev server for the popup only. The service worker, the content script and the page hook do not hot reload, so use the build for anything that touches them.

## Tech stack

- [React 19](https://react.dev/) and [Vite 8](https://vitejs.dev/), in [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS v4](https://tailwindcss.com/), with [shadcn/ui](https://ui.shadcn.com/) components
- [Motion](https://motion.dev/) for animation, [Lucide](https://lucide.dev/) for icons
- Chrome Manifest V3: one service worker, two injected scripts, one popup

## How it works

Four runtimes and one shared set of rules:

- **The engine** (`src/engine/`) is pure. It decides what one detected item is, what a tab's list looks like, how two findings merge, what a stream's signals mean, and what a file is called. It calls no browser API, so the popup, the worker and the content script all get the same answer instead of three copies drifting apart.
- **The service worker** (`src/background.ts`) is the only writer of detection state. It watches responses through `chrome.webRequest`, injects the other two scripts on demand, keeps each tab's findings in session storage, and owns file downloads.
- **The content script** (`src/content.ts`) is injected only when someone opens the popup. It reports the page's title and address, mints the token that every report from the page must carry, and translates the page's observations into findings.
- **The page hook** (`src/hook.ts`) is injected into the page's own world. It is the only place a stream's bytes can be copied from, because a media buffer cannot be read back from outside the page. It watches, it holds, and on request it produces the file and clicks a link to it.
- **The popup** (`src/App.tsx`) asks the worker for the tab's list, shows each row, and sends the download request. It holds no detection rule of its own.

Nothing is loaded on a page until someone opens the popup, so the extension costs a page nothing until it is asked about.

## Where the project is

The old pipeline, where three files each knew a little about everything and disagreed with each other, has been replaced. What is left is the slice by slice work recorded in the plan, and the order it is going in is written down rather than held in anyone's head.

- The plan: [`docs/scope/scope.md`](docs/scope/scope.md)
- The architecture decision: [`docs/specs/0001-detection-engine-architecture/index.md`](docs/specs/0001-detection-engine-architecture/index.md)

## Privacy

All detection happens on your machine. No data leaves your browser, and the extension makes no network request of its own: the only bytes it fetches are the media you choose to save. That is a design constraint rather than a promise, so please do not ask for a feature that would need a server.

Please respect the copyright and the terms of the sites you visit. This is for personal and educational archiving.

## License

Not chosen yet. Add a `LICENSE` file before you publish, with the year and the copyright holder in it. Until one exists, nobody else may legally reuse this.