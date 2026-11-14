import { Plugin } from "@opencode/plugin"
import { StorageRpc } from "../../packages/app/src/settings/storage/rpc"
import { collectInThread } from "./thread"
import { capacityKey, pluginID, readCapacity } from "./settings"
import type { StorageCapacity } from "../../packages/app/src/settings/storage/model"

let cached: Awaited<ReturnType<typeof collectInThread>> | undefined
let pending: Promise<Awaited<ReturnType<typeof collectInThread>>> | undefined

export default Plugin.define({
  id: pluginID,
  async setup(ctx) {
    await ctx.rpc.register(StorageRpc, {
      getCapacity: async (_input, context) => {
        try {
          return { capacityBytes: await readCapacity(ctx.storage) }
        } catch {
          return context.error("unavailable", "暂时无法读取参考上限。", {})
        }
      },
      setCapacity: async (input, context) => {
        if (context.signal.aborted) throw context.signal.reason
        // SAFETY: The native RPC host validates setCapacity input against its bounded JSON schema.
        const capacity = input as StorageCapacity
        try {
          await ctx.storage.set(capacityKey, capacity.capacityBytes)
          return { capacityBytes: await readCapacity(ctx.storage) }
        } catch {
          return context.error("unavailable", "暂时无法确认参考上限是否已保存。", {})
        }
      },
      usage: async (_input, context) => {
        if (context.signal.aborted) throw context.signal.reason
        try {
          if (!cached || Date.now() - Date.parse(cached.sampledAt) >= 30_000) {
            pending ??= collectInThread()
              .then((value) => {
                cached = value
                return value
              })
              .finally(() => {
                pending = undefined
              })
          }
          const measurement = pending ? await pending : cached!
          return { ...measurement, capacityBytes: await readCapacity(ctx.storage) }
        } catch {
          return context.error("unavailable", "暂时无法读取存储用量。", {})
        }
      },
    })
  },
})
