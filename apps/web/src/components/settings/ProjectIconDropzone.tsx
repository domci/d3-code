import { ImageUpIcon } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { cn } from "../../lib/utils";

/** Drop target and click-to-browse button for a local image file. */
export function ProjectIconDropzone({
  disabled,
  busyLabel,
  error,
  onFile,
}: {
  disabled: boolean;
  /** Shown instead of the prompt while an upload is running. */
  busyLabel: string | null;
  error: string | null;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const inactive = disabled || busyLabel !== null;

  const pick = (file: File | undefined) => {
    if (file && !inactive) onFile(file);
  };
  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    pick(event.dataTransfer.files[0]);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={inactive}
        aria-label="Upload a project icon from this device"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          if (!inactive) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex h-9 items-center gap-2 rounded-md border border-dashed px-3 text-xs text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
          dragging && "border-primary bg-primary/5 text-foreground",
        )}
      >
        <ImageUpIcon className="size-4" aria-hidden />
        {busyLabel ?? "Drop an image or click to upload"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        tabIndex={-1}
        onChange={(event) => {
          pick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {error ? (
        <p role="alert" className="max-w-64 text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
