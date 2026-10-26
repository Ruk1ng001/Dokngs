import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { finalizeLatestYml } from "./finalize-latest-yml"

const roots: string[] = []
const version = "2.1.4-dokng.1"
const sha512 = Buffer.alloc(64, 7).toString("base64")
const sources = [
  ["latest-yml-x86_64-pc-windows-msvc", "latest.yml", ["dokng-win-x64.exe"]],
  ["latest-yml-aarch64-apple-darwin", "latest-mac.yml", ["dokng-mac-arm64.zip", "dokng-mac-arm64.dmg"]],
  ["latest-yml-x86_64-apple-darwin", "latest-mac.yml", ["dokng-mac-x64.zip", "dokng-mac-x64.dmg"]],
  ["latest-yml-x86_64-unknown-linux-gnu", "latest-linux.yml", ["dokng-linux-x86_64.AppImage"]],
] as const

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dokng-manifest-test-"))
  roots.push(root)
  const directory = path.join(root, "input")
  const output = path.join(root, "output")
  await Promise.all(
    sources.map(([source, filename, names]) =>
      Bun.write(
        path.join(directory, source, filename),
        Bun.YAML.stringify(
          {
            version,
            files: names.map((url) => ({ url, sha512, size: 1234, blockMapSize: 100 })),
            releaseDate: "2026-10-26T00:00:00Z",
          },
          null,
          2,
        ),
      ),
    ),
  )
  return { directory, output, version: `v${version}` }
}

test("merges both Mac architectures and preserves the R2 URL rewriting format", async () => {
  const input = await fixture()
  await finalizeLatestYml(input)
  const urls: string[] = []
  for (const name of ["latest.yml", "latest-mac.yml", "latest-linux.yml"]) {
    const text = await Bun.file(path.join(input.output, name)).text()
    const data = Bun.YAML.parse(text) as { version: string; files: { url: string; sha512: string; size: number; blockMapSize: number }[] }
    expect(data.version).toBe(version)
    expect(text.match(/^  - url: /gm)?.length).toBe(data.files.length)
    for (const file of data.files) {
      expect(file.sha512).toBe(sha512)
      expect(file.size).toBe(1234)
      expect(file.blockMapSize).toBe(100)
      urls.push(file.url)
    }
  }
  expect(urls).toEqual(sources.flatMap(([, , names]) => [...names]))
})

test("a missing Mac shard fails before any manifest is written", async () => {
  const input = await fixture()
  await rm(path.join(input.directory, sources[2][0], sources[2][1]))
  await expect(finalizeLatestYml(input)).rejects.toThrow()
  expect(await Bun.file(path.join(input.output, "latest.yml")).exists()).toBe(false)
})

test.each([
  ["mixed versions", { version: "2.1.3-dokng.1" }],
  ["empty files", { files: [] }],
  ["invalid checksum", { files: [{ url: "dokng.exe", sha512: "invalid", size: 1234 }] }],
  ["empty package", { files: [{ url: "dokng.exe", sha512, size: 0 }] }],
  ["unsafe filename", { files: [{ url: "../dokng.exe", sha512, size: 1234 }] }],
])("rejects %s before publishing manifests", async (_name, change) => {
  const input = await fixture()
  const file = path.join(input.directory, sources[0][0], sources[0][1])
  const data = Bun.YAML.parse(await Bun.file(file).text()) as Record<string, unknown>
  await Bun.write(file, Bun.YAML.stringify({ ...data, ...change }, null, 2))
  await expect(finalizeLatestYml(input)).rejects.toThrow()
  expect(await Bun.file(path.join(input.output, "latest-mac.yml")).exists()).toBe(false)
})
