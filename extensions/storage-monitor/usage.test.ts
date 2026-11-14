import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile, link, symlink, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collect } from "./usage"
import { collectInThread } from "./thread"
import { capacityDatabaseKey } from "./settings"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-storage-test-"))
  temporary.push(root)
  const roots = {
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    workspace: path.join(root, "workspace"),
    temporary: path.join(root, "temporary"),
  }
  await Promise.all(Object.values(roots).map((dir) => mkdir(dir)))
  const database = path.join(roots.data, "opencode.db")
  const db = new Database(database, { create: true })
  db.run(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, data TEXT);
    CREATE INDEX session_message_data_idx ON session_message(data);
    CREATE TABLE blob (data BLOB);
    CREATE TABLE credential (secret BLOB);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO session_v2 VALUES ('session-1');
    INSERT INTO session_message VALUES ('message-1', 'hello');
    INSERT INTO blob VALUES (zeroblob(16000));
    INSERT INTO credential VALUES (zeroblob(96000));
    INSERT INTO kv VALUES ('models-dev:v2:test', 'cached models');
    CREATE TABLE disposable (data BLOB);
    INSERT INTO disposable VALUES (zeroblob(32000));
    DROP TABLE disposable;
  `)
  db.close()
  return { roots, database }
}

test("measures session pages and reclaimable free pages while excluding credentials, binaries, links and duplicates", async () => {
  const { roots, database } = await fixture()
  await mkdir(path.join(roots.cache, "bin"))
  await writeFile(path.join(roots.cache, "bin", "program"), Buffer.alloc(32000))
  await writeFile(path.join(roots.data, "auth.json"), "private auth file")
  await mkdir(path.join(roots.temporary, "opencode-codec-program"))
  await writeFile(path.join(roots.temporary, "opencode-codec-program", "program"), Buffer.alloc(32000))
  await mkdir(path.join(roots.data, "tool-output"))
  const output = path.join(roots.data, "tool-output", "output.txt")
  await writeFile(output, "temporary tool output")
  await link(output, path.join(roots.workspace, "same-output.txt"))
  await symlink(path.join(roots.cache, "bin"), path.join(roots.workspace, "linked-programs"))
  const before = createHash("sha256")
    .update(await Bun.file(database).bytes())
    .digest("hex")
  const result = await collect(roots)
  const bytes = (id: string) => result.categories.find((entry) => entry.id === id)!.bytes
  expect(result.sessions).toBe(1)
  expect(result.messages).toBe(1)
  expect(result.complete).toBe(true)
  expect(bytes("conversations")).toBeGreaterThan(16000)
  expect(bytes("databaseFree")).toBeGreaterThanOrEqual(32000)
  expect(result.excludedDatabaseBytes).toBeGreaterThan(96000)
  expect(bytes("toolOutput")).toBe((await stat(output)).blocks * 512)
  expect(bytes("workspace")).toBe(0)
  expect(result.totalBytes).toBeLessThan((await stat(database)).size - 80000)
  expect(
    createHash("sha256")
      .update(await Bun.file(database).bytes())
      .digest("hex"),
  ).toBe(before)
})

test("does not classify unknown plugin KV state as regenerable cache", async () => {
  const { roots, database } = await fixture()
  const db = new Database(database)
  db.run("INSERT INTO kv VALUES ('plugin:unknown:private-state', 'keep')")
  db.close()
  expect((await collect(roots)).categories.find((entry) => entry.id === "cache")!.bytes).toBe(0)
})

test("persistent capacity metadata does not hide the model cache or become disposable space", async () => {
  const { roots, database } = await fixture()
  const db = new Database(database)
  db.run("UPDATE kv SET value=? WHERE key LIKE 'models-dev:%'", ["x".repeat(180000)])
  const before = await collect(roots)
  db.run("INSERT INTO kv VALUES (?, ?)", [capacityDatabaseKey, "2000000000"])
  const after = await collect(roots)
  db.close()
  const cache = (value: typeof after) => value.categories.find((entry) => entry.id === "cache")!.bytes
  expect(cache(before)).toBeGreaterThan(160000)
  expect(cache(after)).toBe(cache(before))
  expect(after.totalBytes + after.excludedDatabaseBytes).toBe((await stat(database)).blocks * 512)
})

test("missing database fails without creating an empty database", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-storage-missing-"))
  temporary.push(root)
  await expect(collect({ data: root, cache: root, workspace: root })).rejects.toThrow()
  expect(await Bun.file(path.join(root, "opencode.db")).exists()).toBe(false)
})

test("counts new pages that are still in WAL only once", async () => {
  const { roots, database } = await fixture()
  const writer = new Database(database)
  writer.run("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO blob VALUES (zeroblob(128000))")
  try {
    const result = await collect(roots)
    const files = await Promise.all([database, database + "-wal", database + "-shm"].map((file) => stat(file)))
    expect(result.totalBytes + result.excludedDatabaseBytes).toBe(
      files.reduce((sum, file) => sum + file.blocks * 512, 0),
    )
  } finally {
    writer.close()
  }
})

test("background collector returns the real database inventory and closes on failure", async () => {
  const { roots } = await fixture()
  expect((await collectInThread(roots)).sessions).toBe(1)
  await expect(collectInThread({ ...roots, data: roots.workspace })).rejects.toThrow("Storage scan unavailable")
})
