// The content script: it reports the page's title and its URL, it is the relay between the
// page and the worker, and it holds no rule of its own.
//
// Four jobs. It says which page it is on, and notices when that page changes without a
// reload. It mints the token every report from the page carries and drops the ones that do
// not. It translates the page's raw observations into findings, because the page cannot do
// that itself: it is a self contained bundle with no access to the engine, and deciding
// what an observation means is the engine's job. And it relays an assembly request down to
// the page and the page's answer back up, which is the only path by which a stream's file
// is ever produced.
//
// What it deliberately does not do is judge a stream. An encrypted one is carried to the
// worker and discarded there, because that verdict belongs in exactly one place and this is
// not it, however easy it would be to apply here with the engine already bundled in.

import { streamIdFromUrl } from './engine/identity'
import {
  parseMessage,
  request,
  type StreamAssembleResponse,
} from './engine/messages'
import {
  pageStreamToDraft,
  PAGE_CHANNEL_SOURCE,
  parseHookReport,
  type PageStream,
} from './engine/page-channel'
import { CONTRACT_VERSION } from './engine/types'

/**
 * The key the contract version is stamped under on `globalThis`.
 *
 * A page's own globals are shared with this script, so the key is prefixed to be unlikely
 * to collide with anything the site set.
 */
const STAMP_KEY = '__videoVortexContractVersion'

/**
 * How long the hook has to say hello before the page is called unwatchable.
 *
 * Generous on purpose. The hook says hello the moment it loads, and the worker injects it
 * immediately after this script, so the answer is normally a few milliseconds away and this
 * bound is only ever reached by a page that refused a `world: 'MAIN'` injection outright.
 *
 * The status is latched by the merge, strongest first, so a late hello cannot undo a `blocked`
 * verdict. That is the right way round: a page that did not let us in stays blocked, and a
 * timeout short enough to catch a slow page would report an ordinary one as refusing.
 */
const HOOK_HANDSHAKE_TIMEOUT_MS = 2000

/**
 * How long a wait for the page's answer lasts before it is called a refusal.
 *
 * The worker's request is answered by the page, so a page that goes quiet, throws away its
 * own player, or is torn down mid request would otherwise leave a channel open and a popup
 * waiting for the life of the tab. A row stuck on a spinner is the one state a person
 * cannot act on, so the wait is bounded and the row goes back to its control.
 */
const ASSEMBLY_TIMEOUT_MS = 10_000

/**
 * The token every report from the page has to carry, minted once per injection.
 *
 * It stops a hook left over from a previous build, a duplicate hook, and another
 * extension's injection from adding a row. It does not stop the page, which shares this
 * world and can read it, and it is not claimed to: forging a row costs a hostile page
 * nothing it does not already have.
 */
const TOKEN = mintToken()

