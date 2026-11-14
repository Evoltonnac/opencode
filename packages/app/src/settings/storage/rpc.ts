import { Rpc } from "@opencode/plugin/rpc"

import { categories, maximumCapacityBytes, minimumCapacityBytes } from "./model"

export type { StorageUsage } from "./model"

const bytes = { type: "integer", minimum: 0 } as const

const capacityBytes = { type: "integer", minimum: minimumCapacityBytes, maximum: maximumCapacityBytes } as const

const capacity = {
  type: "object",
  additionalProperties: false,
  required: ["capacityBytes"],
  properties: { capacityBytes },
} as const

const errors = { unavailable: { type: "object", additionalProperties: false } } as const

export const StorageRpc = Rpc.define({
  id: "mhxing.storage",
  events: {},
  methods: {
    getCapacity: {
      input: { type: "object", additionalProperties: false },
      output: capacity,
      errors,
    },
    setCapacity: { input: capacity, output: capacity, errors },
    usage: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        additionalProperties: false,
        required: [
          "sampledAt",
          "capacityBytes",
          "totalBytes",
          "complete",
          "sessions",
          "messages",
          "excludedDatabaseBytes",
          "categories",
        ],
        properties: {
          sampledAt: { type: "string" },
          capacityBytes,
          totalBytes: bytes,
          complete: { type: "boolean" },
          sessions: bytes,
          messages: bytes,
          excludedDatabaseBytes: bytes,
          categories: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "bytes", "complete"],
              properties: { id: { type: "string", enum: categories }, bytes, complete: { type: "boolean" } },
            },
          },
        },
      },
      errors,
    },
  },
})
