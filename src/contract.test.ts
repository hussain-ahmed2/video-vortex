import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Two rules that nothing else in the suite can catch, because both are about where code
// *is* rather than what it does.
//
// The first is AC-14: the shapes that cross a runtime boundary live in the engine and
// nowhere else. A second copy of a payload type in a runtime file compiles, passes every
// behavioural test, and then drifts, which is the failure the message contract exists to
// prevent. The second is AC-15: the YouTube surfaces this slice retired are gone, and
// nothing fails when one creeps back in a runtime file.
//
// Both are read from the source rather than from a rendered snapshot, which is the same
// trade the design token rules make: a duplicate declaration has no runtime symptom to
// observe until the two copies disagree.
//
// covers: AC-5, AC-14, AC-15

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)));

interface SourceFile {
  /** Path relative to `src`, with forward slashes, so a report is stable per machine. */
  file: string;
  source: string;
}

/**
 * Every TypeScript source file that is not a test.
 *
 * Test files are excluded on purpose: they quote message names and type names as
 * literals, which is a test doing its job rather than a second declaration.
 */
function sourceFiles(): SourceFile[] {
  const found: SourceFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      found.push({ file: relative(srcDir, full).split("\\").join("/"), source: readFileSync(full, "utf8") });
    }
  };

  walk(srcDir);
  return found;
}

describe("AC-14, the shapes that cross a runtime boundary have one home", () => {
  it("has source files to check, so this cannot pass by finding nothing", () => {
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  it("keeps every zod schema in the engine", () => {
    // A schema is how a payload is checked on receipt. One written in a runtime file is a
    // second contract that nothing else knows about, and the worker's parse is the only
    // thing standing between a malformed message and a half understood record.
    const outside = sourceFiles()
      .filter(({ file }) => !file.startsWith("engine/"))
      .filter(({ source }) => /z\.(object|enum|union|discriminatedUnion)\(/.test(source))
      .map(({ file }) => file);

    expect(outside).toEqual([]);
  });

  it("finds the engine's own schemas, so the rule above is looking at something real", () => {
    // A rule that matches nothing passes for the wrong reason. The engine is where the
    // schemas are supposed to be, so their presence there is what makes their absence
    // anywhere else mean something.
    const engine = readFileSync(join(srcDir, "engine", "messages.ts"), "utf8");

    expect(engine).toMatch(/z\.object\(/);
    expect(sourceFiles().filter(({ file }) => file.startsWith("engine/")).length).toBeGreaterThan(3);
  });

  it.each([
    ["MediaEntry", "engine/types.ts"],
    ["TabMedia", "engine/types.ts"],
    ["CONTRACT_VERSION", "engine/types.ts"],
    ["DownloadState", "engine/messages.ts"],
    ["DownloadStatus", "engine/messages.ts"],
    ["MediaEntryDraft", "engine/types.ts"],
  ])("declares %s in %s and nowhere else", (name, home) => {
    const declarations = sourceFiles()
      .filter(({ source }) =>
        new RegExp(`export (type|interface|const|function) ${name}\\b`).test(source)
      )
      .map(({ file }) => file);

    expect(declarations).toEqual([home]);
  });

  it("has no runtime file carrying its own copy of the old shared shapes", () => {
    // The file the old pipeline declared them in. Its return is the whole of AC-14's
    // first clause, and nothing else in the suite would notice it coming back.
    expect(existsSync(join(srcDir, "lib", "schemas.ts"))).toBe(false);
    expect(existsSync(join(srcDir, "lib", "schemas.test.ts"))).toBe(false);
  });

  it("keeps the engine's own exports out of the runtime files' import graphs", () => {
    // The mirror of the purity guard's rule, stated from the runtime side: a runtime
    // file may import the engine, never the other way round, and never a module that is
    // not the engine.
    const engineDir = resolve(srcDir, "engine");
    expect(existsSync(engineDir)).toBe(true);
  });
});

describe("AC-15, the retired YouTube surfaces are gone", () => {
  it.each([
    ["YouTubeMeta", "the banner's metadata type"],
    ["FETCH_YOUTUBE_DATA", "the message the popup used to ask for it"],
    ["GET_YOUTUBE_DATA", "the message the worker used to route it"],
    ["ytInitialPlayerResponse", "the page global the content script used to read"],
    ["googlevideo", "the header rewrite's host"],
    ["ytd-app", "the page element it sniffed for"],
  ])("has no %s left anywhere in the source", (needle, what) => {
    // Nothing fails when one of these returns: the shapes compile, the popup renders,
    // and the extension simply has a dead path again. It is a source rule or nothing.
    const found = sourceFiles()
      .filter(({ source }) => source.includes(needle))
      .map(({ file }) => `${file} (${what})`);

    expect(found).toEqual([]);
  });

  it("has no message name left that the contract does not name", () => {
    // The old names were the give away. A message the contract does not declare is a
    // second channel, which is exactly what spec 0001's contract forbids.
    const engine = readFileSync(join(srcDir, "engine", "messages.ts"), "utf8");
    const declared = [...engine.matchAll(/^\s{2}([A-Z_]+): \{ request:/gm)].map((match) => match[1]);
    expect(declared.sort()).toEqual([
      "DOWNLOAD_MEDIA",
      "DOWNLOAD_PROGRESS",
      "ENTRIES_REPORTED",
      "GET_TAB_MEDIA",
      "STREAM_ASSEMBLE",
      "TAB_MEDIA_UPDATED",
    ]);

    const used = new Set<string>();
    for (const { file, source } of sourceFiles()) {
      if (file.startsWith("engine/messages")) continue;
      for (const match of source.matchAll(/case '([A-Z_]+)'/g)) used.add(match[1]);
    }

    // The four the worker routes. `STREAM_ASSEMBLE` joined them in spec 0005 and is the one
    // message with two hops: the worker names the file, then forwards the request down to
    // the content script. It is listed here rather than left out so a seventh case in a
    // runtime is a red build rather than a second channel nobody notices.
    expect([...used].sort()).toEqual([
      "DOWNLOAD_MEDIA",
      "ENTRIES_REPORTED",
      "GET_TAB_MEDIA",
      "STREAM_ASSEMBLE",
    ]);
  });
});
