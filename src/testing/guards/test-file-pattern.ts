// The one pattern that decides "is this file a test".
//
// It matches what the runner's default include matches, so a test the runner
// picks up can never be read by the guards as an untested module. Kept here as
// a single constant because it is used by both guards and asserted by their self
// tests, and a second copy is how the two drift apart.

export const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath)
}
