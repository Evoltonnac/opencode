import { validCapacityBytes } from "./model"
import type { StorageUsage } from "./rpc"

type Editing = { target: object; draft?: string; notice?: "saved" | "unknown"; uncertain?: number }

export type StorageState = Editing & (
  | { status: "idle" }
  | { status: "pending"; attempt: string; data?: StorageUsage; queued?: string }
  | { status: "ready"; data: StorageUsage }
  | { status: "error"; data?: StorageUsage }
  | { status: "saving" | "confirming"; attempt: string; data: StorageUsage; wanted: number; queued?: string }
  | { status: "disposed" }
)

export type StorageEvent =
  | { type: "target.changed"; target: object }
  | { type: "refresh" | "invalidated"; attempt: string }
  | { type: "succeeded"; attempt: string; data: StorageUsage }
  | { type: "failed" | "timeout"; attempt: string }
  | { type: "draft.changed"; value: string }
  | { type: "draft.cancelled" }
  | { type: "save"; attempt: string }
  | { type: "capacity.saved" | "capacity.confirmed"; attempt: string; capacityBytes: number }
  | { type: "save.failed"; attempt: string; confirmAttempt: string }
  | { type: "confirmation.failed"; attempt: string }
  | { type: "disposed" }

export function capacityFromGB(value: string) {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value.trim())) return undefined
  const bytes = Math.round(Number(value) * 1_000_000_000)

  return validCapacityBytes(bytes) ? bytes : undefined
}

export function transitionStorage(state: StorageState, event: StorageEvent): StorageState {
  if (state.status === "disposed") return state

  if (event.type === "disposed") return { status: "disposed", target: state.target }

  if (event.type === "target.changed")
    return event.target === state.target ? state : { status: "idle", target: event.target }

  if (event.type === "draft.changed" || event.type === "draft.cancelled") {
    if (state.status === "saving" || state.status === "confirming") return state

    return { ...state, draft: event.type === "draft.changed" ? event.value : undefined, notice: undefined, uncertain: undefined }
  }

  if (event.type === "refresh" || event.type === "invalidated") {
    if (state.status === "pending" || state.status === "saving" || state.status === "confirming")
      return event.type === "refresh" ? state : { ...state, queued: event.attempt }

    return { ...state, status: "pending", attempt: event.attempt, data: "data" in state ? state.data : undefined }
  }

  if (event.type === "save") {
    if ((state.status !== "ready" && state.status !== "error") || !state.data || state.draft === undefined) return state
    const wanted = capacityFromGB(state.draft)

    if (wanted === undefined || wanted === state.data.capacityBytes) return state

    return { ...state, status: "saving", attempt: event.attempt, wanted, data: state.data }
  }

  if (!("attempt" in state) || !("attempt" in event) || event.attempt !== state.attempt) return state

  if (state.status === "pending" && (event.type === "succeeded" || event.type === "failed" || event.type === "timeout")) {
    const data = event.type === "succeeded" ? event.data : state.data
    const confirmed = event.type === "succeeded" && state.uncertain === event.data.capacityBytes

    const editing: Editing = {
      target: state.target,
      draft: confirmed ? undefined : state.draft,
      notice: confirmed ? "saved" : state.notice,
      uncertain: confirmed ? undefined : state.uncertain,
    }

    if (state.queued) return { ...editing, status: "pending", attempt: state.queued, data }

    if (event.type === "succeeded") return { ...editing, status: "ready", data: event.data }

    return { ...editing, status: "error", data }
  }

  if (state.status === "saving" && event.type === "save.failed")
    return { ...state, status: "confirming", attempt: event.confirmAttempt }

  if (
    (state.status === "saving" && event.type === "capacity.saved") ||
    (state.status === "confirming" && (event.type === "capacity.confirmed" || event.type === "confirmation.failed"))
  ) {
    const capacityBytes = event.type === "confirmation.failed" ? state.data.capacityBytes : event.capacityBytes
    const confirmed = event.type !== "confirmation.failed" && capacityBytes === state.wanted

    const editing: Editing = {
      target: state.target,
      draft: confirmed ? undefined : state.draft,
      notice: confirmed ? "saved" : "unknown",
      uncertain: confirmed ? undefined : state.wanted,
    }

    const data = { ...state.data, capacityBytes }

    if (state.queued) return { ...editing, status: "pending", attempt: state.queued, data }

    return { ...editing, status: "ready", data }
  }

  return state
}

export function storageView(state: StorageState) {
  const data = "data" in state ? state.data : undefined
  const percent = data ? (data.totalBytes / data.capacityBytes) * 100 : undefined
  const saving = state.status === "saving" || state.status === "confirming"
  const input = state.draft ?? (data ? String(data.capacityBytes / 1_000_000_000) : "")
  const capacityBytes = capacityFromGB(input)

  return {
    data,
    percent,
    input,
    saving,
    confirming: state.status === "confirming",
    notice: state.notice,
    invalid: state.draft !== undefined && capacityBytes === undefined,
    dirty: state.draft !== undefined,
    canSave: (state.status === "ready" || state.status === "error") && data !== undefined &&
      capacityBytes !== undefined && capacityBytes !== data.capacityBytes,
    severity: percent === undefined || percent < 50 ? "normal" : percent < 80 ? "warning" : "danger",
    pending: state.status === "pending",
    failed: state.status === "error",
  }
}

export function formatStorageBytes(bytes: number) {
  const unit = bytes < 1000 ? 0 : Math.min(3, Math.floor(Math.log10(bytes) / 3))

  return `${Number((bytes / 1000 ** unit).toFixed(1))} ${["B", "KB", "MB", "GB"][unit]}`
}
