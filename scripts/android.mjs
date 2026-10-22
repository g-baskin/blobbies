#!/usr/bin/env node
// Runs `tauri android <dev|build>` with the Android SDK, NDK and JDK found on
// this machine, so nobody has to edit their shell profile. Extra arguments are
// passed through, e.g. `pnpm android:build -- --target aarch64`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [mode = "dev", ...rest] = process.argv.slice(2);
const env = { ...process.env };

env.ANDROID_HOME ??= join(homedir(), "Library", "Android", "sdk");
if (!env.NDK_HOME) {
  const ndkDir = join(env.ANDROID_HOME, "ndk");
  const versions = existsSync(ndkDir) ? readdirSync(ndkDir).sort() : [];
  const preferred = versions.find((v) => v.startsWith("27.1")) ?? versions.at(-1);
  if (preferred) env.NDK_HOME = join(ndkDir, preferred);
}
if (!env.JAVA_HOME) {
  const jbr = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  if (existsSync(jbr)) env.JAVA_HOME = jbr;
}
for (const name of ["ANDROID_HOME", "NDK_HOME", "JAVA_HOME"]) {
  if (!env[name] || !existsSync(env[name])) {
    console.error(`android: ${name} not found. Install Android Studio (SDK + NDK) or set ${name}.`);
    process.exit(1);
  }
}

if (mode === "build") {
  // A debug APK carries full Rust debuginfo by default (~700 MB), which is
  // impractical to sideload onto a phone. Keep debug assertions, drop symbols.
  env.CARGO_PROFILE_DEV_DEBUG ??= "false";
  env.CARGO_PROFILE_DEV_STRIP ??= "debuginfo";
}

const args =
  mode === "build"
    ? [
        "tauri",
        "android",
        "build",
        "--debug",
        "--apk",
        ...(rest.length ? rest : ["--target", "x86_64"]),
      ]
    : ["tauri", "android", "dev", ...rest];
const result = spawnSync("pnpm", args, { stdio: "inherit", env });
process.exit(result.status ?? 1);
