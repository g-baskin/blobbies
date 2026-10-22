#!/usr/bin/env node
// Draws the Android launcher icons: the desktop app's blue Blob peeking up
// from the bottom (src-tauri/icons/icon.png), as legacy square and round PNGs
// plus an adaptive icon (foreground PNG over a light background colour).
//
// Run after `tauri android init` or when the icon design changes:
//   node scripts/android-icons.mjs
// Uses @napi-rs/canvas, already in node_modules as a pdfjs-dist dependency.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// An optional dependency of pdfjs-dist, so resolve it from pdfjs-dist's real
// (pnpm store) location rather than the project root.
const pdfjs = realpathSync(join(root, "node_modules", "pdfjs-dist", "package.json"));
const require = createRequire(pdfjs);
const { createCanvas } = require("@napi-rs/canvas");

const res = join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");

// Same palette as BlobAvatar's "blue" tone.
const BLUE_PALE = "#6cb8fd";
const BLUE_DEEP = "#1f6ff0";
const EYE = "#12162b";
const BG_TOP = "#f9f9fb";
const BG_BOTTOM = "#ebebf0";

/**
 * The peeking Blob, drawn in the desktop icon's 512px design space where the
 * tile spans 52..462. Callers transform the context to place it.
 */
function drawBlob(ctx) {
  const fill = ctx.createLinearGradient(160, 240, 300, 520);
  fill.addColorStop(0, BLUE_PALE);
  fill.addColorStop(1, BLUE_DEEP);
  // A round dome whose widest point sits at the tile's bottom edge, so the
  // tile (or the launcher mask) is what cuts it off, as on the desktop icon.
  ctx.beginPath();
  ctx.ellipse(256, 464, 170, 224, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.save();
  ctx.clip();
  // Soft shine, upper left.
  const shine = ctx.createRadialGradient(205, 262, 2, 205, 262, 46);
  shine.addColorStop(0, "rgba(255,255,255,0.55)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.ellipse(205, 262, 52, 30, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = EYE;
  for (const [cx, cy, rx, ry, tilt] of [
    [196, 336, 15, 27, -0.12],
    [288, 318, 14, 25, -0.12],
  ]) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, tilt, 0, Math.PI * 2);
    ctx.fill();
  }
}

function tileBackground(ctx, top, bottom) {
  const bg = ctx.createLinearGradient(0, top, 0, bottom);
  bg.addColorStop(0, BG_TOP);
  bg.addColorStop(1, BG_BOTTOM);
  return bg;
}

/** Legacy square icon: the rounded tile, as on the desktop. */
function legacy(size, round) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const s = size / 512;
  ctx.scale(s, s);
  ctx.beginPath();
  if (round) {
    ctx.arc(256, 256, 236, 0, Math.PI * 2);
  } else {
    ctx.roundRect(28, 28, 456, 456, 100);
  }
  ctx.fillStyle = tileBackground(ctx, 28, 484);
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Tile is 456 here vs 410 on the desktop; scale the Blob to match.
  const k = 456 / 410;
  ctx.translate(28 - 52 * k, 28 - 52 * k);
  ctx.scale(k, k);
  drawBlob(ctx);
  ctx.restore();
  return canvas.toBuffer("image/png");
}

/**
 * Adaptive foreground: 108dp canvas whose inner 72dp is what the launcher
 * mask shows. The desktop tile (410px) maps onto that 72dp.
 */
function foreground(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const dp = size / 108;
  const k = (72 * dp) / 410;
  ctx.translate(18 * dp - 52 * k, 18 * dp - 52 * k);
  ctx.scale(k, k);
  drawBlob(ctx);
  return canvas.toBuffer("image/png");
}

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, scale] of Object.entries(densities)) {
  const dir = join(res, `mipmap-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ic_launcher.png"), legacy(Math.round(48 * scale), false));
  writeFileSync(join(dir, "ic_launcher_round.png"), legacy(Math.round(48 * scale), true));
  writeFileSync(join(dir, "ic_launcher_foreground.png"), foreground(Math.round(108 * scale)));
}

const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
const anydpi = join(res, "mipmap-anydpi-v26");
mkdirSync(anydpi, { recursive: true });
writeFileSync(join(anydpi, "ic_launcher.xml"), adaptive);
writeFileSync(join(anydpi, "ic_launcher_round.xml"), adaptive);
writeFileSync(
  join(res, "values", "ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BG_BOTTOM.replace("#", "#FF")}</color>
</resources>
`,
);

// A 512px preview of each, for review only (not part of the app).
const preview = process.argv[2];
if (preview) {
  writeFileSync(join(preview, "icon-preview-square.png"), legacy(512, false));
  writeFileSync(join(preview, "icon-preview-round.png"), legacy(512, true));
}
process.stdout.write(`android icons written to ${res}\n`);
