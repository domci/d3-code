#!/usr/bin/env node

// Keeps the D3 keyboard inside Android's adaptive and splash safe zones.
//
// Full application artwork contains a rounded-square silhouette. Android masks the
// central 72dp of a 108dp adaptive canvas, so it needs the transparent keyboard master
// over a full-bleed channel background instead of a second rounded-square frame.
//
// The Android 12+ splash screen masks its icon to a circle covering the central two thirds
// of a 288dp canvas, which is the same proportion the launcher crops. Composing the two
// adaptive layers into one 288dp image therefore makes the splash frame the wordmark
// exactly like the launcher icon does.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

type IconVariant = "dev" | "nightly" | "prod";

// 108dp at xxxhdpi. Expo's prebuild derives every launcher density bucket from this.
const ADAPTIVE_CANVAS = 432;
// 288dp at xxxhdpi: the full Android 12+ splash canvas, so the icon needs no upscaling.
const SPLASH_CANVAS = 1152;
// Icon Composer's layer sources use a 128pt viewBox; the wordmark path spans this box.
const TEXT = { x: 15.53, y: 37, width: 94.5, height: 57 };
// Wordmark width as a fraction of the 108dp canvas. The visible area is 72dp (66dp
// guaranteed), so 0.48 leaves the letters at ~72% of the mask with room for the
// launcher's own zoom effects.
const WORDMARK_FRACTION = 0.48;
// Icon Composer positions layers on a 1024pt canvas, with translation relative to center.
const COMPOSER_CANVAS_PT = 1024;
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets";
// Production has no background artwork, so its splash composes onto the adaptive color.
const PRODUCTION_BACKGROUND_COLOR = "#000000";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

export class AndroidIconAssetsStaleError extends Schema.TaggedError<AndroidIconAssetsStaleError>()(
  "AndroidIconAssetsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Generated Android icons are stale:\n${this.paths.join("\n")}`;
  }
}

const wordmarkTransform = (size: number) => {
  const scale = (size * WORDMARK_FRACTION) / TEXT.width;
  const tx = (size - TEXT.width * scale) / 2 - TEXT.x * scale;
  const ty = (size - TEXT.height * scale) / 2 - TEXT.y * scale;
  return `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})`;
};

