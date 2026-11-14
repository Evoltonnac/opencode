import { Database } from "bun:sqlite"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { categories, type StorageMeasurement } from "../../packages/app/src/settings/storage/model"
import { capacityDatabaseKey } from "./settings"

export type StorageRoots = { data: string; cache: string; workspace: string; temporary?: string }

// No paths or SQL arrive from the browser. These are the dedicated service's deployed roots.
export const roots: StorageRoots = {
  data: "/var/lib/opencode/.local/share/opencode",
  cache: "/var/lib/opencode/.cache/opencode",
  workspace: "/srv/opencode/workspace",
  temporary: tmpdir(),
}

export async function collect(roots: StorageRoots): Promise<StorageMeasurement> {
  const result: StorageMeasurement = {
    sampledAt: new Date().toISOString(),
    totalBytes: 0,
    complete: true,
    sessions: 0,
    messages: 0,
    excludedDatabaseBytes: 0,
    categories: categories.map((id) => ({ id, bytes: 0, complete: true })),
  }
  const item = (id: (typeof categories)[number]) => result.categories.find((entry) => entry.id === id)!
  const main = await lstat(path.join(roots.data, "opencode.db"))
  const db = new Database(path.join(roots.data, "opencode.db"), { readonly: true, strict: true })
  try {
    db.run("PRAGMA busy_timeout=250")
    db.run("BEGIN")
    const page = Number(db.query("PRAGMA page_size").values()[0][0])
    const free = Number(db.query("PRAGMA freelist_count").values()[0][0]) * page
    result.sessions = Number(db.query("SELECT count(*) FROM session_v2").values()[0][0])
    result.messages = Number(db.query("SELECT count(*) FROM session_message").values()[0][0])
    // Unknown plugin state excludes the shared table. Our tiny numeric setting uses
    // shared metadata pages; only model-catalog overflow pages are disposable.
    const cacheOnly =
      Number(
        db.query("SELECT count(*) FROM kv WHERE key NOT LIKE 'models-dev:%' AND key != ?").values(capacityDatabaseKey)[0][0],
      ) === 0
    const objects = db
      .query<{ owner: string; bytes: number; overflowBytes: number }, [number]>(
        `
      SELECT coalesce(s.tbl_name, d.name) AS owner, sum(d.pgsize) AS bytes,
        sum(CASE WHEN d.pagetype = 'overflow' THEN d.pgsize ELSE 0 END) AS overflowBytes
      FROM dbstat d LEFT JOIN sqlite_schema s ON s.name=d.name
      WHERE d.pageno <= ?
      GROUP BY coalesce(s.tbl_name, d.name)
    `,
      )
      .all(Math.floor(main.size / page))
    for (const object of objects) {
      if (
        /^session_(v2|message|part|inbox)$/.test(object.owner) ||
        ["event", "blob", "blob_ref"].includes(object.owner)
      ) {
        item("conversations").bytes += object.bytes
        continue
      }
      if (object.owner.startsWith("instruction_")) item("cache").bytes += object.bytes
      if (object.owner === "kv" && cacheOnly) item("cache").bytes += object.overflowBytes
    }
    // Pages beyond the physical main file still live in WAL. The journal scan counts
    // them; counting their logical dbstat pages again would inflate the disk usage.
    const occupied = main.blocks * 512
    item("databaseFree").bytes = Math.min(
      free,
      Math.max(0, occupied - objects.reduce((sum, object) => sum + object.bytes, 0)),
    )
    result.excludedDatabaseBytes = Math.max(
      0,
      occupied - item("conversations").bytes - item("cache").bytes - item("databaseFree").bytes,
    )
    db.run("ROLLBACK")
  } finally {
    db.close()
  }

  const seen = new Set<string>()
  const deadline = Date.now() + 3000
  const budget = { remaining: 20_000 }
  async function walk(target: string, category: ReturnType<typeof item>, skip: readonly string[] = []) {
    if (budget.remaining-- <= 0 || Date.now() > deadline) {
      category.complete = false
      return
    }
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") category.complete = false
      return undefined
    })
    if (!stat || stat.isSymbolicLink()) return
    const identity = `${stat.dev}:${stat.ino}`
    if (seen.has(identity)) return
    seen.add(identity)
    if (stat.isFile()) {
      category.bytes += stat.blocks * 512
      return
    }
    if (!stat.isDirectory()) return
    const entries = await readdir(target).catch(() => {
      category.complete = false
      return []
    })
    for (const name of entries) {
      if (skip.includes(name)) continue
      await walk(path.join(target, name), category)
      if (!budget.remaining || Date.now() > deadline) {
        category.complete = false
        break
      }
    }
  }
  await walk(path.join(roots.data, "opencode.db-wal"), item("databaseJournal"))
  await walk(path.join(roots.data, "opencode.db-shm"), item("databaseJournal"))
  await walk(path.join(roots.data, "tool-output"), item("toolOutput"))
  await walk(path.join(roots.data, "log"), item("logs"))
  await walk(path.join(roots.data, "shell"), item("temporary"))
  await walk(path.join(roots.data, "repos"), item("cache"))
  await walk(roots.cache, item("cache"), ["bin"])
  await walk(roots.workspace, item("workspace"))
  if (roots.temporary) {
    const entries = await readdir(roots.temporary).catch(() => {
      item("temporary").complete = false
      return []
    })
    for (const name of entries) {
      if (name.startsWith("opencode-untracked-")) await walk(path.join(roots.temporary, name), item("temporary"))
    }
  }
  result.totalBytes = result.categories.reduce((sum, entry) => sum + entry.bytes, 0)
  result.complete = result.categories.every((entry) => entry.complete)
  return result
}