function mintToken(): string {
  // `randomUUID` needs a secure context, and an extension runs on plain http pages too, so
  // the fallback is not decoration. It does not need to be cryptographic: the token is a
  // marker for our own injections, not a secret.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Messages from the page that were ours and could not be used. */
let droppedPageMessages = 0

/**
 * Read by the diagnostics view later, and by the tests that assert a drop happened.
 *
 * One count for everything unusable rather than one for a stale token and another for a
 * malformed payload, because from here they are the same event: something on this channel
 * said it was ours and could not be acted on. A count that grew silently is how a page
 * quietly stops being watched.
 */
export function droppedPageMessageCount(): number {
  return droppedPageMessages
}

/** Posts to this window only. The payload is a count and a token that belongs to this page. */
function postToPage(message: unknown): void {
  window.postMessage(message, '*')
}

/** Tells the hook it is installed, with the token and the page url it should stamp. */
function installHook(): void {
  postToPage({
    source: PAGE_CHANNEL_SOURCE,
    type: 'install',
    token: TOKEN,
    pageUrl: window.location.href,
  })
}

/**
 * Claims this page for the build that is running now, or reports that it is already
 * claimed. Returns true when the caller should carry on.
 *
 * Two cases, one guard. The worker injects on demand and a read can be repeated, so the
 * same script can arrive twice, and a second copy would add a second listener and a second
 * report for one page. And after an extension reload a page can still be running the
 * content script from the previous build, which reports a payload shape the new worker no
 * longer reads. A mismatched stamp means the old script is replaced; a matching one means
 * there is nothing to do.
 */
function claimPage(): boolean {
  const stamped = (globalThis as Record<string, unknown>)[STAMP_KEY]
  if (stamped === CONTRACT_VERSION) return false

  ;(globalThis as Record<string, unknown>)[STAMP_KEY] = CONTRACT_VERSION
  return true
}

if (claimPage()) {
  start()
}

function start(): void {
  let lastUrl = window.location.href
  /** The streams the page last reported, kept so a re-injection can re-send them. */
  let known: PageStream[] = []
  /** An assembly waiting for the page's answer, keyed by stream id. */
  const pending = new Map<number, (answer: StreamAssembleResponse) => void>()

  /**
   * Posts the page's title, its URL, and every stream it currently holds.
   *
   * `ready` is claimed only once the hook has answered. Before that the page is being watched
   * but its streams are not being seen, and saying otherwise is what makes an empty list
   * read as a page with no media rather than as a page we have not finished looking at.
   */
  const report = (status: 'ready' | 'blocked' = 'ready'): void => {
    void chrome.runtime
      .sendMessage(
        request('ENTRIES_REPORTED', {
          pageUrl: window.location.href,
          pageTitle: document.title,
          status,
          // Empty on a page that streams nothing, which is the same shape it always was: a
          // report is a snapshot of what the page holds, and a file found by the network
          // observer is not the page's to report.
          entries: known.map((stream) => pageStreamToDraft(stream, window.location.href)),
        })
      )
      .catch(() => {
        // The worker was asleep, reloading, or the extension was just removed. A content
        // script cannot retry, and the next injection will report again.
      })
  }

  let hookSeen = false

  /** Tells the worker the page is fully watched, with whatever the hook holds so far. */
  const reportReady = (): void => {
    hookSeen = true
    report('ready')
  }

  window.addEventListener('message', (event: MessageEvent): void => {
    // Whether it is ours at all is asked first, because the page posts messages of its own
    // and refusing those is not a drop worth counting. Everything past this point is ours
    // and unusable, which is one thing worth one number.
    const data = event.data as { source?: unknown } | null
    if (typeof data !== 'object' || data === null || data.source !== PAGE_CHANNEL_SOURCE) return

    const parsed = parseHookReport(data)
    if (!parsed) {
      droppedPageMessages += 1
      return
    }

    // The hook announcing that it is listening, answered rather than waited on. The two files
    // are injected separately and either may arrive second, so the install has to reach the
    // hook whenever it turns up rather than only once on our own load.
    //
    // It is also the proof that a hook is installed here at all. A page that refused a
    // `world: 'MAIN'` injection sends nothing, and silence is the only signal there is, so
    // the verdict is a bounded wait rather than a message that never came.
    if (parsed.type === 'hello') {
      installHook()
      reportReady()
      return
    }

    if (parsed.token !== TOKEN) {
      droppedPageMessages += 1
      return
    }

    if (parsed.type === 'streams') {
      known = parsed.streams
      reportReady()
      return
    }

    const answer = pending.get(parsed.streamId)
    if (!answer) return
    pending.delete(parsed.streamId)
    answer({ ok: parsed.ok, ...(parsed.error ? { error: parsed.error } : {}) })
  })

  /**
   * The worker's side of the page channel: an assembly request, relayed down and answered.
   *
   * The stream id is read back out of the url rather than carried as its own field, because
   * the url is what the popup has and what the worker looks the entry up by. Only one
   * assembly per stream is outstanding, so a second request for a stream already waiting is
   * refused rather than queued: the page has no way to answer two at once and the second
   * would wait for the first's file.
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only a message addressed to this tab. A content script's own `onMessage` also hears
    // every message the popup sends with `runtime.sendMessage`, because a content script is
    // part of the extension, so without this every tab in every window would try to relay a
    // request meant for the worker. Chrome marks the difference by putting the target tab on
    // the sender, and a message from `tabs.sendMessage` is the only kind that carries one.
    const addressedToThisTab = (sender as { tab?: { id?: number } } | undefined)?.tab
    if (!addressedToThisTab) return false

    const parsed = parseMessage(message)
    if (parsed?.name !== 'STREAM_ASSEMBLE') return false

    const streamId = streamIdFromUrl(parsed.payload.url)
    if (streamId === null || pending.has(streamId)) {
      sendResponse({ ok: false, error: 'not_listed' })
      return false
    }

    const settle = (answer: StreamAssembleResponse): void => {
      pending.delete(streamId)
      sendResponse(answer)
    }
    pending.set(streamId, settle)

    postToPage({
      source: PAGE_CHANNEL_SOURCE,
      type: 'assemble',
      token: TOKEN,
      streamId,
      ...(parsed.payload.filename ? { filename: parsed.payload.filename } : {}),
    })

    // Bounded, because the answer comes from the page and the page is not ours to trust to
    // answer at all.
    window.setTimeout(() => {
      if (pending.has(streamId)) settle({ ok: false, error: 'page_refused' })
    }, ASSEMBLY_TIMEOUT_MS)

    // The answer arrives after this listener has returned, so the channel is kept open.
    return true
  })

  /**
   * Watches for a URL change, using the same DOM observation this extension has always
   * used.
   *
   * The modern navigation API would say this directly, but it is not available in every
   * browser this extension runs in, and a body observer that checks the URL is the approach
   * already proven here. A timer would be simpler still and would keep running on every tab
   * for as long as it is open, which is the cost this avoids.
   *
   * The last URL is held here rather than passed in, because the observer and the
   * comparison have to read the same value or every mutation looks like a navigation.
   */
  const observer = new MutationObserver(() => {
    if (window.location.href === lastUrl) return

    lastUrl = window.location.href
    // The page moved without a reload, so the streams the hook holds are still the ones
    // playing. It is told the new url as well as being re-announced, because the stamp it
    // compares is the page url: without this the rows stay attributed to a page nobody is
    // on, and the worker treats a report for a new page as a new page and drops them.
    installHook()
    reportReady()
  })

  // On load, and again whenever the page's own navigation changes the URL without a
  // reload, which is how a single page app moves between videos.
  //
  // Nothing is reported yet. The worker already answers `observing` while it waits, and a
  // report claiming the page is ready before the hook has spoken would claim the page is
  // fully watched while its streams go unseen.
  installHook()

  window.setTimeout(() => {
    // Nothing at all has come back, so no hook is listening on this page. Saying so is the
    // difference between an empty list and a name for what went wrong, and `blocked` is a
    // state the popup already renders.
    if (!hookSeen) report('blocked')
  }, HOOK_HANDSHAKE_TIMEOUT_MS)

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true })
  }
}