const canvasSvg = (size: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${inner}</svg>`;

// The layer sources clip to a 10pt rounded rectangle for the iOS silhouette. Android
// applies its own mask, so the layer must bleed to the canvas edge.
const fullBleed = (svg: string) =>
  svg.replace(/<rect width="128" height="128" rx="10"\/>/, '<rect width="128" height="128"/>');

const rasterize = (layer: string, svg: string, width: number, height = width) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY }).resize(width, height).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const composite = (
  layer: string,
  base: Buffer,
  overlays: ReadonlyArray<{ input: Buffer; left?: number; top?: number }>,
) =>
  Effect.tryPromise({
    try: () =>
      sharp(base)
        .composite([...overlays])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const solidCanvas = (layer: string, size: number, background: string) =>
  Effect.tryPromise({
    try: () =>
      sharp({ create: { width: size, height: size, channels: 4, background } })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const readLayerSource = Effect.fn("androidIcons.readLayerSource")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(
    path.join(repositoryRoot, "assets", variant, "app-icon.icon", "Assets", file),
  );
});

const renderForeground = Effect.fn("androidIcons.renderForeground")(function* (
  repositoryRoot: string,
  size: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = Buffer.from(
    yield* fs.readFile(path.join(repositoryRoot, BRAND_ASSET_PATHS.sourceAndroidForegroundPng)),
  );
  if (size === ADAPTIVE_CANVAS) return source;
  return yield* Effect.tryPromise({
    try: () => sharp(source).resize(size, size).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer: "foreground", cause }),
  });
});

const renderDevelopmentBackground = Effect.fn("androidIcons.renderDevelopmentBackground")(
  function* (repositoryRoot: string, size: number) {
    // The annotation layer shares the wordmark's coordinate space, so it is scaled and
    // centered the same way to keep the dimension lines around the letters.
    const annotations = yield* readLayerSource(repositoryRoot, "dev", "annotations.svg");
    const defs = annotations.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? "";
    const body = annotations.replace(/^[\s\S]*?<\/defs>/, "").replace(/<\/svg>\s*$/, "");
    const paper = yield* readLayerSource(repositoryRoot, "dev", "background.svg");
    const background = yield* rasterize("dev-background", fullBleed(paper), size);
    const overlay = yield* rasterize(
      "dev-annotations",
      canvasSvg(size, `${defs}<g transform="${wordmarkTransform(size)}">${body}</g>`),
      size,
    );
    return yield* composite("dev-background", background, [{ input: overlay }]);
  },
);

const renderNightlyBackground = Effect.fn("androidIcons.renderNightlyBackground")(function* (
  repositoryRoot: string,
  size: number,
) {
  // Positions mirror assets/nightly/app-icon.icon/icon.json. The SVG blur filter is
  // dropped because Icon Composer ignores it and it smears at this raster size.
  const clouds = [
    { file: "cloud-lower-left.svg", scale: 25, translation: [-309.6375, 268.66077693836917] },
    {
      file: "cloud-upper-right.svg",
      scale: 15,
      translation: [387.9605131881942, -134.30064713259117],
    },
  ] as const;
  const k = size / COMPOSER_CANVAS_PT;
  const overlays = yield* Effect.forEach(clouds, (cloud) =>
    Effect.gen(function* () {
      const width = Math.round(64 * cloud.scale * k);
      const height = Math.round(32 * cloud.scale * k);
      const left = Math.round((COMPOSER_CANVAS_PT / 2 + cloud.translation[0]) * k - width / 2);
      const top = Math.round((COMPOSER_CANVAS_PT / 2 + cloud.translation[1]) * k - height / 2);
      const source = yield* readLayerSource(repositoryRoot, "nightly", cloud.file);
      const png = yield* rasterize(
        cloud.file,
        source.replace(/ filter="url\(#soft\)"/, ""),
        width,
        height,
      );
      const x0 = Math.max(0, left);
      const y0 = Math.max(0, top);
      const x1 = Math.min(size, left + width);
      const y1 = Math.min(size, top + height);
      const clipped = yield* Effect.tryPromise({
        try: () =>
          sharp(png)
            .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
            .png()
            .toBuffer(),
        catch: (cause) => new AndroidIconRenderError({ layer: cloud.file, cause }),
      });
      return { input: clipped, left: x0, top: y0 };
    }),
  );
  const sky = yield* readLayerSource(repositoryRoot, "nightly", "background.svg");
  const background = yield* rasterize("nightly-background", fullBleed(sky), size);
  return yield* composite("nightly-background", background, overlays);
});

const renderBackground = Effect.fn("androidIcons.renderBackground")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  size: number,
) {
  switch (variant) {
    case "dev":
      return yield* renderDevelopmentBackground(repositoryRoot, size);
    case "nightly":
      return yield* renderNightlyBackground(repositoryRoot, size);
    case "prod":
      return yield* solidCanvas("prod-background", size, PRODUCTION_BACKGROUND_COLOR);
  }
});

const renderSplashIcon = Effect.fn("androidIcons.renderSplashIcon")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const background = yield* renderBackground(repositoryRoot, variant, SPLASH_CANVAS);
  const foreground = yield* renderForeground(repositoryRoot, SPLASH_CANVAS);
  return yield* composite(`${variant}-splash`, background, [{ input: foreground }]);
});

export const exportAndroidIcons = Effect.fn("exportAndroidIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const mark = yield* readLayerSource(repositoryRoot, "prod", "text.svg");
  const markPaths = (mark.match(/<path[^>]*\/>/g) ?? []).join("");
  const outputs = [
    ["android-icon-foreground.png", yield* renderForeground(repositoryRoot, ADAPTIVE_CANVAS)],
    [
      "android-icon-mark.png",
      yield* rasterize(
        "monochrome",
        canvasSvg(
          ADAPTIVE_CANVAS,
          `<g transform="${wordmarkTransform(ADAPTIVE_CANVAS)}">${markPaths}</g>`,
        ),
        ADAPTIVE_CANVAS,
      ),
    ],
    [
      "android-notification-icon.png",
      yield* rasterize(
        "notification",
        `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="7 29 111 74">${markPaths}</svg>`,
        96,
      ),
    ],
    [
      "android-icon-background-dev.png",
      yield* renderDevelopmentBackground(repositoryRoot, ADAPTIVE_CANVAS),
    ],
    [
      "android-icon-background-nightly.png",
      yield* renderNightlyBackground(repositoryRoot, ADAPTIVE_CANVAS),
    ],
    ["android-splash-icon-dev.png", yield* renderSplashIcon(repositoryRoot, "dev")],
    ["android-splash-icon-nightly.png", yield* renderSplashIcon(repositoryRoot, "nightly")],
    ["android-splash-icon-prod.png", yield* renderSplashIcon(repositoryRoot, "prod")],
  ] as const;
  if (checkOnly) {
    const stale = yield* Effect.filter(outputs, ([name, contents]) =>
      Effect.gen(function* () {
        const target = path.join(repositoryRoot, OUTPUT_DIRECTORY, name);
        return (
          !(yield* fs.exists(target)) || !Buffer.from(yield* fs.readFile(target)).equals(contents)
        );
      }),
    );
    if (stale.length > 0)
      return yield* new AndroidIconAssetsStaleError({ paths: stale.map(([name]) => name) });
    yield* Console.log(`All ${outputs.length} generated Android D3 icon assets are current.`);
    return;
  }
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  Command.run(
    Command.make(
      "export-android-icons",
      { check: Flag.Boolean("check").pipe(Flag.withDefault(false)) },
      ({ check }) => exportAndroidIcons(check),
    ),
    { version: "0.0.0" },
  ).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
