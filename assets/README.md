# Brand icons

The D3 keyboard artwork has three immutable source images:

- `source/d3-ios-1024.png`: full application artwork
- `source/d3-macos-1024.png`: desktop artwork with the native macOS safe area
- `source/d3-android-foreground.png`: transparent keyboard foreground

Run `vp run icons:export` from the repository root to regenerate the development,
nightly, and production application icons, web favicons, public copies, Android
resources, and marketing artwork.
Run `vp run icons:check` to verify that the generated assets match their sources
without changing files. Both commands use the installed Sharp dependency and
work without Icon Composer or a native GUI.

The production macOS master preserves the existing 1024×1024 artwork and its
824×824 opaque icon body inset 100 pixels on every side. Keep that safe area when
replacing the master. Development and nightly exports retain distinct channel
badges while using the same D3 keyboard: blue code brackets for development,
and a purple crescent for nightly.

The SVG layers in `dev/app-icon.icon`, `nightly/app-icon.icon`, and
`prod/app-icon.icon` remain D3 artwork for design editing; the raster masters
above own the exported application artwork. Do not edit generated PNG or ICO
files directly.

## Android launcher and splash artwork

Run `vp run icons:export:android` after changing the Android foreground or channel
backgrounds. Android masks the central 72dp of a 108dp adaptive canvas and the
central two thirds of a 288dp splash canvas, so the transparent keyboard must
remain inside those safe zones.

The exporter writes the shared foreground, development and nightly backgrounds,
and channel splash images to `apps/mobile/assets`. Production uses a solid
background. `android-icon-mark.png` supplies Android's monochrome themed icon;
the notification image and widget use the compact D3 vector. `icons:check`
also verifies all generated Android resources.
