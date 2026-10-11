export type MobileStageLabel = "Alpha" | "Dev";

/** The stage badge beside the brand title; the preview variant is the D3 Code app and has none. */
export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel | null {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return null;
  return "Alpha";
}
