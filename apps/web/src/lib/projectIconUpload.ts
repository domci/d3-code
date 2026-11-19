import * as Effect from "effect/Effect";
import { msg } from "gt-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachmentEnvironment } from "../state/attachments";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { uploadBytes } from "./attachmentUploadQueue";

const PROJECT_ICON_MAX_BYTES = 1024 * 1024;
const PROJECT_ICON_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type ProjectIconMimeType = (typeof PROJECT_ICON_MIME_TYPES)[number];

export function validateProjectIconFile(file: File): string | null {
  if (!PROJECT_ICON_MIME_TYPES.includes(file.type as ProjectIconMimeType)) {
    return m(msg("Use a PNG, JPEG, WebP or GIF image."));
  }
  if (file.size === 0 || file.size > PROJECT_ICON_MAX_BYTES) {
    return m(msg("The image must be 1 MB or smaller."));
  }
  return null;
}

/** Uploads the icon to the environment as a pending attachment and returns the reference to save as `faviconPath`. */
export async function uploadProjectIcon(
  environmentId: EnvironmentId,
  file: File,
  onProgress?: (progress: number) => void,
): Promise<{ readonly reference: string; readonly discard: () => void }> {
  const mimeType = file.type as ProjectIconMimeType;
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    throw new Error(m(msg("This connection cannot upload files.")));
  }
  const result = await Effect.runPromise(
    runAttachmentUploadCycle({
      registry: appAtomRegistry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId,
      upload: { name: file.name || "icon", mimeType, sizeBytes: file.size },
      resolveUploadUrl: (relativeUrl) => {
        const connection = readPreparedConnection(environmentId);
        return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
      },
      transport: (url) =>
        Effect.tryPromise({
          try: (signal) =>
            uploadBytes({ url, file, mimeType, signal, onProgress: onProgress ?? (() => {}) }),
          catch: attachmentUploadError,
        }),
    }),
  );
  const discard = () => {
    if (result.attachmentId) {
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId,
        attachmentId: result.attachmentId,
      });
    }
  };
  if (result.status !== "uploaded") {
    discard();
    throw result.status === "failed" && result.error instanceof Error
      ? result.error
      : new Error(m(msg("Upload failed.")));
  }
  return { reference: `attachment:${result.attachmentId}`, discard };
}
