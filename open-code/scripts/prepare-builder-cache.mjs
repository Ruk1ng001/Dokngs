import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, readFileSync } from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import vm from "node:vm"

// Run from packages/desktop after dependency installation. Read the installed
// tool getters so upstream upgrades supply their own release names and hashes.
const require = createRequire(path.resolve("package.json"))
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"))
const electronBuilderRequire = createRequire(require.resolve("electron-builder/package.json"))
const electronGet = require("app-builder-lib/out/util/electronGet")
const cacheDir = process.env.ELECTRON_BUILDER_CACHE
if (!cacheDir || !path.isAbsolute(cacheDir)) throw new Error("ELECTRON_BUILDER_CACHE must be an absolute path")
const repository = "electron-userland/electron-builder-binaries"
const requests = new Map()

class ToolsetRequest extends Error {
  constructor(options) {
    super(`Toolset requested: ${options.releaseName}/${options.filenameWithExt}`)
    this.options = options
  }
}

async function capture(getter) {
  try {
    await getter()
  } catch (error) {
    if (!(error instanceof ToolsetRequest)) throw error
    const { releaseName, filenameWithExt, checksums, githubOrgRepo = repository, overrideUrl } = error.options
    const checksum = checksums?.[filenameWithExt]
    if (
      githubOrgRepo !== repository || (overrideUrl && overrideUrl !== `https://github.com/${repository}/releases/download/${releaseName}`) ||
      !/^[A-Za-z0-9@._+-]+$/.test(releaseName) || releaseName.includes("..") ||
      !/^[A-Za-z0-9._+-]+$/.test(filenameWithExt) || filenameWithExt.includes("..") ||
      !/^[a-f0-9]{64}$/i.test(checksum ?? "")
    ) {
      throw new Error(`Unsupported builder toolset or missing SHA256: ${error.message}`)
    }
    requests.set(`${releaseName}/${filenameWithExt}`, { releaseName, filenameWithExt, checksum: checksum.toLowerCase() })
  }
}

// Stop each getter before it downloads, extracts, or runs a tool. This mutation
// is limited to this preparation process; electron-builder runs separately.
const originalDownload = electronGet.downloadBuilderToolset
electronGet.downloadBuilderToolset = (options) => { throw new ToolsetRequest(options) }
try {
  await capture(() => require("app-builder-lib/out/toolsets/7zip").getPath7za())
  await capture(() => require("app-builder-lib/out/toolsets/icons").getIconsToolsetPath())
  if (process.platform === "linux") {
    const { Arch } = builderRequire("builder-util")
    await capture(() => require("app-builder-lib/out/toolsets/linux").getAppImageTools(undefined, Arch[process.arch]))
  } else if (process.platform === "win32") {
    const windows = require("app-builder-lib/out/toolsets/windows")
    await capture(() => windows.getRceditBundle(undefined))
    await capture(() => windows.getMakeNsisPath(undefined))
    await capture(() => windows.getNsisPluginsPath(undefined))
  } else if (process.platform === "darwin") {
    // dmg-builder keeps this getter private. Evaluate only its installed
    // function with the same platform and our intercepted download function.
    const source = readFileSync(electronBuilderRequire.resolve("dmg-builder/out/dmgUtil"), "utf8")
    const getter = source.match(/async function getDmgVendorPath\(\) \{[\s\S]*?\n\}/)?.[0]
    if (!getter) throw new Error("Cannot locate the installed dmg-builder toolset getter")
    if (!process.env.CUSTOM_DMGBUILD_PATH) {
      await capture(() => vm.runInNewContext(`${getter}\ngetDmgVendorPath()`, {
        process: { arch: process.arch, env: {} }, path, electronGet_1: electronGet,
      }, { timeout: 1000 }))
    }
  } else {
    throw new Error(`Unsupported packaging platform: ${process.platform}`)
  }
} finally {
  electronGet.downloadBuilderToolset = originalDownload
}

if (process.argv.includes("--plan")) {
  console.log(JSON.stringify([...requests.values()], null, 2))
  process.exit(0)
}

async function sha256(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

const releases = new Map()
async function prepare({ releaseName, filenameWithExt, checksum }) {
  // 26.15's archive cache is deliberately stable. Builder verifies this file
  // against its embedded hash before extracting and writing its own cache state.
  const destination = path.join(cacheDir, releaseName, filenameWithExt)
  try {
    if (await sha256(destination) === checksum) {
      console.log(`Verified cached builder tool: ${releaseName}/${filenameWithExt}`)
      return
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.part`
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!releases.has(releaseName)) {
        const json = execFileSync("gh", ["api", `repos/${repository}/releases/tags/${encodeURIComponent(releaseName)}`], {
          encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 120_000,
        })
        releases.set(releaseName, JSON.parse(json))
      }
      const asset = releases.get(releaseName).assets.find((item) => item.name === filenameWithExt)
      if (!asset || !Number.isSafeInteger(asset.id)) throw new Error(`Missing official asset: ${releaseName}/${filenameWithExt}`)
      const handle = await open(temporary, "w")
      try {
        execFileSync("gh", ["api", `repos/${repository}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"], {
          stdio: ["ignore", handle.fd, "inherit"], timeout: 120_000,
        })
      } finally {
        await handle.close()
      }
      if (await sha256(temporary) !== checksum) throw new Error(`SHA256 mismatch: ${releaseName}/${filenameWithExt}`)
      await rm(destination, { force: true })
      await rename(temporary, destination)
      console.log(`Prepared official builder tool: ${releaseName}/${filenameWithExt} (SHA256 verified)`)
      return
    } catch (error) {
      await rm(temporary, { force: true })
      if (attempt === 3) throw error
      console.error(`Builder tool download failed for ${releaseName}/${filenameWithExt}; retrying in ${attempt * 2}s`)
      await setTimeout(attempt * 2000)
    }
  }
}

for (const request of requests.values()) await prepare(request)
