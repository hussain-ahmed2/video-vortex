import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  Film,
  Loader2,
  Music,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";

import {
  formatBytes,
  formatHiddenCount,
  formatProgressLabel,
  formatStaleness,
  formatStreamNote,
  progressPercent,
} from "./engine/format";
import { deriveStreamState, isDownloadable, isListable, labelForStream } from "./engine/media-rules";
import {
  parseMessage,
  request,
  type DownloadMediaResponse,
  type DownloadProgressMessage,
  type DownloadStatus,
  type GetTabMediaResponse,
  type StreamAssembleResponse,
} from "./engine/messages";
import type { MediaEntry, TabMedia, TabStatus } from "./engine/types";

// The popup: it renders what the worker holds and sends it messages. It holds no
// detection rules, no merge rules and no file naming rule, which is why the engine
// modules above exist and why every value here arrives already decided.
//
// Four whole states, one per record status, plus the three disclosures the design
// language asked for: the hidden count, the staleness line, and the loading hint. The
// popup never re-reads detection data on a timer. It re-reads when the worker says
// something changed and when the person asks, and the only interval it runs recomputes
// one string from a timestamp it already holds.

/** Rows shown as skeletons while the first report is on its way. */
const SKELETON_ROWS = 4;

/** How long `observing` is allowed to last before the popup offers a hint. */
const HINT_AFTER_MS = 3000;

/** How often the staleness string is recomputed. Reads nothing. */
const STALENESS_INTERVAL_MS = 1000;

interface PopupState {
  record: TabMedia | null;
  status: TabStatus;
  /** True while the worker has just put a content script on the page. */
  waiting: boolean;
  /** When the current wait for a first report began, for the loading hint. */
  observingSince: number | null;
  /** Keyed by url, so a row and its transfer are paired on a cold read too. */
  transfers: Record<string, DownloadStatus>;
  /** Set when a download call was refused, keyed by url. */
  failures: Record<string, string>;
  /**
   * Streams the page has been handed to the browser, keyed by url.
   *
   * Separate from `transfers` because a stream has no transfer to watch. We produce the file
   * and the browser takes it from there, so there is nothing of ours left to observe and the
   * row can only say it was sent.
   */
  sent: Record<string, true>;
}

const EMPTY_STATE: PopupState = {
  record: null,
  status: "observing",
  waiting: true,
  observingSince: null,
  transfers: {},
  failures: {},
  sent: {},
};

/**
 * What a row calls itself.
 *
 * A file is named by the last segment of its url, which is how a person tells one of a
 * page's twelve files from another. A stream has no address to read, and the one it was
 * given ends in a uuid, so it is named by the engine from its id and origin instead. Reading
 * the minted url here would put the same label on every stream row of a page.
 */
function labelFor(entry: MediaEntry): string {
  if (entry.stream) return labelForStream(entry.stream);

  try {
    const { pathname } = new URL(entry.url);
    const segment = pathname.slice(pathname.lastIndexOf("/") + 1);
    return segment || entry.container;
  } catch {
    return entry.container;
  }
}

