import { expect, test } from "bun:test"
import { capacityFromGB, storageView, transitionStorage, type StorageState } from "./machine"
import type { StorageUsage } from "./rpc"

const sample = (totalBytes = 64_000_000): StorageUsage => ({
  sampledAt: "2026-11-11T01:00:00Z",
  capacityBytes: 2_000_000_000,
  totalBytes,
  complete: true,
  sessions: 5,
  messages: 68,
  excludedDatabaseBytes: 4096,
  categories: [],
})

test("uses inclusive 50% and 80% thresholds and retains the real usage above capacity", () => {
  for (const [bytes, severity, percent] of [
    [999_999_999, "normal", 49.99999995],
    [1_000_000_000, "warning", 50],
    [1_599_999_999, "warning", 79.99999995],
    [1_600_000_000, "danger", 80],
    [2_500_000_000, "danger", 125],
  ] as const) {
    const view = storageView({ status: "ready", target: {}, data: sample(bytes) })
    expect(view.severity).toBe(severity)
    expect(view.percent).toBeCloseTo(percent)
  }
})

test("rejects duplicate requests and late results across timeout, server change and disposal", () => {
  const target = {}
  const idle: StorageState = { status: "idle", target }
  expect(storageView(idle).percent).toBeUndefined()
  const pending = transitionStorage(idle, { type: "refresh", attempt: "a" })
  expect(transitionStorage(pending, { type: "refresh", attempt: "b" })).toBe(pending)
  const timeout = transitionStorage(pending, { type: "timeout", attempt: "a" })
  expect(storageView(timeout).data).toBeUndefined()
  expect(transitionStorage(timeout, { type: "succeeded", attempt: "a", data: sample() })).toBe(timeout)
  const changed = transitionStorage(pending, { type: "target.changed", target: {} })
  expect(transitionStorage(changed, { type: "succeeded", attempt: "a", data: sample() })).toBe(changed)
  const disposed = transitionStorage(pending, { type: "disposed" })
  expect(transitionStorage(disposed, { type: "succeeded", attempt: "a", data: sample() })).toBe(disposed)
})

test("keeps the last sample on refresh failure, then clears it when the server changes", () => {
  const data = sample()
  const pending = transitionStorage({ status: "ready", target: {}, data }, { type: "refresh", attempt: "a" })
  const failed = transitionStorage(pending, { type: "failed", attempt: "a" })
  expect(storageView(failed).data).toBe(data)
  expect(storageView(failed).failed).toBe(true)
  expect(storageView(transitionStorage(failed, { type: "target.changed", target: {} })).data).toBeUndefined()
})

test("accepts decimal GB to three places within the supported bounds", () => {
  expect(capacityFromGB("0.001")).toBe(1_000_000)
  expect(capacityFromGB(" 2.125 ")).toBe(2_125_000_000)
  expect(capacityFromGB("1024")).toBe(1_024_000_000_000)

  for (const value of ["", "0", "-1", "1e3", "Infinity", "2.0001", "1024.001", "2,5"])
    expect(capacityFromGB(value)).toBeUndefined()
})

test("preserves drafts during reads, serializes saves and queues plugin invalidation after a confirmed write", () => {
  let state: StorageState = { status: "ready", target: {}, data: sample(1_600_000_000) }
  state = transitionStorage(state, { type: "draft.changed", value: "4" })
  state = transitionStorage(state, { type: "refresh", attempt: "read" })
  expect(transitionStorage(state, { type: "save", attempt: "too-soon" })).toBe(state)
  state = transitionStorage(state, { type: "succeeded", attempt: "read", data: sample(1_600_000_000) })
  expect(storageView(state).input).toBe("4")
  state = transitionStorage(state, { type: "save", attempt: "write" })
  expect(transitionStorage(state, { type: "save", attempt: "duplicate" })).toBe(state)
  expect(transitionStorage(state, { type: "draft.cancelled" })).toBe(state)
  state = transitionStorage(state, { type: "invalidated", attempt: "new-read" })
  state = transitionStorage(state, { type: "capacity.saved", attempt: "write", capacityBytes: 4_000_000_000 })
  expect(state.status).toBe("pending")
  expect(storageView(state).severity).toBe("normal")
  expect(storageView(state).notice).toBe("saved")
  expect(storageView(state).dirty).toBe(false)
  expect(transitionStorage(state, { type: "succeeded", attempt: "read", data: sample() })).toBe(state)
})

test("reconciles an ambiguous write by reading without a second write and ignores late replies", () => {
  const target = {}
  let state: StorageState = { status: "ready", target, data: sample() }
  state = transitionStorage(state, { type: "draft.changed", value: "3" })
  state = transitionStorage(state, { type: "save", attempt: "write" })
  state = transitionStorage(state, { type: "save.failed", attempt: "write", confirmAttempt: "confirm" })
  expect(state.status).toBe("confirming")
  expect(transitionStorage(state, { type: "capacity.saved", attempt: "write", capacityBytes: 3_000_000_000 })).toBe(state)
  const changed = transitionStorage(state, { type: "target.changed", target: {} })
  expect(storageView(changed).input).toBe("")
  expect(transitionStorage(changed, { type: "capacity.confirmed", attempt: "confirm", capacityBytes: 3_000_000_000 })).toBe(changed)
  state = transitionStorage(state, { type: "capacity.confirmed", attempt: "confirm", capacityBytes: 3_000_000_000 })
  expect(storageView(state).notice).toBe("saved")
  expect(storageView(state).data!.capacityBytes).toBe(3_000_000_000)
  expect(storageView(state).dirty).toBe(false)
})

test("keeps an unconfirmed draft until a later read confirms it or the user cancels", () => {
  let state: StorageState = { status: "ready", target: {}, data: sample() }
  state = transitionStorage(state, { type: "draft.changed", value: "5" })
  state = transitionStorage(state, { type: "save", attempt: "write" })
  state = transitionStorage(state, { type: "save.failed", attempt: "write", confirmAttempt: "confirm" })
  state = transitionStorage(state, { type: "confirmation.failed", attempt: "confirm" })
  expect(storageView(state).notice).toBe("unknown")
  expect(storageView(state).input).toBe("5")
  expect(storageView(state).data!.capacityBytes).toBe(2_000_000_000)
  state = transitionStorage(state, { type: "refresh", attempt: "read" })
  state = transitionStorage(state, { type: "succeeded", attempt: "read", data: { ...sample(), capacityBytes: 5_000_000_000 } })
  expect(storageView(state).notice).toBe("saved")
  expect(storageView(state).dirty).toBe(false)
})
