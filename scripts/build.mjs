import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
const root = path.resolve(import.meta.dirname, "..");
const outdir = path.join(root, "dist");

if (existsSync(outdir)) await rm(outdir, { recursive: true });
await mkdir(outdir, { recursive: true });

const entryPoints = {
  content: "src/content/index.ts",
  background: "src/background/index.ts",
  popup: "src/popup/popup.ts",
  options: "src/options/options.ts",
};

const opts = {
  entryPoints,
  bundle: true,
  outdir,
  format: "iife",
  target: "es2022",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
} else {
  await build(opts);
}

// Copy static assets
await cp(path.join(root, "public"), outdir, { recursive: true });
console.log(`Built to ${outdir}`);
