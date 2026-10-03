// Owns the six messages the three runtimes send, their schemas, and the download
// shapes the popup needs. The only place a message name or payload shape is
// written down, so a runtime that declared its own would be a second contract.
//
// Every payload is parsed before a handler touches it. Chrome hands a listener an
// untyped value from another context, and a payload that type checks in the editor
// is exactly the one that turns out to be wrong on the wire.

import { z } from 'zod'

import { CONTRACT_VERSION, MediaEntryDraftSchema, TabMediaSchema, TabStatusSchema } from './types'

/**
 * Chrome's three download states, pinned to a union.
 *
 * A bare `string` here let a fourth value reach the popup's switch, and the states
 * table in spec 0003 is the only definition of how each one looks.
 */
export const DownloadStateSchema = z.enum(['in_progress', 'complete', 'interrupted'])
export type DownloadState = z.infer<typeof DownloadStateSchema>

/** A transfer as the popup sees it, whether it started this session or before it. */
export const DownloadStatusSchema = z.object({
  downloadId: z.number(),
  // Carried on the progress broadcast and on a cold read's `inFlight`, because a
  // popup opened mid download pairs a row to its transfer by url. Spec 0001's
  // message contract does not name it yet; spec 0004's API surface does.
  url: z.string(),
  bytesReceived: z.number(),
  // Null, not a number, for a total Chrome does not know: it reports that as minus
  // one, and the engine maps it here so no runtime has to remember the sentinel.
  totalBytes: z.number().nullable(),
  state: DownloadStateSchema,
})
export type DownloadStatus = z.infer<typeof DownloadStatusSchema>

/** Chrome reports an unknown total as minus one. Nothing downstream should see that. */
export function totalBytesOrNull(reported: number): number | null {
  return reported < 0 ? null : reported
}

/** A version stamp, required on every message a runtime sends to the worker. */
const ContractVersionSchema = z.literal(CONTRACT_VERSION)

// ─── The content script's report ────────────────────────────────────────────

export const EntriesReportedRequestSchema = z.object({
  contractVersion: ContractVersionSchema,
  pageUrl: z.string(),
  pageTitle: z.string(),
  status: TabStatusSchema,
  // Empty in this slice. No media entry originates in the content script, so the
  // payload is the title and the URL and nothing more.
  entries: z.array(MediaEntryDraftSchema),
})
export type EntriesReportedRequest = z.infer<typeof EntriesReportedRequestSchema>

export const EntriesReportedResponseSchema = z.object({ ok: z.literal(true) })
export type EntriesReportedResponse = z.infer<typeof EntriesReportedResponseSchema>

// ─── The popup's read ───────────────────────────────────────────────────────

export const GetTabMediaRequestSchema = z.object({
  contractVersion: ContractVersionSchema,
  tabId: z.number(),
})
export type GetTabMediaRequest = z.infer<typeof GetTabMediaRequestSchema>

export const GetTabMediaResponseSchema = z.object({
  record: TabMediaSchema.nullable(),
  // True when the worker has just put a content script on the page and the record
  // does not exist yet, so the popup waits for a broadcast rather than reading empty.
  needsReport: z.boolean(),
  // The record's own status, except the two the worker decides for itself:
  // `observing` when it has just injected, and `unsupported` when the tab cannot
  // host a content script at all.
  status: TabStatusSchema,
  // `chrome.downloads.search({})` returns every remembered download across every
  // tab and carries no tab id, so this is filtered to the urls in the record being
  // returned. Without that a row on this tab could show another tab's progress.
  inFlight: z.array(DownloadStatusSchema),
})
export type GetTabMediaResponse = z.infer<typeof GetTabMediaResponseSchema>

// ─── The worker's broadcasts ────────────────────────────────────────────────

// Neither broadcast carries the contract version. Both are sent by the worker to
// whatever version of the popup happens to be open, and refusing them on a version
// mismatch would stop a popup ever hearing about an update, which is the opposite of
// what a version check is for.

export const TabMediaUpdatedMessageSchema = z.object({ tabId: z.number() })
export type TabMediaUpdatedMessage = z.infer<typeof TabMediaUpdatedMessageSchema>

export const DownloadProgressMessageSchema = z.object({
  downloadId: z.number(),
  url: z.string(),
  bytesReceived: z.number(),
  totalBytes: z.number().nullable(),
  state: DownloadStateSchema,
})
export type DownloadProgressMessage = z.infer<typeof DownloadProgressMessageSchema>

// ─── The popup's download ───────────────────────────────────────────────────

/**
 * Takes a url and never a file name.
 *
 * The worker looks the entry up in its record and derives the name, so the rule
 * exists in one place and the popup cannot disagree with it about what a file is
 * called.
 */
export const DownloadMediaRequestSchema = z.object({
  contractVersion: ContractVersionSchema,
  url: z.string(),
})
export type DownloadMediaRequest = z.infer<typeof DownloadMediaRequestSchema>

