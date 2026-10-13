import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import sharp from "sharp";
import { assert, it } from "@effect/vitest";

import { exportBrandIcons } from "./export-brand-icons.ts";

it.effect("preserves production master artwork and rejects a stale generated icon", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");
    const image = (size: number, background: string) =>
      Effect.promise(() =>
        sharp({ create: { width: size, height: size, channels: 4, background } })
          .png()
          .toBuffer(),
      );
    const ios = yield* image(1024, "#00cc44");
    const mac = yield* image(1024, "#334455");
    const svg =
      '<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><defs></defs><rect width="128" height="128"/><path d="M20 40H100V90H20Z" fill="white"/></svg>';
    const files = new Map<string, Uint8Array>([
      [path.join(root, "assets/source/d3-ios-1024.png"), ios],
      [path.join(root, "assets/source/d3-macos-1024.png"), mac],
      [path.join(root, "assets/source/d3-android-foreground.png"), yield* image(432, "#00cc44")],
    ]);
    for (const filename of [
      "prod/app-icon.icon/Assets/text.svg",
      "dev/app-icon.icon/Assets/annotations.svg",
      "dev/app-icon.icon/Assets/background.svg",
      "nightly/app-icon.icon/Assets/background.svg",
      "nightly/app-icon.icon/Assets/cloud-lower-left.svg",
      "nightly/app-icon.icon/Assets/cloud-upper-right.svg",
    ]) {
      files.set(path.join(root, "assets", filename), Buffer.from(svg));
    }
    const readFile = (filename: string) =>
      Effect.sync(() => {
        const contents = files.get(filename);
        if (!contents) throw new Error(`Missing fixture: ${filename}`);
        return contents;
      });
    let temporaryIndex = 0;
    const fs = FileSystem.makeNoop({
      readFile,
      readFileString: (filename) =>
        readFile(filename).pipe(Effect.map((contents) => Buffer.from(contents).toString())),
      exists: (filename) => Effect.succeed(files.has(filename)),
      makeDirectory: () => Effect.void,
      makeTempFileScoped: () => Effect.succeed(`/virtual/icon-${temporaryIndex++}`),
      writeFile: (filename, contents) =>
        Effect.sync(() => {
          files.set(filename, contents);
        }),
      rename: (source, target) =>
        readFile(source).pipe(
          Effect.map((contents) => {
            files.set(target, contents);
            files.delete(source);
          }),
        ),
    });
    const run = (check: boolean) =>
      exportBrandIcons(check).pipe(
        Effect.scoped,
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provide(Path.layer),
      );

    yield* run(false);
    assert.deepEqual(files.get(path.join(root, "assets/prod/black-ios-1024.png")), ios);
    assert.deepEqual(files.get(path.join(root, "assets/prod/black-macos-1024.png")), mac);
    yield* run(true);

    files.set(path.join(root, "assets/prod/black-ios-1024.png"), mac);
    const result = yield* run(true).pipe(Effect.flip);
    assert.strictEqual(result._tag, "IconExportAssetsStaleError");
    if (result._tag === "IconExportAssetsStaleError")
      assert.deepEqual(result.paths, ["assets/prod/black-ios-1024.png"]);
  }).pipe(Effect.provide(Path.layer)),
);
