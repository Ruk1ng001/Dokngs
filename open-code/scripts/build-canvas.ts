#!/usr/bin/env bun
// Build and copy after electron-vite has emptied out/renderer.
import { $ } from "bun"
import { cp, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const canvas = path.join(root, "infinite-canvas/web")
const output = path.join(root, "opencode/packages/desktop/out/renderer/canvas")

await $`bun install`.cwd(canvas)
await $`bun run build`.cwd(canvas).env({ ...process.env, VITE_BASE: "/canvas/" })

if (!(await Bun.file(path.join(canvas, "dist/index.html")).exists())) {
  throw new Error("Canvas build did not produce dist/index.html")
}

await rm(output, { recursive: true, force: true })
await cp(path.join(canvas, "dist"), output, { recursive: true })
console.log("[dokng] Embedded canvas is ready")