const App = () => {
  const [state, setState] = useState<PopupState>(EMPTY_STATE);
  const [now, setNow] = useState(() => Date.now());

  // Which tab this popup is about, known as soon as the tab is resolved rather than when
  // an answer comes back. It decides whether a broadcast is ours to act on, and the
  // broadcast that ends the wait is caused by a read whose answer has not landed yet, so
  // learning the tab from that answer is what lost it.
  const tabIdRef = useRef<number | undefined>(undefined);
  const readingRef = useRef(false);
  const readAgainRef = useRef(false);

  const readOnce = useCallback(async (): Promise<void> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;
    if (tabId === undefined) return;
    tabIdRef.current = tabId;

    // A rejected message means the worker was removed, reloading, or unreachable, and it
    // is not a fact about this page. Letting it escape would be an unhandled rejection in
    // the popup and a read that never settles, so it is caught and the popup keeps what it
    // last knew. Refresh is the control that tries again, and the spec's copy for "we
    // cannot tell you about this page" belongs to a page that cannot host a script, which
    // is a different thing and would be a lie here.
    let response: GetTabMediaResponse | undefined
    try {
      response = (await chrome.runtime.sendMessage(
        request("GET_TAB_MEDIA", { tabId })
      )) as GetTabMediaResponse | undefined;
    } catch {
      return;
    }
    if (!response) return;

    setState((previous) => ({
      ...previous,
      record: response.record,
      status: response.status,
      waiting: response.needsReport,
      observingSince: response.needsReport ? Date.now() : null,
      // A cold read carries whatever is in flight, so reopening the popup mid download
      // shows the progress instead of forgetting it.
      transfers: Object.fromEntries(response.inFlight.map((item) => [item.url, item])),
    }));
  }, []);

  const read = useCallback(async (): Promise<void> => {
    // A read in flight cannot be re-read, so a trigger that arrives during one is kept and
    // honoured the moment it finishes. This is what makes a broadcast that lands mid read
    // count: the popup's own read is what makes the content script report, so the
    // broadcast that ends the wait arrives while that read is still unanswered, and
    // dropping it left the popup watching a page that was already listed. It also means
    // the last answer to land is the one from the read that saw the finished state.
    if (readingRef.current) {
      readAgainRef.current = true;
      return;
    }
    readingRef.current = true;
    try {
      do {
        readAgainRef.current = false;
        await readOnce();
      } while (readAgainRef.current);
    } finally {
      readingRef.current = false;
    }
  }, [readOnce]);

  useEffect(() => {
    // Started from a promise callback rather than inline, because the read is a message
    // round trip: its answer, and the state it sets, arrive after this effect's body has
    // already returned.
    void Promise.resolve().then(read);
  }, [read]);

  useEffect(() => {
    const onMessage = (message: unknown): void => {
      const parsed = parseMessage(message)

      if (parsed?.name === "TAB_MEDIA_UPDATED") {
        // A broadcast naming another tab is not ours to act on.
        if (parsed.payload.tabId === tabIdRef.current) void read();
        return;
      }

      if (parsed?.name === "DOWNLOAD_PROGRESS") {
        const progress: DownloadProgressMessage = parsed.payload;
        setState((previous) => ({
          ...previous,
          transfers: { ...previous.transfers, [progress.url]: progress },
          failures: omit(previous.failures, progress.url),
        }));
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [read]);

  // The only timer in the popup. It recomputes one string from a timestamp already
  // held, which is what keeps AC-6 true: no detection data is re-read on a timer.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), STALENESS_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // The loading hint is a decided wait rather than a data value, and it is derived from
  // the tick above rather than held in state of its own: one clock, one render.
  const hintVisible =
    state.observingSince !== null && now - state.observingSince >= HINT_AFTER_MS;

  /**
   * Asks for a row's file, by whichever path that row takes.
   *
   * A file is fetched by the worker from its url. A stream cannot be: there is no address to
   * fetch and the bytes are in the page, so the page assembles the file and the worker only
   * names it. Two paths, two messages, and the row says which one it took by what it does
   * afterwards rather than by asking.
   */
  const download = useCallback(async (entry: MediaEntry): Promise<void> => {
    const { url } = entry;
    const isStream = entry.stream !== undefined;

    setState((previous) => ({
      ...previous,
      failures: omit(previous.failures, url),
      // Cleared on a new attempt, so a row that failed once and is pressed again starts from
      // its control rather than from the last thing that went wrong.
      sent: omit(previous.sent, url),
    }));

    let response: DownloadMediaResponse | StreamAssembleResponse | undefined
    try {
      response = (await chrome.runtime.sendMessage(
        isStream ? request("STREAM_ASSEMBLE", { url }) : request("DOWNLOAD_MEDIA", { url })
      )) as DownloadMediaResponse | StreamAssembleResponse | undefined;
    } catch {
      // Unreachable rather than refused, and the person still needs their row back, which
      // is the same outcome and the same copy as a refusal.
      response = undefined;
    }

    if (response?.ok) {
      // Not "Saved", because we never see whether it saved. The page produced the file and
      // the browser owns it from here, so the honest claim is that it was sent.
      if (isStream) {
        setState((previous) => ({ ...previous, sent: { ...previous.sent, [url]: true } }));
      }
      return;
    }

    // The row goes back to its control, and says why. A row stuck on a spinner after
    // a refused download is the one state a person cannot act on.
    setState((previous) => ({
      ...previous,
      transfers: omit(previous.transfers, url),
      sent: omit(previous.sent, url),
      // A file keeps the sentence it has always shown. A stream gets the reason, because the
      // four reasons are four different problems for the person looking at them and one of
      // them, already assembling, is worth knowing before pressing again.
      failures: { ...previous.failures, [url]: isStream ? failureOf(response) : "Download failed" },
    }));
  }, []);

  // Asked here as well as in the worker, from the same engine rule, so a record written by a
  // build from before the rule existed cannot put a row on screen that has nothing to say.
  // A stream still collecting and an encrypted one are the two that are held back.
  const entries = (state.record?.entries ?? []).filter(isListable);
  const video = entries.filter((entry) => entry.kind === "video");
  const audio = entries.filter((entry) => entry.kind === "audio");

  return (
    <div className="flex min-h-[520px] max-h-[600px] w-[420px] flex-col bg-background font-sans text-foreground antialiased">
      <header className="flex items-center justify-between gap-3 border-b border-border p-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
            <Zap aria-hidden className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            {/* The page's own title, which is untrusted text and is rendered as text.
                The brand only stands in until a report has named the page. */}
            <h1 className="truncate text-sm font-semibold leading-tight">
              {state.record?.pageTitle || "Video Vortex"}
            </h1>
            <p className="truncate text-xs text-subtle-foreground">
              {hostnameOf(state.record?.pageUrl)}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {entries.length > 0 && (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {entries.length}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh the list"
            // A re-read and a re-injection, not a rescan: the contract has no message
            // that starts detection, by design.
            onClick={() => void read()}
          >
            <RefreshCw aria-hidden className="size-4" />
          </Button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col p-3">
        {state.status === "unsupported" ? (
          <Notice
            icon={TriangleAlert}
            title="This page cannot be watched"
            description="Browser and store pages cannot be read. Open a normal web page and try again."
          />
        ) : state.status === "blocked" ? (
          <Notice
            icon={ShieldAlert}
            title="This page blocks access"
            description="The page refused to share what it is playing."
          />
        ) : state.status === "observing" ? (
          <Observing hintVisible={hintVisible} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No media found on this page"
            // The second sentence used to say that a video built inside the browser cannot
            // be seen from outside the page. That was true when this extension only watched
            // the network, and this slice made it false, so it is gone rather than left
            // standing as a claim the extension no longer believes. The case it described is
            // now covered by the observing hint, which is shown when a page is still being
            // watched, and by `blocked`, which names a page that refused us.
            description="Play something and it will appear here. Media already playing when the popup was opened is only seen after the page reloads."
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col">
              {video.length > 0 && (
                <EntryList
                  kind="video"
                  entries={video}
                  transfers={state.transfers}
                  failures={state.failures}
                  sent={state.sent}
                  onDownload={download}
                />
              )}
              {audio.length > 0 && (
                <EntryList
                  kind="audio"
                  entries={audio}
                  transfers={state.transfers}
                  failures={state.failures}
                  sent={state.sent}
                  onDownload={download}
                />
              )}

              {/* The three disclosures, each shown only under its stated condition. */}
              <div className="flex items-center justify-between gap-3 pt-2 text-xs text-subtle-foreground">
                <span>
                  {state.record && state.record.hiddenCount > 0
                    ? formatHiddenCount(entries.length, state.record.hiddenCount)
                    : ""}
                </span>
                <span>{state.record ? formatStaleness(state.record.updatedAt, now) : ""}</span>
              </div>
            </div>
          </ScrollArea>
        )}
      </main>

      <footer className="flex items-center gap-2 border-t border-border p-3 text-xs text-subtle-foreground">
        <ShieldCheck aria-hidden className="size-3.5" />
        <span>Nothing you see here leaves your browser.</span>
      </footer>
    </div>
  );
};

function omit<T>(source: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
}

/**
 * What a stream's refusal says on its row.
 *
 * Four reasons, and three of them are situations the worker already has a sentence for on a
 * file, so those are reused rather than a second set of words invented for streams. Anything
 * unrecognised falls through to the one generic sentence rather than printing a reason code
 * at somebody.
 */
function failureOf(
  response: DownloadMediaResponse | StreamAssembleResponse | undefined
): string {
  const reason = response && "error" in response ? response.error : undefined;
  if (typeof reason !== "string") return "Download failed";

  switch (reason) {
    case "already_running":
      return "One download is already being assembled";
    case "no_bytes":
      return "There is nothing to save yet";
    case "not_listed":
      return "That file is no longer listed for this page";
    case "page_refused":
      return "The page would not hand the file over";
    default:
      return reason;
  }
}

function hostnameOf(pageUrl: string | undefined): string {
  if (!pageUrl) return "";
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return "";
  }
}

/** The watch is running and nothing has arrived yet. Never the empty state. */
function Observing({ hintVisible }: { hintVisible: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Watching this page</p>
      {Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
        <div key={index} className="flex min-h-10 items-center gap-3 border-b border-border px-3">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
      ))}
      {hintVisible && (
        <p className="pt-1 text-xs text-muted-foreground">
          Still watching. Media already on the page is only seen when it is requested, so
          reload the page if it played before you opened this.
        </p>
      )}
    </div>
  );
}

interface EntryListProps {
  kind: "video" | "audio";
  entries: MediaEntry[];
  transfers: Record<string, DownloadStatus>;
  failures: Record<string, string>;
  sent: Record<string, true>;
  onDownload: (entry: MediaEntry) => void;
}

/** One of the two lists, headed by what it holds so the split is never colour alone. */
function EntryList({ kind, entries, transfers, failures, sent, onDownload }: EntryListProps) {
  const Icon = kind === "audio" ? Music : Film;

  return (
    <section aria-label={kind === "audio" ? "Audio" : "Video"}>
      <h2 className="flex items-center gap-2 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        {kind === "audio" ? "Audio" : "Video"} ({entries.length})
      </h2>
      <ul>
        {entries.map((entry) => (
          <MediaRow
            key={`${entry.url}|${entry.container}|${entry.quality}`}
            entry={entry}
            transfer={transfers[entry.url]}
            failure={failures[entry.url]}
            sent={sent[entry.url] === true}
            onDownload={onDownload}
          />
        ))}
      </ul>
    </section>
  );
}

interface MediaRowProps {
  entry: MediaEntry;
  transfer: DownloadStatus | undefined;
  failure: string | undefined;
  sent: boolean;
  onDownload: (entry: MediaEntry) => void;
}

function MediaRow({ entry, transfer, failure, sent, onDownload }: MediaRowProps) {
  const kind = entry.kind;
  const TypeIcon = kind === "audio" ? Music : Film;
  const label = labelFor(entry);
  // The entry, not its container. A live broadcast and a stream the page capped are both
  // `webm` and both perfectly savable containers, and neither can be handed over as a file.
  const savable = isDownloadable(entry);
  const note = entry.stream ? formatStreamNote(deriveStreamState(entry.stream)) : null;

  const inProgress = transfer?.state === "in_progress";
  const complete = transfer?.state === "complete";
  const interrupted = transfer?.state === "interrupted";
  const percent = inProgress && transfer ? progressPercent(transfer.bytesReceived, transfer.totalBytes) : null;

  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.15, ease: "easeOut" } }}
      exit={{ opacity: 0, transition: { duration: 0.15, ease: "easeIn" } }}
      className="flex min-h-10 items-center gap-3 border-b border-border px-3 text-foreground"
    >
      <TypeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-subtle-foreground">
          {/* The word is here as well as on the icon, so the two lists are told apart
              without relying on either colour or a picture. */}
          {kind === "audio" ? "Audio" : "Video"} · {entry.container}
          {/* No page supplied a quality for a stream, so the line would otherwise print the
              word "unknown" on every row and tell a person nothing. */}
          {entry.stream ? "" : ` · ${entry.quality}`} · {formatBytes(entry.sizeBytes)}
        </p>
        {/* Why there is no control. A row with nothing to press and nothing to say reads as
            the extension being broken rather than as an honest answer. */}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>

      {inProgress && transfer ? (
        <div className="flex shrink-0 items-center gap-2">
          {/* The spinner takes the download control's place. It is why the bar need
              not move when the total is unknown: the row already says it is working. */}
          <Loader2
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
          />
          <Progress
            value={percent ?? undefined}
            aria-label={formatProgressLabel(transfer)}
            className="w-16"
          />
          <span className="sr-only">{formatProgressLabel(transfer)}</span>
        </div>
      ) : null}

      {/* A row whose container is a manifest carries no control at all, and neither does a
          live or partial stream. Offering one would hand someone a playlist file that will
          not play, or a download of an endless stream that would never finish. */}
      {savable && !inProgress && !complete && !interrupted && !sent ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Download ${kind}, ${label}, ${formatBytes(entry.sizeBytes)}`}
          onClick={() => onDownload(entry)}
        >
          <Download aria-hidden className="size-4" />
        </Button>
      ) : null}

      {/* Not "Saved". The page produced the file and the browser owns it from here, so
          there is nothing of ours left to watch and the honest claim is that it was sent. */}
      {sent ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Check aria-hidden className="size-4" />
          Sent to your downloads
        </span>
      ) : null}

      {complete ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Check aria-hidden className="size-4" />
          Saved
        </span>
      ) : null}

      {interrupted || failure ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-destructive">
          <AlertCircle aria-hidden className="size-4" />
          {failure ?? "Download interrupted"}
        </span>
      ) : null}
    </motion.li>
  );
}

export default App;
