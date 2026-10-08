/**
 * Project icons uploaded from a client. The bytes arrive through the regular
 * attachment upload transport as a pending attachment. Saving the project with
 * `faviconPath: "attachment:<pending id>"` claims it: the file is validated and
 * moved into `<attachmentsDir>/project-icons/`, outside every repo checkout,
 * and the project then references the managed file by absolute path.
 *
 * @module ProjectIconStore
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

export const PROJECT_ICON_REFERENCE_PREFIX = "attachment:";
export const PROJECT_ICON_MAX_BYTES = 1024 * 1024;
const PROJECT_ICONS_DIRECTORY = "project-icons";

export class ProjectIconInvalidError extends Schema.TaggedError<ProjectIconInvalidError>()(
  "ProjectIconInvalidError",
  { reason: Schema.Literals(["not-found", "too-large", "unsupported-type", "unreadable"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "The uploaded icon is missing or expired. Upload it again.";
      case "too-large":
        return `Project icons can be at most ${PROJECT_ICON_MAX_BYTES / 1024 / 1024} MB.`;
      case "unsupported-type":
        return "Project icons must be PNG, JPEG, WebP or GIF images.";
      case "unreadable":
        return "The uploaded icon could not be read.";
    }
  }
}

/** Sniffs the real image type from magic bytes; the client-declared type is not trusted. */
export function sniffProjectIconExtension(
  bytes: Uint8Array,
): ".png" | ".jpg" | ".webp" | ".gif" | null {
  const startsWith = (offset: number, text: string) =>
    [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (bytes[0] === 0x89 && startsWith(1, "PNG\r\n")) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (startsWith(0, "GIF87a") || startsWith(0, "GIF89a")) return ".gif";
  if (startsWith(0, "RIFF") && startsWith(8, "WEBP")) return ".webp";
  return null;
}

export const isProjectIconReference = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.startsWith(PROJECT_ICON_REFERENCE_PREFIX);

/** Claims and removes managed project icon files. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const iconsDir = path.join(config.attachmentsDir, PROJECT_ICONS_DIRECTORY);

  /** Validates a pending upload and moves it into the managed icons directory. */
  const claim = Effect.fn("ProjectIconStore.claim")(function* (reference: string) {
    const attachmentId = reference.slice(PROJECT_ICON_REFERENCE_PREFIX.length);
    const sourcePath =
      parseThreadSegmentFromAttachmentId(attachmentId) === PENDING_ATTACHMENT_THREAD_SEGMENT
        ? resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId })
        : null;
    if (!sourcePath) return yield* new ProjectIconInvalidError({ reason: "not-found" });

    const unreadable = () => new ProjectIconInvalidError({ reason: "unreadable" });
    const info = yield* fileSystem.stat(sourcePath).pipe(Effect.mapError(unreadable));
    if (info.type !== "File") return yield* unreadable();
    if (Number(info.size) > PROJECT_ICON_MAX_BYTES) {
      return yield* new ProjectIconInvalidError({ reason: "too-large" });
    }
    const bytes = yield* fileSystem.readFile(sourcePath).pipe(Effect.mapError(unreadable));
    const extension = sniffProjectIconExtension(bytes);
    if (!extension) return yield* new ProjectIconInvalidError({ reason: "unsupported-type" });

    const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const finalPath = path.join(iconsDir, `${id}${extension}`);
    yield* fileSystem
      .makeDirectory(iconsDir, { recursive: true })
      .pipe(Effect.andThen(fileSystem.rename(sourcePath, finalPath)), Effect.mapError(unreadable));
    return finalPath;
  });

  /** Deletes a stored icon file; paths outside the managed directory are never touched. */
  const remove = Effect.fn("ProjectIconStore.remove")(function* (
    iconPath: string | null | undefined,
  ) {
    if (!iconPath) return;
    const relative = path.relative(iconsDir, path.resolve(iconPath));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
    if (relative.includes(path.sep)) return;
    yield* fileSystem
      .remove(path.join(iconsDir, relative), { force: true })
      .pipe(Effect.orElseSucceed(() => undefined));
  });

  return { claim, remove };
});
