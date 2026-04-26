import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Emits a self-contained dist/ that can be installed as an OpenClaw plugin
// with no node_modules tree (avoids workspace symlinks tripping the install-time
// code safety scan).
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const dist = {
  name: src.name,
  version: src.version,
  description: src.description,
  type: "module",
  main: "./plugin.js",
  types: "./plugin.d.ts",
  openclaw: { extensions: ["./plugin.js"] },
  peerDependencies: src.peerDependencies ?? {},
};

const out = resolve(root, "dist");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "package.json"), JSON.stringify(dist, null, 2) + "\n");
copyFileSync(resolve(root, "openclaw.plugin.json"), resolve(out, "openclaw.plugin.json"));
console.log("[secure-apple-calendar] wrote dist/{package.json,openclaw.plugin.json}");
