import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachmentEnvironment } from "../state/attachments";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { uploadBytes } from "./attachmentUploadQueue";

export const PROJECT_ICON_MAX_BYTES = 1024 * 1024;
export const PROJECT_ICON_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
type ProjectIconMimeType = (typeof PROJECT_ICON_MIME_TYPES)[number];

export function validateProjectIconFile(file: File): string | null {
  if (!PROJECT_ICON_MIME_TYPES.includes(file.type as ProjectIconMimeType)) {
    return "Use a PNG, JPEG, WebP or GIF image.";
  }
  if (file.size === 0 || file.size > PROJECT_ICON_MAX_BYTES) {
    return "The image must be 1 MB or smaller.";
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
    throw new Error("This connection cannot upload files.");
  }
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: { name: file.name || "icon", mimeType, sizeBytes: file.size },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => uploadBytes({ url, file, mimeType, onProgress: onProgress ?? (() => {}) }),
  });
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
      : new Error("Upload failed.");
  }
  return { reference: `attachment:${result.attachmentId}`, discard };
}
