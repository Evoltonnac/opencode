import { Worker } from "node:worker_threads"
import type { StorageMeasurement } from "../../packages/app/src/settings/storage/model"
import { roots, type StorageRoots } from "./usage"

// The synchronous SQLite page walk stays off the conversation server's event loop.
export async function collectInThread(target: StorageRoots = roots): Promise<StorageMeasurement> {
  const result = Promise.withResolvers<StorageMeasurement>()
  const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: target })
  const unavailable = () => result.reject(new Error("Storage scan unavailable"))
  const timer = setTimeout(unavailable, 8_000)
  worker.once("message", (message: { output?: StorageMeasurement; error?: true }) => {
    if (message.output) result.resolve(message.output)
    else unavailable()
  })
  worker.once("error", unavailable)
  worker.once("exit", unavailable)
  return result.promise.finally(() => {
    clearTimeout(timer)
    void worker.terminate()
  })
}
