export * as Photon from "./photon.js"

import { Effect, Exit, Schema, Semaphore } from "effect"
import type { Worker } from "node:worker_threads"
import type { FileSystem } from "../filesystem.js"
import { DecodeError, ResizerUnavailableError, SizeError, type Limits } from "../image.js"
import { PhotonNormalize } from "./photon-normalize.js"
import type { Reply, Request } from "./photon-worker.js"

// The worker holds photon's wasm heap (hundreds of MB after a large image);
// this candidate terminates it as soon as the entered batch completes.

export class WorkerUnavailableError extends Schema.TaggedError<WorkerUnavailableError>()(
  "Image.Photon.WorkerUnavailableError",
  { cause: Schema.Defect() },
) {}

// Resolves once the worker has loaded photon. Anything else (no worker_threads,
// a bundle without the worker entry, photon failing to load) means the worker
// is unavailable, and a worker that never got ready is terminated.
/** Acquire startup ownership before waiting; failed/interrupted startup cannot orphan a worker. */
export const spawnWith = (create: Effect.Effect<Worker, WorkerUnavailableError>) =>
  Effect.acquireUseRelease(
    create,
    (worker) =>
      Effect.callback<Worker, WorkerUnavailableError>((resume) => {
        const cleanup = () => {
          worker.off("message", ready).off("error", error).off("exit", exit)
        }
        const ready = () => {
          cleanup()
          resume(Effect.succeed(worker))
        }
        const error = (cause: Error) => {
          cleanup()
          resume(Effect.fail(new WorkerUnavailableError({ cause })))
        }
        const exit = (code: number) => error(new Error(`photon worker exited with code ${code}`))
        worker.once("message", ready).once("error", error).once("exit", exit)
        return Effect.sync(cleanup)
      }),
    (worker, exit) =>
      Exit.isFailure(exit) ? Effect.promise(() => worker.terminate()).pipe(Effect.asVoid) : Effect.void,
  )

export const spawnWorker = (url?: URL) =>
  spawnWith(
    Effect.tryPromise({
      try: async () => {
        const { Worker } = await import("node:worker_threads")
        return new Worker(url ?? new URL("./photon-worker.js", import.meta.url))
      },
      catch: (cause) => new WorkerUnavailableError({ cause }),
    }),
  )

// A panic or an unreadable reply fails the request the way an in-process
// photon throw would. The worker is only ref'd while a request is pending.
const request = (worker: Worker, content: PhotonNormalize.Content, limits: Readonly<Limits>) =>
  Effect.callback<PhotonNormalize.Result>((resume) => {
    const settle = (effect: Effect.Effect<PhotonNormalize.Result>) => {
      cleanup()
      resume(effect)
    }
    const reply = (reply: Reply) => {
      if (reply._tag === "Done") settle(Effect.succeed(reply.result))
    }
    const error = (error: Error) => settle(Effect.die(new Error(error.message)))
    const exit = (code: number) => settle(Effect.die(new Error(`photon worker exited with code ${code}`)))
    const cleanup = () => {
      worker.off("message", reply).off("messageerror", error).off("error", error).off("exit", exit)
      worker.unref()
    }
    worker.on("message", reply).on("messageerror", error).on("error", error).on("exit", exit)
    worker.ref()
    worker.postMessage({ content, limits } satisfies Request)
    return Effect.sync(cleanup)
  })

export function makeWith(spawn: Effect.Effect<Worker, WorkerUnavailableError>) {
  // One request at a time, so a worker never holds a queue that a panic could
  // take down with it, and a stale reply can never answer the next request.
  const permit = Semaphore.makeUnsafe(1)
  let current: Worker | undefined
  let pending = 0
  let retiring: Promise<void> | undefined
  let useWorker = true
  let photon: Promise<PhotonNormalize.Photon> | undefined

  const discard = (worker: Worker): Promise<void> => {
    if (current === worker) current = undefined
    const previous = retiring
    const termination = worker.terminate().then(() => undefined)
    const barrier = previous ? Promise.all([previous, termination]).then(() => undefined) : termination
    retiring = barrier
    return barrier.finally(() => {
      if (retiring === barrier) retiring = undefined
    })
  }
  const track = (worker: Worker) =>
    Effect.sync(() => {
      current = worker
      worker.unref()
      // A worker that dies while idle is replaced by the next call.
      const forget = () => {
        if (current === worker) current = undefined
      }
      worker.on("error", forget).once("exit", forget)
      return worker
    })
  // Interruptible only while spawning and while the request runs, so from the
  // moment a ready worker exists it is tracked until the entered batch drains or discarded.
  // A failed or interrupted request takes its worker down: the heap may be
  // poisoned, or the worker is still busy with a reply nobody will read.
  const inWorker = (content: PhotonNormalize.Content, limits: Readonly<Limits>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const exiting = retiring
        if (exiting) yield* restore(Effect.promise(() => exiting))
        const worker = current ?? (yield* restore(spawn).pipe(Effect.flatMap(track)))
        return yield* restore(request(worker, content, limits)).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.promise(() => discard(worker)) : Effect.void)),
        )
      }),
    ).pipe(permit.withPermits(1))
  const inProcess = (content: PhotonNormalize.Content, limits: Readonly<Limits>) =>
    Effect.tryPromise({
      try: () => (photon ??= PhotonNormalize.load()),
      catch: () => new ResizerUnavailableError(),
    }).pipe(Effect.map((photon) => PhotonNormalize.normalize(photon, content, limits)))

  const normalize = Effect.fn("Image.Photon.normalize")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: Readonly<Limits>,
  ) {
    // Fail typed before touching URLs, workers or module loading: workerd has
    // no photon artifact, and a throw outside the typed path (its undefined
    // import.meta.url was one) turns any image-bearing prompt into a 500.
    if (!PhotonNormalize.available) return yield* new ResizerUnavailableError()
    const result = useWorker
      ? yield* inWorker(content, limits).pipe(
          Effect.catchTag("Image.Photon.WorkerUnavailableError", (error) => {
            if (!useWorker) return inProcess(content, limits)
            useWorker = false
            return Effect.logWarning("photon worker unavailable, resizing images on the main thread", {
              cause: error.cause,
            }).pipe(Effect.andThen(inProcess(content, limits)))
          }),
        )
      : yield* inProcess(content, limits)
    switch (result._tag) {
      case "Unchanged":
        return content
      case "Content":
        return result.content
      case "DecodeError":
        return yield* new DecodeError({ resource })
      case "SizeError": {
        const { _tag, ...size } = result
        return yield* new SizeError({ resource, ...size })
      }
    }
  })
  return Effect.fn("Image.Photon.normalizeBatch")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: Readonly<Limits>,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        pending++
        return yield* restore(normalize(resource, content, limits)).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              pending--
              if (pending !== 0) return Effect.void
              // Recheck under the same request permit, and hold it until termination completes.
              // A new entrant either joins the batch before this check or waits for cleanup.
              return Effect.suspend(() => {
                if (pending !== 0 || !current) return Effect.void
                const exiting = discard(current)
                return Effect.promise(() => exiting)
              }).pipe(permit.withPermits(1))
            }),
          ),
        )
      }),
    )
  })
}

// One worker per process, shared by every Location.
export const make = Effect.succeed(makeWith(spawnWorker()))
