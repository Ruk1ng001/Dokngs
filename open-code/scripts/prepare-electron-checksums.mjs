import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { setTimeout } from "node:timers/promises"

// Run from the desktop package, so this is the installed Electron version that
// electron-builder will package, including any upstream dependency update.
const require = createRequire(path.resolve("package.json"))
const version = require("electron/package.json").version
const output = process.env.CX_ELECTRON_CHECKSUMS
if (!output) throw new Error("CX_ELECTRON_CHECKSUMS must name the output JSON file")

async function github(...args) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 })
    } catch (error) {
      if (attempt === 3) throw error
      console.error(`GitHub release asset request failed; retrying in ${attempt * 15}s`)
      await setTimeout(attempt * 15_000)
    }
  }
}

const release = JSON.parse(await github(`repos/electron/electron/releases/tags/v${version}`))
const asset = release.assets.find((item) => item.name === "SHASUMS256.txt")
if (!asset || !Number.isSafeInteger(asset.id)) throw new Error(`Electron ${version} has no SHASUMS256.txt asset`)
const shasums = await github(
  `repos/electron/electron/releases/assets/${asset.id}`,
  "-H",
  "Accept: application/octet-stream",
)
const checksums = Object.fromEntries(
  shasums.trim().split(/\r?\n/).map((line) => {
    const match = /^([a-fA-F0-9]{64}) [ *](\S+)$/.exec(line)
    if (!match) throw new Error(`Electron ${version} returned an invalid SHA256 manifest`)
    return [match[2], match[1].toLowerCase()]
  }),
)
const filename = `electron-v${version}-${process.platform}-${process.arch}.zip`
if (!checksums[filename]) throw new Error(`Electron SHA256 manifest is missing ${filename}`)
writeFileSync(output, JSON.stringify(checksums, null, 2) + "\n")
console.log(`Prepared official SHA256 checksums for Electron ${version}; ZIP validation remains enabled`)
