export * as CodeModeDisplayInput from "./display-input.js"

import type { Schema } from "effect"

export const MaxBytes = 8192
const MaxString = 256
const MaxKey = 128
const MaxItems = 16
const MaxDepth = 4
const MaxNodes = 128
const isArray = (value: typeof Schema.Json.Type): value is ReadonlyArray<typeof Schema.Json.Type> => Array.isArray(value)

/** A display-only, independently owned JSON snapshot. Never pass this back to a tool. */
export function summarize(input: unknown): Record<string, typeof Schema.Json.Type> | undefined {
  if (input === null || input === undefined) return
  // Inputs reach this hook as parsed JSON, as in the existing CodeMode input boundary.
  let nodes = 0
  const visit = (value: typeof Schema.Json.Type, depth: number): typeof Schema.Json.Type => {
    nodes++
    if (typeof value === "string")
      return value.length > MaxString ? `[string omitted: ${value.length} code units]` : value
    if (value === null || typeof value !== "object") return value
    if (depth >= MaxDepth) return isArray(value) ? "[array omitted: depth limit]" : "[object omitted: depth limit]"
    if (isArray(value)) {
      const output: Array<typeof Schema.Json.Type> = []
      for (const item of value) {
        if (output.length >= MaxItems || nodes >= MaxNodes) { output.push("[more items omitted]"); break }
        output.push(visit(item, depth + 1))
      }
      return output
    }
    const entries: Array<[string, typeof Schema.Json.Type]> = []
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (entries.length >= MaxItems || nodes >= MaxNodes) {
        let marker = "[more fields omitted]"
        while (entries.some(([key]) => key === marker)) marker += "."
        entries.push([marker, true])
        break
      }
      if (key.length > MaxKey) return "[object omitted: long property name]"
      entries.push([key, visit(value[key], depth + 1)])
    }
    // fromEntries preserves __proto__ as an ordinary own key, without invoking a setter.
    return Object.fromEntries(entries)
  }
  const shown = visit(input as typeof Schema.Json.Type, 0)
  const output = shown !== null && typeof shown === "object" && !isArray(shown) ? shown : { input: shown }
  if (Object.keys(output).length === 0) return
  // Only this already bounded tree is encoded. Never stringify or decode the giant source input.
  if (Buffer.byteLength(JSON.stringify(output)) > MaxBytes)
    return { input: `[input omitted: display exceeds ${MaxBytes} bytes]` }
  return output
}
