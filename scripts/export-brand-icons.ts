#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, resolveWebIconOverrides } from "./lib/brand-assets.ts";
import { encodePngIco, readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";
import { exportAndroidIcons } from "./export-android-icons.ts";

const ICON_VARIANTS = [
  { label: "development", prefix: "assets/dev/blueprint", badge: "DEV", color: "#347FF8" },
  { label: "nightly", prefix: "assets/nightly/nightly", badge: "NIGHTLY", color: "#6D4CBF" },
  { label: "production", prefix: "assets/prod/black", badge: "", color: "" },
] as const;

export class IconExportRenderError extends Schema.TaggedError<IconExportRenderError>()(
  "IconExportRenderError",
  { cause: Schema.Defect() },
) {}

export class IconExportAssetsStaleError extends Schema.TaggedError<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const iosMaster = Buffer.from(
    yield* fs.readFile(path.join(repositoryRoot, BRAND_ASSET_PATHS.sourceIosIconPng)),
  );
  const macMaster = Buffer.from(
    yield* fs.readFile(path.join(repositoryRoot, BRAND_ASSET_PATHS.sourceMacIconPng)),
  );
  const mark = yield* fs.readFileString(
    path.join(repositoryRoot, "assets/prod/app-icon.icon/Assets/text.svg"),
  );
  const generated = yield* Effect.tryPromise({
    try: async () => {
      for (const master of [iosMaster, macMaster]) {
        const dimensions = readPngDimensions(master);
        if (dimensions.width !== 1024 || dimensions.height !== 1024) {
          throw new Error("D3 icon masters must be 1024×1024 PNGs.");
        }
      }
      const outputs = new Map<string, Buffer>();
      const compactMark = (mark.match(/<path[^>]*\/>/g) ?? []).join("");
      const socialBackground = Buffer.from(
        `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="630" fill="#101113"/><g transform="translate(590 80) scale(4)">${compactMark}</g></svg>`,
      );
      outputs.set(
        "apps/marketing/src/assets/social-card.webp",
        await sharp(socialBackground)
          .composite([
            { input: await sharp(iosMaster).resize(440, 440).png().toBuffer(), left: 60, top: 95 },
          ])
          .webp({ quality: 90 })
          .toBuffer(),
      );
      for (const variant of ICON_VARIANTS) {
        const render = async (master: Buffer, macos = false) => {
          if (!variant.badge) return master;
          const symbol =
            variant.label === "development"
              ? '<path d="M474 19L456 35L474 51M550 19L568 35L550 51M520 15L504 55" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
              : '<path d="M527 14A22 22 0 1 0 527 56A23 23 0 0 1 527 14Z" fill="white"/>';
          const badge = Buffer.from(
            `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0 ${macos ? 157 : 65})"><rect x="382" width="260" height="70" rx="35" fill="${variant.color}"/>${symbol}</g></svg>`,
          );
          return sharp(master)
            .composite([{ input: badge }])
            .png()
            .toBuffer();
        };
        const ios = await render(iosMaster);
        const macos = await render(macMaster, true);
        outputs.set(`${variant.prefix}-ios-1024.png`, ios);
        outputs.set(`${variant.prefix}-macos-1024.png`, macos);
        outputs.set(`${variant.prefix}-universal-1024.png`, ios);
        const sizes = await Promise.all(
          WINDOWS_ICON_SIZES.map(async (size) => ({
            size,
            contents: await sharp(ios).resize(size, size).png().toBuffer(),
          })),
        );
        const webPrefix = variant.label === "production" ? "assets/prod/d3" : variant.prefix;
        outputs.set(`${webPrefix}-windows.ico`, encodePngIco(sizes));
        outputs.set(
          `${webPrefix}-web-favicon.ico`,
          encodePngIco(sizes.filter(({ size }) => size === 16 || size === 32)),
        );
        for (const size of [16, 32, 180]) {
          outputs.set(
            `${webPrefix}-web-${size === 180 ? "apple-touch-180" : `favicon-${size}x${size}`}.png`,
            await sharp(ios).resize(size, size).png().toBuffer(),
          );
        }
        if (variant.label !== "development") {
          outputs.set(
            `apps/marketing/src/assets/icon${variant.label === "nightly" ? "-nightly" : ""}.webp`,
            await sharp(macos).webp({ quality: 90 }).toBuffer(),
          );
        }
      }
      for (const [brand, directory] of [
        ["development", "apps/web/public"],
        ["production", "apps/marketing/public"],
      ] as const) {
        for (const override of resolveWebIconOverrides(brand, directory)) {
          const contents = outputs.get(override.sourceRelativePath);
          if (!contents) throw new Error(`Missing generated icon: ${override.sourceRelativePath}`);
          outputs.set(override.targetRelativePath, contents);
        }
      }
      return outputs;
    },
    catch: (cause) => new IconExportRenderError({ cause }),
  });

  if (checkOnly) {
    const stale = yield* Effect.filter([...generated], ([relativePath, contents]) =>
      Effect.gen(function* () {
        const target = path.join(repositoryRoot, relativePath);
        return (
          !(yield* fs.exists(target)) || !Buffer.from(yield* fs.readFile(target)).equals(contents)
        );
      }),
    );
    if (stale.length > 0)
      return yield* new IconExportAssetsStaleError({
        paths: stale.map(([relativePath]) => relativePath),
      });
    yield* Console.log(`All ${generated.size} generated D3 icon assets are current.`);
    yield* exportAndroidIcons(true);
    return;
  }
  for (const [relativePath, contents] of generated) {
    const target = path.join(repositoryRoot, relativePath);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const temporary = yield* fs.makeTempFileScoped({
      directory: path.dirname(target),
      prefix: ".d3-icon-",
      suffix: ".tmp",
    });
    yield* fs.writeFile(temporary, contents);
    yield* fs.rename(temporary, target);
  }
  yield* Console.log(`Updated ${generated.size} D3 icon assets.`);
  yield* exportAndroidIcons(false);
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Verify generated assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check).pipe(Effect.scoped),
).pipe(Command.withDescription("Export D3 keyboard artwork for every app and release channel."));

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
