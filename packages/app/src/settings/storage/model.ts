export const categories = [
  "conversations",
  "cache",
  "databaseFree",
  "databaseJournal",
  "toolOutput",
  "logs",
  "temporary",
  "workspace",
] as const

export const defaultCapacityBytes = 2_000_000_000

export const minimumCapacityBytes = 1_000_000

export const maximumCapacityBytes = 1_024_000_000_000

export type StorageCapacity = { capacityBytes: number }

export function validCapacityBytes(value: unknown): value is number {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate opaque JSON from native plugin storage at its boundary
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimumCapacityBytes &&
    value <= maximumCapacityBytes
  )
}

export type StorageMeasurement = {
  sampledAt: string
  totalBytes: number
  complete: boolean
  sessions: number
  messages: number
  excludedDatabaseBytes: number
  categories: { id: (typeof categories)[number]; bytes: number; complete: boolean }[]
}

export type StorageUsage = StorageMeasurement & StorageCapacity
