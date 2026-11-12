import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { capacityKey, readCapacity } from "./settings"

test("reads the native persisted capacity without initializing or overwriting missing or invalid state", async () => {
  const values = new Map<string, number | string>()
  const storage: Plugin.Context["storage"] = {
    get: async (key) => values.get(key),
    set: async (key, value) => { if (typeof value === "number") values.set(key, value) },
    remove: async (key) => { values.delete(key) },
    scan: async () => ({ entries: [] }),
  }
  expect(await readCapacity(storage)).toBe(2_000_000_000)
  expect(values.size).toBe(0)
  await storage.set(capacityKey, 3_000_000_000)
  expect(await readCapacity(storage)).toBe(3_000_000_000)
  values.set(capacityKey, "corrupt")
  await expect(readCapacity(storage)).rejects.toThrow("Invalid stored storage capacity")
  expect(values.get(capacityKey)).toBe("corrupt")
})
