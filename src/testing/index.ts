// The test side entry point: install the browser fakes, and reach their shapes.

export { installFakeChrome } from './chrome/install'
export { deliver, NO_RECEIVING_END, splitCallback } from './chrome/dual'
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
