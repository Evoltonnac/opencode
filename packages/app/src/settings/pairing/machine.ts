export type PairingState = { readonly target?: object } & (
  | { status: "idle" }
  | { status: "pending"; attempt: string; started: number }
  | { status: "ready"; code: string; expires: number; remaining: number }
  | { status: "error"; reason: "failed" | "timeout" }
  | { status: "expired" }
  | { status: "disposed" }
)

export type PairingEvent =
  | { type: "generate"; attempt: string; now: number }
  | { type: "succeeded"; attempt: string; code: string; expiresIn: number; now: number }
  | { type: "failed" | "timeout"; attempt: string }
  | { type: "tick"; now: number }
  | { type: "cancel" }
  | { type: "target.changed"; target?: object }
  | { type: "disposed" }

export function transitionPairing(state: PairingState, event: PairingEvent): PairingState {
  if (state.status === "disposed") return state
  if (event.type === "target.changed") return { status: "idle", target: event.target }
  const next = transition(state, event)
  return next === state || !state.target ? next : { ...next, target: state.target }
}

function transition(state: PairingState, event: Exclude<PairingEvent, { type: "target.changed" }>): PairingState {
  if (event.type === "disposed") return { status: "disposed" }
  if (event.type === "cancel") return { status: "idle" }
  if (event.type === "generate") {
    if (state.status === "pending" || state.status === "ready") return state
    return { status: "pending", attempt: event.attempt, started: event.now }
  }
  if (event.type === "tick") {
    if (state.status !== "ready") return state
    const remaining = Math.max(0, Math.ceil((state.expires - event.now) / 1000))
    if (!remaining) return { status: "expired" }
    return remaining === state.remaining ? state : { ...state, remaining }
  }
  if (state.status !== "pending" || state.attempt !== event.attempt) return state
  if (event.type !== "succeeded") return { status: "error", reason: event.type }
  // Start the TTL at request admission, not receipt, so network latency never extends a code's displayed lifetime.
  const expires = state.started + event.expiresIn * 1000
  const remaining = Math.max(0, Math.ceil((expires - event.now) / 1000))
  return remaining ? { status: "ready", code: event.code, expires, remaining } : { status: "expired" }
}

export function pairingView(state: PairingState) {
  return {
    generate: state.status === "idle" || state.status === "error" || state.status === "expired",
    pending: state.status === "pending",
    clear: state.status === "pending" || state.status === "ready",
    code: state.status === "ready" ? state.code : undefined,
    remaining: state.status === "ready" ? state.remaining : 0,
    message: state.status === "error" ? state.reason : state.status === "expired" ? "expired" : undefined,
  }
}
