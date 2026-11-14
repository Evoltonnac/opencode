import { parentPort, workerData } from "node:worker_threads"
import { collect } from "./usage"

collect(workerData).then(
  (output) => parentPort.postMessage({ output }),
  () => parentPort.postMessage({ error: true }),
)
