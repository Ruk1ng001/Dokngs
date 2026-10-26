#!/usr/bin/env bun

import path from "node:path"

type FileEntry = { url: string; sha512: string; size: number; blockMapSize?: number }
type Manifest = { version: string; files: FileEntry[]; releaseDate: string }

// 与本仓库的四平台矩阵一致；任一分片缺失都不能发布部分更新清单。
const groups = [
  { name: "latest.yml", sources: ["latest-yml-x86_64-pc-windows-msvc"] },
  {
    name: "latest-mac.yml",
    sources: ["latest-yml-aarch64-apple-darwin", "latest-yml-x86_64-apple-darwin"],
  },
  { name: "latest-linux.yml", sources: ["latest-yml-x86_64-unknown-linux-gnu"] },
]

export async function finalizeLatestYml(input: { directory: string; output: string; version: string }) {
  const version = input.version.replace(/^v/, "")
  if (!/^\d+\.\d+\.\d+-dokng\.\d+$/.test(version)) throw new Error(`Invalid Dokng version: ${version}`)

  const manifests = await Promise.all(
    groups.map(async (group) => {
      const sources = await Promise.all(
        group.sources.map(async (source) => {
          const file = path.join(input.directory, source, group.name)
          const data = Bun.YAML.parse(await Bun.file(file).text()) as Manifest
          if (data?.version !== version) throw new Error(`Metadata version mismatch: ${file}`)
          if (typeof data.releaseDate !== "string" || !data.releaseDate)
            throw new Error(`Missing releaseDate: ${file}`)
          if (!Array.isArray(data.files) || !data.files.length) throw new Error(`Missing files: ${file}`)
          for (const entry of data.files) {
            if (
              !entry ||
              typeof entry.url !== "string" ||
              !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.url) ||
              typeof entry.sha512 !== "string" ||
              !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512) ||
              !Number.isSafeInteger(entry.size) ||
              entry.size <= 0
            )
              throw new Error(`Invalid update file entry: ${file}`)
          }
          return data
        }),
      )
      const files = sources.flatMap((source) => source.files)
      if (new Set(files.map((file) => file.url)).size !== files.length)
        throw new Error(`Duplicate update file URL: ${group.name}`)
      return { name: group.name, data: { version, files, releaseDate: sources[0]!.releaseDate } }
    }),
  )

  // 全部校验通过才落盘。两空格缩进保持后续 R2 URL 改写步骤的文本契约。
  for (const manifest of manifests) {
    await Bun.write(path.join(input.output, manifest.name), Bun.YAML.stringify(manifest.data, null, 2) + "\n")
    console.log(`finalized ${manifest.name}: ${manifest.data.files.length} files, ${version}`)
  }
}

if (import.meta.main) {
  const directory = process.env.LATEST_YML_DIR
  const output = process.env.RUNNER_TEMP
  const version = process.env.OPENCODE_VERSION
  if (!directory || !output || !version) throw new Error("LATEST_YML_DIR, RUNNER_TEMP and OPENCODE_VERSION are required")
  await finalizeLatestYml({ directory, output, version })
}
