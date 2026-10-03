// The test side entry point: install the browser fakes, and reach their shapes.

export { installFakeChrome } from './chrome/install'
export { deliver, NO_RECEIVING_END, splitCallback } from './chrome/dual'
export { INJECTION_FAILED } from './chrome/scripting'
export {
  FakeMediaSource,
  FakeSourceBuffer,
  installFakeBlobUrls,
  installFakeMediaElements,
  installFakePageMedia,
} from './page-media'
export type {
  FakeBlobUrlsControl,
  FakeMediaElementsControl,
  FakeMediaSourceControl,
  FakePageMediaControl,
  FakeSourceBufferControl,
  FakeTimeRanges,
} from './page-media'
export type { FakeAction, FakeActionCall, FakeActionControl } from './chrome/action'
export type {
  FakeResponseDetails,
  FakeResponseHeader,
  FakeWebRequest,
  FakeWebRequestControl,
  FakeWebRequestEvent,
  FakeWebRequestRegistration,
} from './chrome/web-request'
export type { FakeScripting, FakeScriptingCall, FakeScriptingControl } from './chrome/scripting'
export type {
  FakeCallback,
  FakeChrome,
  FakeDownloadItem,
  FakeDownloads,
  FakeDownloadsControl,
  FakeEvent,
  FakeStorage,
  FakeStorageArea,
  FakeTab,
  FakeTabs,
  FakeTabsControl,
  MessageListener,
} from './chrome/types'
