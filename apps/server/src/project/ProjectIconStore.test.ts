// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { make, PROJECT_ICON_MAX_BYTES, sniffProjectIconExtension } from "./ProjectIconStore.ts";

const layerTest = ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-icon-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

const writePending = (attachmentsDir: string, bytes: Uint8Array, extension = ".png") => {
  const id = createPendingAttachmentId();
  NodeFS.mkdirSync(attachmentsDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${id}${extension}`), bytes);
  return id;
};

describe("ProjectIconStore", () => {
  it("sniffs only the allowed raster types", () => {
    assert.equal(sniffProjectIconExtension(PNG), ".png");
    assert.equal(sniffProjectIconExtension(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), ".jpg");
    assert.equal(sniffProjectIconExtension(new TextEncoder().encode("GIF89a....")), ".gif");
    assert.equal(sniffProjectIconExtension(new TextEncoder().encode("RIFF....WEBPVP8 ")), ".webp");
    assert.isNull(sniffProjectIconExtension(new TextEncoder().encode("<svg></svg>")));
  });

  it.effect("moves a valid pending upload into the managed icons directory", () =>
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const store = yield* make;
      const id = writePending(attachmentsDir, PNG);
      const iconPath = yield* store.claim(`attachment:${id}`);
      assert.equal(NodePath.dirname(iconPath), NodePath.join(attachmentsDir, "project-icons"));
      assert.isTrue(iconPath.endsWith(".png"));
      assert.isTrue(NodeFS.existsSync(iconPath));
      assert.isFalse(NodeFS.existsSync(NodePath.join(attachmentsDir, `${id}.png`)));

      yield* store.remove(iconPath);
      assert.isFalse(NodeFS.existsSync(iconPath));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects svg disguised as an image, oversize files and unknown ids", () =>
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const store = yield* make;
      const svg = writePending(attachmentsDir, new TextEncoder().encode("<svg/>"), ".svg");
      const big = writePending(attachmentsDir, new Uint8Array(PROJECT_ICON_MAX_BYTES + 1).fill(1));
      const reasons = [
        yield* store.claim(`attachment:${svg}`).pipe(Effect.flip),
        yield* store.claim(`attachment:${big}`).pipe(Effect.flip),
        yield* store.claim(`attachment:${createPendingAttachmentId()}`).pipe(Effect.flip),
        // Only pending uploads can be claimed; a thread's attachment id cannot.
        yield* store
          .claim("attachment:thread-00000000-0000-4000-8000-000000000000")
          .pipe(Effect.flip),
        yield* store.claim("attachment:../../etc/passwd").pipe(Effect.flip),
      ].map((error) => error.reason);
      assert.deepEqual(reasons, [
        "unsupported-type",
        "too-large",
        "not-found",
        "not-found",
        "not-found",
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("only deletes files directly inside the managed directory", () =>
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const store = yield* make;
      const outside = NodePath.join(attachmentsDir, "outside.png");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(outside, PNG);
      yield* store.remove(outside);
      yield* store.remove(NodePath.join(attachmentsDir, "project-icons", "..", "outside.png"));
      yield* store.remove(null);
      assert.isTrue(NodeFS.existsSync(outside));
    }).pipe(Effect.provide(layerTest)),
  );
});
