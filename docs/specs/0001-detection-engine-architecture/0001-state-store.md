# 0001.2 State store

*Child of [0001 Detection engine architecture](index.md). No status line: the umbrella carries it.*

## Summary

This fixes where a tab's detected media lives and what one entry is. Today it lives in a `Map` inside the service worker, and Chrome stops that worker after 30 seconds of quiet, so a video found a minute ago is gone by the time the popup opens. After this, each tab's list lives in session storage (Chrome's short lived, in memory store that outlives the worker), one entry per file found, and the shape stays lean so later features add the fields they read.

## Decision

**Chosen option**: `chrome.storage.session`, one key per tab, reached through a `StateStore` port the worker fills and tests fill with an in memory version.

(basis: the chrome.storage documentation, which names session storage as the way to hold state that globals cannot, and your test target of pure logic with no browser present)

**Implementation skills**: `chrome-extensions` (`googlechrome/modern-web-guidance`, `.agents/skills/chrome-extensions/`)

## Data model

| Entity | Field | Type | Null | Notes |
|---|---|---|---|---|
| `TabMedia` | `tabId` | number | no | Primary key. One record per tab |
| | `pageUrl` | string | no | The page as of the last write. Compared against the tab's current URL on every read, which is how a stale list is caught |
| | `pageTitle` | string | no | `document.title`, supplied by the content script. Untrusted page text: the popup renders it as text, never as markup |
| | `status` | `'observing' \| 'ready' \| 'blocked' \| 'unsupported'` | no | Who sets each: `observing` when the worker injects a content script onto a tab with no record, `ready` on the first report, `blocked` when a page refused page level access, `unsupported` set by the worker when the tab cannot host a content script. Precedence when several extractors report: `unsupported` beats `blocked` beats `ready` beats `observing` |
| | `lastWriter` | string | no | Id of the extractor that wrote last. Its only reader is the diagnostics view (feature 16) |
| | `updatedAt` | number | no | Epoch milliseconds. Its only reader is the staleness display the popup shows next to the list, specified in [spec 0003](../0003-popup-design-language/index.md) |
| | `hiddenCount` | number | no | How many entries the cap dropped, not the total ever found. Set by the cap when it discards, carried through a merge, zero when nothing was dropped. It exists so the popup can say what it is not showing, which is the honesty cost of capping at 50. Its only reader is the disclosure specified in [spec 0003](../0003-popup-design-language/index.md) |
| `MediaEntry` | `url` | string | no | Part of the identity |
| | `container` | string | no | Part of the identity. `mp4`, `webm`, `m3u8`, … or `unknown`. Derived by the rules in `src/engine/media-rules.ts`: the URL path extension first, then the response content type, then `unknown` |
| | `quality` | string | no | Part of the identity. Free text (`'1080p'`, `'130kbps'`), never an enum, because sites invent labels. The fallback extractor always emits `unknown`; only a site extractor sets a real label |
| | `kind` | `'video' \| 'audio'` | no | Drives the two lists in the popup. Audio when the container or content type says so, video otherwise |
| | `sizeBytes` | number | yes | Only when the site or the response states it. Never computed: a wrong size in the UI is worse than no size |
| | `sources` | string[] | no | Extractor ids that found this entry. Two extractors on one file means one entry naming both |
| | `discoveredAt` | number | no | Epoch milliseconds, **refreshed on every merge**. It is a last seen time, not a first seen time, and the cap uses it |

Identity of an entry is `(tabId, url, container, quality)`. A second finding with the same identity merges into the existing entry.

One `TabMedia` owns many `MediaEntry` values. Deleting the tab's record deletes its entries. Nothing is shared across tabs, and nothing is written to disk.

## The merge rule

On a merge, field by field. Getting this wrong is how a list ends up with a quality label from one extractor and a size from another.

| Field | On a second finding with the same identity |
|---|---|
| `url`, `container`, `quality` | Unchanged. They are the identity |
| `sources` | Union with the reporting extractor id |
| `sizeBytes` | Newest non null wins. A null never overwrites a known size |
| `discoveredAt`, `updatedAt` | Refreshed to now |
| `lastWriter` | The reporting extractor |
| `kind` | Unchanged. The first classification stands, because re classifying the same file is not new information |

## The port

The engine never calls storage. It declares what it needs and the worker supplies it. The port is typed and therefore trusts whatever it returns; validation happens in the worker, not here.

| Operation | Signature | Notes |
|---|---|---|
| load | `load(tabId: number): Promise<TabMedia \| null>` | Returns whatever is stored. The worker parses it with the `TabMedia` schema before the engine sees it, and discards a record that fails, because a half understood record is worse than an empty one |
| save | `save(record: TabMedia): Promise<void>` | One key, `vv:tab:<tabId>`. One write per report, not one per entry |
| remove | `remove(tabId: number): Promise<void>` | On tab close, and when a read finds a stale record |
| tabs | `tabs(): Promise<number[]>` | The live tab ids, read from the index key. Never by reading every value |

The index key `vv:tabs` is maintained by the worker inside `save` and `remove`, in the same storage operation, so it cannot drift from the records it lists. On worker start the worker reconciles it once against the keys actually present, which is how a record left behind by a crash gets cleaned up.

Tests supply an in memory implementation of the same four operations. That is the whole reason the port exists.

## Lifecycle

| Event | What happens |
|---|---|
| Worker injects a content script onto a tab with no record | A record is created with `status: 'observing'` |
| First report arrives | Entries merge, `status` becomes `ready` unless the page refused page level access, one save |
| Later report arrives | Merge per the table above, one save, broadcast only if the record changed |
| Real navigation in the tab | The worker clears the record; the next injection recreates it |
| Page URL change without a reload | The content script reports it, the worker clears the record the same way |
| Popup opens, worker finds a stale record | The stored `pageUrl` is compared to the tab's current URL, a mismatch deletes the record and the read continues as if there were none |
| Report arrives for a different page than the record holds | The record is replaced, not merged into |
| Tab closed | The key is deleted and the tab leaves the index |
| Browser closes, or the extension is reloaded or updated | Everything is cleared by Chrome. Not a bug: the worker re injects, the content script reports again |

## Invariants

- At most 50 entries per tab. When full, the entry with the oldest `discoveredAt` is dropped, and because that is a last seen time, a source that keeps being reported is never the one dropped. At 50 entries of a few hundred bytes, the 10 MB quota is not a concern for a normal session.
- Merges for one tab run one at a time, in order, through a promise chain in the worker. A single writer is not sufficient: awaiting a read yields, so two reports can interleave between the read and the write and lose one of the two.
- A record that fails schema validation on read is discarded, not repaired, and the tab is treated as having no record.
- `sizeBytes` is either a number the site or the response gave, or null. Never computed.
- Nothing leaves the browser. No entry is sent anywhere.
- A field is added by the feature that reads it. The one documented exception is the `reason` on a draft finding, which is not stored at all: it exists so an extractor can be tested and so the diagnostics view can explain a decision later.

## Consequences

**Positive**:
- The list is there when the popup opens, whether or not the worker was stopped. This is the single biggest fix in the rebuild.
- A record is inspectable during development without attaching a debugger, because it is plain JSON in a known key.
- The port means the merge, identity and cap rules are unit testable with no browser at all.
- Refreshing `discoveredAt` on merge means a long lived tab playing one video does not slowly push its own entry out of the list.

**Negative / tradeoffs**:
- A write on every report, which means serialising the record each time. At this size that is cheap, and writes coalesce per report rather than per entry.
- Reloading the extension during development clears everything, so every reload looks like a bug until the worker re injects and the page reports again. Annoying, and it will bite repeatedly.
- Content scripts cannot read session storage unless it is explicitly opened up. The worker being the only writer makes this a non issue, and opening it up is not needed.
- A record that outlives its tab, after a crash, is cleaned up by the worker's start up reconciliation rather than immediately.
- Dropping the oldest at 50 means a page that really does expose more than 50 sources loses some. Chosen deliberately: a list a person can read beats a complete one they cannot. The popup says how many are being hidden, from `hiddenCount`, and the disclosure's wording and token are specified in [spec 0003](../0003-popup-design-language/index.md).

**Neutral**:
- `storage.session` needs no permission of its own beyond what the extension already asks for.
- `storage.local` is the right tool for scope feature 15 (download history) and the wrong tool here, because a live view of the current tab is not a log.

## Follow-up

- [ ] Feature 3 (test harness) supplies the in memory `StateStore` and should own the tests for merge, identity, cap and the per tab serialisation.
- [ ] Feature 4 should show a "showing 50 of N" line when the cap is being hit.
- [ ] Feature 7 adds a can this be saved as a file rule, feature 9 adds a thumbnail, feature 10 adds a duration. Add each field in that feature, not before. Note that feature 7's flag may be better as a derived rule than a stored field.
- [ ] Download history (feature 15) needs a different store with different retention. Write its own spec; do not widen this one.

## Rationale

Four options were weighed: session storage alone, session storage plus a keepalive ping on an open port, `storage.local`, and an offscreen document holding state in memory. Session storage alone won because it is the documented mechanism for exactly this problem and needs no trick to stay alive. The keepalive option was rejected on evidence rather than taste: an open port stopped resetting the worker timer in Chrome 114, so it depends on ping timing that Chrome can change, and it costs a timer per open tab. `storage.local` was rejected because it writes to disk, grows without bound, and answers a question this feature is not asking. The offscreen document was rejected as a whole extra context, in its own manifest, covering ground session storage already covers.

Two things in this child were wrong when first written and were corrected by the cross check. The claim that a single writer removes merge races was false, because an `await` in the middle of a read and write lets a second report interleave; the invariant is now per tab serialisation, which is a real mechanism rather than an assumption. And the merge rule had been described as newest wins while only ever defining how the finder list unions, which would have let a size from one extractor sit next to a quality from another. Both were the kind of gap that only shows up when someone asks what happens when two things arrive at once.
