import { mkdir, readFile, readdir, unlink, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Session snapshot storage: one JSON file per session under a directory.
 *
 * Writes are atomic — serialize to `<id>.json.tmp` in the same directory,
 * then rename over `<id>.json`. A crash at any point leaves either the old
 * complete snapshot or the new one, never a partial file.
 */
export class SessionStore {
  constructor(readonly path: string) {}

  async saveJSON(id: string, json: string): Promise<void> {
    await mkdir(this.path, { recursive: true })
    const target = join(this.path, `${id}.json`)
    const tmp = join(this.path, `${id}.json.tmp`)
    await writeFile(tmp, json, "utf-8")
    await rename(tmp, target)
  }

  async read(id: string): Promise<unknown> {
    const data = await readFile(join(this.path, `${id}.json`), "utf-8")
    return JSON.parse(data)
  }

  async delete(id: string): Promise<void> {
    await unlink(join(this.path, `${id}.json`)).catch(() => {})
  }

  async list(): Promise<string[]> {
    await mkdir(this.path, { recursive: true })
    const files = await readdir(this.path)
    return files
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""))
  }
}
