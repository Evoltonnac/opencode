import { describe, expect, test } from "bun:test"
import { pairingView, transitionPairing, type PairingState } from "./machine"

const pending = () => transitionPairing({ status: "idle" }, { type: "generate", attempt: "a", now: 1000 })
const result = { type: "succeeded", attempt: "a", code: "ABCDEF", expiresIn: 60, now: 2000 } as const

describe("web pairing lifecycle", () => {
  test("requires explicit generation and synchronously claims a single request", () => {
    const idle: PairingState = { status: "idle" }
    expect(transitionPairing(idle, { type: "tick", now: 0 })).toBe(idle)
    const state = pending()
    expect(transitionPairing(state, { type: "generate", attempt: "b", now: 2 })).toBe(state)
  })
  test("shows bare code, counts down conservatively, expires without renewing", () => {
    const ready = transitionPairing(pending(), result)
    expect(pairingView(ready).code).toBe("ABCDEF")
    expect(pairingView(ready).remaining).toBe(59)
    const expired = transitionPairing(ready, { type: "tick", now: 61000 })
    expect(expired).toEqual({ status: "expired" })
    expect(pairingView(expired).code).toBeUndefined()
    expect(transitionPairing(expired, { type: "tick", now: 62000 })).toBe(expired)
    expect(transitionPairing(pending(), { ...result, now: 62000 })).toEqual({ status: "expired" })
  })
  test.each(["failed", "timeout", "cancel", "target.changed", "disposed"] as const)(
    "%s discards late results",
    (type) => {
      const state = transitionPairing(pending(), { type, attempt: "a" })
      expect(pairingView(state).pending).toBe(false)
      expect(transitionPairing(state, result)).toBe(state)
      const retry = transitionPairing(state, { type: "generate", attempt: "b", now: 3000 })
      expect(transitionPairing(retry, result)).toBe(retry)
    },
  )
  test("retains target identity through transitions and resets it on server change", () => {
    const first = {}
    const second = {}
    const idle = transitionPairing({ status: "idle" }, { type: "target.changed", target: first })
    const loading = transitionPairing(idle, { type: "generate", attempt: "a", now: 1000 })
    expect(loading.target).toBe(first)
    const ready = transitionPairing(loading, result)
    expect(ready.target).toBe(first)
    const changed = transitionPairing(ready, { type: "target.changed", target: second })
    expect(changed.target).toBe(second)
    expect(pairingView(changed).code).toBeUndefined()
    expect(transitionPairing(changed, result)).toBe(changed)
  })
  test("target change clears visible codes and stale failures do not affect a new request", () => {
    expect(transitionPairing(transitionPairing(pending(), result), { type: "target.changed" })).toEqual({
      status: "idle",
    })
    const state = pending()
    expect(transitionPairing(state, { type: "failed", attempt: "old" })).toBe(state)
  })
})
