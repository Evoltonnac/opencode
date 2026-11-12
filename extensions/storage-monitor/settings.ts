import type { Plugin } from "@opencode/plugin"
import { defaultCapacityBytes, validCapacityBytes } from "../../packages/app/src/settings/storage/model"

export const pluginID = "mhxing.storage-monitor"
export const capacityKey = "capacityBytes"
// Native host.ts encodes plugin IDs before prefixing keys in the shared KV store.
// This exact small setting is persistent metadata, never disposable cache.
export const capacityDatabaseKey = `plugin:${Array.from(pluginID, (value) =>
  value.charCodeAt(0).toString(16).padStart(4, "0"),
).join("")}:${capacityKey}`

export async function readCapacity(storage: Plugin.Context["storage"]) {
  const value = await storage.get(capacityKey)
  if (value === undefined) return defaultCapacityBytes
  if (!validCapacityBytes(value)) throw new Error("Invalid stored storage capacity")
  return value
}