export const DownloadMediaResponseSchema = z.object({
  ok: z.boolean(),
  downloadId: z.number().optional(),
  error: z.string().optional(),
})
export type DownloadMediaResponse = z.infer<typeof DownloadMediaResponseSchema>

// ─── The assembly request ───────────────────────────────────────────────────

/**
 * One name, two hops: the popup asks the worker, and the worker forwards to the
 * content script.
 *
 * A seventh message for the second hop was the alternative, and it was rejected
 * because the worker is the only party that knows the file name. So the name has to
 * survive the turn, which is why `filename` is optional rather than required: the
 * popup sends a url, the worker looks the entry up, derives the name by the same six
 * step rule a file download uses, and forwards both. One schema then parses at both
 * ends, and a schema without the field would let zod strip the name in transit and
 * the page would be handed a file called nothing.
 */
export const StreamAssembleRequestSchema = z.object({
  contractVersion: ContractVersionSchema,
  url: z.string(),
  filename: z.string().optional(),
})
export type StreamAssembleRequest = z.infer<typeof StreamAssembleRequestSchema>

/**
 * Why a stream could not be assembled.
 *
 * `not_listed` and `page_refused` are decided by the worker, `already_running` and
 * `no_bytes` by the page. Each already has a sentence the worker shows for the same
 * situation on a file, so the popup reuses those rather than owning new failure copy.
 */
export const StreamAssembleErrorSchema = z.enum([
  'not_listed',
  'already_running',
  'no_bytes',
  'page_refused',
])
export type StreamAssembleError = z.infer<typeof StreamAssembleErrorSchema>

export const StreamAssembleResponseSchema = z.object({
  ok: z.boolean(),
  error: StreamAssembleErrorSchema.optional(),
})
export type StreamAssembleResponse = z.infer<typeof StreamAssembleResponseSchema>

/** Every message this extension sends, keyed by name. */
export interface MessageMap {
  ENTRIES_REPORTED: { request: EntriesReportedRequest; response: EntriesReportedResponse }
  GET_TAB_MEDIA: { request: GetTabMediaRequest; response: GetTabMediaResponse }
  TAB_MEDIA_UPDATED: { request: TabMediaUpdatedMessage; response: never }
  DOWNLOAD_MEDIA: { request: DownloadMediaRequest; response: DownloadMediaResponse }
  DOWNLOAD_PROGRESS: { request: DownloadProgressMessage; response: never }
  STREAM_ASSEMBLE: { request: StreamAssembleRequest; response: StreamAssembleResponse }
}

export type MessageName = keyof MessageMap

/**
 * A message that has passed its schema, narrowed to its name.
 *
 * The handler still has to narrow on `name`, so this carries the pair rather than
 * hiding it: a payload that parses is not yet one this handler understands.
 */
export type ParsedMessage = {
  [Name in MessageName]: { name: Name; payload: MessageMap[Name]['request'] }
}[MessageName]

type RequestSchema = z.ZodType<MessageMap[MessageName]['request']>

const REQUEST_SCHEMAS = {
  ENTRIES_REPORTED: EntriesReportedRequestSchema,
  GET_TAB_MEDIA: GetTabMediaRequestSchema,
  TAB_MEDIA_UPDATED: TabMediaUpdatedMessageSchema,
  DOWNLOAD_MEDIA: DownloadMediaRequestSchema,
  DOWNLOAD_PROGRESS: DownloadProgressMessageSchema,
  STREAM_ASSEMBLE: StreamAssembleRequestSchema,
} satisfies { [Name in MessageName]: RequestSchema }

function isMessageName(value: unknown): value is MessageName {
  return typeof value === 'string' && value in REQUEST_SCHEMAS
}

/**
 * Parses anything arriving from another runtime.
 *
 * Returns null for an unrecognised name, a payload that fails its schema, or a
 * version that does not match. All three are dropped rather than guessed at, and the
 * caller counts them: a message that silently fails to parse is indistinguishable
 * from a message that was never sent.
 */
export function parseMessage(message: unknown): ParsedMessage | null {
  if (typeof message !== 'object' || message === null) return null

  const { name, payload } = message as { name?: unknown; payload?: unknown }
  if (!isMessageName(name)) return null

  const parsed = REQUEST_SCHEMAS[name].safeParse(payload)
  if (!parsed.success) return null

  return { name, payload: parsed.data } as ParsedMessage
}

/** Stamps a request with the contract version, so no call site can forget it. */
export function request<Name extends MessageName>(
  name: Name,
  payload: Omit<MessageMap[Name]['request'], 'contractVersion'>
): { name: Name; payload: MessageMap[Name]['request'] } {
  return {
    name,
    payload: { ...payload, contractVersion: CONTRACT_VERSION } as MessageMap[Name]['request'],
  }
}
