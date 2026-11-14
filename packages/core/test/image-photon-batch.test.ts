import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { Effect, Exit, Fiber } from "effect"
import { Photon } from "@opencode/core/image/photon"
const input = { uri: "synthetic", mime: "image/png", content: "YQ==", encoding: "base64" as const }
const limits = { autoResize: true, maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 5 * 1024 * 1024 }
class Fake extends EventEmitter {
  calls = 0
  terminated = 0
  exited = false
  finishExit?: () => void
  postMessage() {
    this.calls++
  }
  unref() {
    return this
  }
  ref() {
    return this
  }
  reply() {
    this.emit("message", { _tag: "Done", result: { _tag: "Unchanged" } })
  }
  terminate() {
    this.terminated++
    return new Promise<number>((resolve) => {
      this.finishExit = () => {
        this.exited = true
        this.emit("exit", 0)
        resolve(0)
      }
    })
  }
}
const tick = () => Bun.sleep(5)
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await tick()
  expect(check()).toBe(true)
}
function setup() {
  const workers: Fake[] = []
  const normalize = Photon.makeWith(
    Effect.sync(() => {
      const w = new Fake()
      workers.push(w)
      return w as unknown as Worker
    }),
  )
  const call = () => normalize("synthetic", input, limits)
  return { workers, call }
}
test("entered concurrent batch reuses one worker; last result awaits exit", async () => {
  const { workers, call } = setup()
  let done = false
  const p = Effect.runPromise(Effect.forEach([0, 1, 2], call, { concurrency: "unbounded" })).then((x) => {
    done = true
    return x
  })
  await until(() => workers[0]?.calls === 1)
  workers[0]!.reply()
  await until(() => workers[0]?.calls === 2)
  workers[0]!.reply()
  await until(() => workers[0]?.calls === 3)
  workers[0]!.reply()
  await until(() => workers[0]?.terminated === 1)
  expect(done).toBe(false)
  expect(workers.length).toBe(1)
  workers[0]!.finishExit!()
  expect(await p).toEqual([input, input, input])
  expect(done).toBe(true)
})
test("new request during retirement waits for exit, then uses a fresh worker", async () => {
  const { workers, call } = setup()
  const first = Effect.runPromise(call())
  await until(() => workers[0]?.calls === 1)
  workers[0]!.reply()
  await until(() => workers[0]?.terminated === 1)
  const second = Effect.runPromise(call())
  await tick()
  expect(workers.length).toBe(1)
  workers[0]!.finishExit!()
  await first
  await until(() => workers[1]?.calls === 1)
  workers[1]!.reply()
  await until(() => workers[1]?.terminated === 1)
  workers[1]!.finishExit!()
  expect(await second).toEqual(input)
})
test("cancelled semaphore waiter leaves the running request intact", async () => {
  const { workers, call } = setup()
  const first = Effect.runPromise(call())
  await until(() => workers[0]?.calls === 1)
  const waiting = Effect.runFork(call())
  await tick()
  await Effect.runPromise(Fiber.interrupt(waiting))
  expect(workers[0]!.terminated).toBe(0)
  workers[0]!.reply()
  await until(() => workers[0]?.terminated === 1)
  workers[0]!.finishExit!()
  expect(await first).toEqual(input)
})
test("failed worker exits before queue resumes on replacement", async () => {
  const { workers, call } = setup()
  const first = Effect.runPromiseExit(call())
  await until(() => workers[0]?.calls === 1)
  const second = Effect.runPromise(call())
  await tick()
  workers[0]!.emit("error", new Error("synthetic panic"))
  await until(() => workers[0]?.terminated === 1)
  expect(workers.length).toBe(1)
  workers[0]!.finishExit!()
  expect(Exit.isFailure(await first)).toBe(true)
  await until(() => workers[1]?.calls === 1)
  workers[1]!.reply()
  await until(() => workers[1]?.terminated === 1)
  workers[1]!.finishExit!()
  expect(await second).toEqual(input)
})
test("active cancellation waits for worker exit before interrupt completes", async () => {
  const { workers, call } = setup()
  const fiber = Effect.runFork(call())
  await until(() => workers[0]?.calls === 1)
  let interrupted = false
  const p = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    interrupted = true
  })
  await until(() => workers[0]?.terminated === 1)
  expect(interrupted).toBe(false)
  workers[0]!.finishExit!()
  await p
  expect(interrupted).toBe(true)
})

test("cancelled startup waits for unready worker exit and removes listeners", async () => {
  const w = new Fake()
  const fiber = Effect.runFork(Photon.spawnWith(Effect.succeed(w as unknown as Worker)))
  await until(() => w.listenerCount("message") === 1)
  let done = false
  const p = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    done = true
  })
  await until(() => w.terminated === 1)
  expect(done).toBe(false)
  expect(w.listenerCount("message")).toBe(0)
  expect(w.listenerCount("error")).toBe(0)
  w.finishExit!()
  await p
  expect(done).toBe(true)
})
test("failed startup does not finish until termination settles", async () => {
  const w = new Fake()
  let done = false
  const p = Effect.runPromiseExit(Photon.spawnWith(Effect.succeed(w as unknown as Worker))).then((x) => {
    done = true
    return x
  })
  await until(() => w.listenerCount("message") === 1)
  w.emit("error", new Error("startup error"))
  await until(() => w.terminated === 1)
  expect(done).toBe(false)
  expect(w.listenerCount("exit")).toBe(0)
  w.finishExit!()
  expect(Exit.isFailure(await p)).toBe(true)
})
test("Ready racing cancellation never leaves a ready worker running", async () => {
  const w = new Fake()
  const normalize = Photon.makeWith(Photon.spawnWith(Effect.succeed(w as unknown as Worker)))
  const fiber = Effect.runFork(normalize("synthetic", input, limits))
  await until(() => w.listenerCount("message") === 1)
  w.emit("message", { _tag: "Ready" })
  const cancelled = Effect.runPromise(Fiber.interrupt(fiber))
  await until(() => w.terminated === 1)
  w.finishExit!()
  await cancelled
  expect(w.terminated).toBe(1)
  expect(w.listenerCount("message")).toBe(0)
})
test("queued caller cannot spawn while an unready cancelled worker is terminating", async () => {
  const workers: Fake[] = []
  const spawn = Photon.spawnWith(
    Effect.sync(() => {
      const w = new Fake()
      workers.push(w)
      return w as unknown as Worker
    }),
  )
  const normalize = Photon.makeWith(spawn)
  const first = Effect.runFork(normalize("synthetic", input, limits))
  await until(() => workers.length === 1 && workers[0]!.listenerCount("message") === 1)
  const second = Effect.runPromise(normalize("synthetic", input, limits))
  await tick()
  const cancellation = Effect.runPromise(Fiber.interrupt(first))
  await until(() => workers[0]?.terminated === 1)
  await tick()
  expect(workers.length).toBe(1)
  workers[0]!.finishExit!()
  await cancellation
  await until(() => workers.length === 2 && workers[1]!.listenerCount("message") === 1)
  workers[1]!.emit("message", { _tag: "Ready" })
  await until(() => workers[1]!.calls === 1)
  workers[1]!.reply()
  await until(() => workers[1]!.terminated === 1)
  workers[1]!.finishExit!()
  expect(await second).toEqual(input)
})
