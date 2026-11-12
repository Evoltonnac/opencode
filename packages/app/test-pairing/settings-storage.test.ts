import { expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { render } from "solid-js/web"
import { createApiForServer } from "@/runtime/server/api"
import { createOpenCodeEventSource } from "@/runtime/server/client"
import { LanguageProvider } from "@/runtime/i18n/language"
import { PlatformProvider } from "@/runtime/platform/platform"
import { SettingsStorage } from "@/settings/storage/storage"

test("storage renders the native authenticated RPC result and preserves its last sample on refresh failure", async () => {
  const requests: Request[] = []
  const replies: ReturnType<typeof Promise.withResolvers<Response>>[] = []

  const api = createApiForServer({
    server: { url: "http://storage-server.test", password: "test-only-password" },
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      const reply = Promise.withResolvers<Response>()
      replies.push(reply)

      return reply.promise
    },
  })

  const root = document.createElement("div")
  document.body.append(root)
  const events = createRoot((dispose) => ({ ...createOpenCodeEventSource(), dispose }))

  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: { platform: "web", openExternal() {}, restart: async () => {}, notify: async () => {} },
        get children() {
          return createComponent(LanguageProvider, {
            locale: "zh",
            get children() {
              return createComponent(SettingsStorage, { api, event: events.event })
            },
          })
        },
      }),
    root,
  )

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  const sample = {
    sampledAt: "2026-11-11T01:00:00Z",
    capacityBytes: 2_000_000_000,
    totalBytes: 1_600_000_000,
    complete: true,
    sessions: 5,
    messages: 68,
    excludedDatabaseBytes: 4096,
    categories: [{ id: "conversations", bytes: 1_600_000_000, complete: true }],
  }

  try {
    await settle()
    expect(root.textContent).toContain("正在读取存储用量")
    expect(root.querySelector('[role="progressbar"]')).toBeNull()
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe("/api/rpc/mhxing.storage/usage")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].headers.get("authorization")).toBe(`Basic ${btoa("opencode:test-only-password")}`)
    // v2.2.7 serves RPC calls before plugins finish loading. An inventory update during
    // that first call must schedule one fresh read, including when the old call fails.
    events.publish({ type: "plugin.updated", data: {}, location: { directory: "/srv/opencode/workspace" } })
    replies[0].resolve(Response.json({ error: "plugin not loaded" }, { status: 404 }))
    await settle()
    expect(requests).toHaveLength(2)
    replies[1].resolve(Response.json({ output: sample }))
    await settle()
    expect(root.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("80")
    expect(root.querySelector("section")?.dataset.severity).toBe("danger")
    expect(root.textContent).toContain("已使用 1.6 GB / 2 GB")
    expect(root.textContent).toContain("参考上限")
    expect(root.textContent).toContain("对话与附件")
    root.querySelector("details")!.open = true
    root.querySelector("button")!.click()
    root.querySelector("button")!.click()
    await settle()
    expect(requests).toHaveLength(3)
    replies[2].resolve(Response.json({ output: sample }))
    await settle()
    expect(root.querySelector("details")!.open).toBe(true)

    const edit = (value: string) => {
      const input = root.querySelector("input")!
      input.value = value
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }

    const save = () => Array.from(root.querySelectorAll("button")).find((button) => button.textContent === "保存")!
    edit("0")
    await settle()
    expect(save().disabled).toBe(true)
    expect(root.textContent).toContain("最多三位小数")
    edit("4")
    await settle()
    save().click()
    await settle()
    expect(new URL(requests[3].url).pathname).toBe("/api/rpc/mhxing.storage/setCapacity")
    expect(await requests[3].json()).toEqual({ input: { capacityBytes: 4_000_000_000 } })
    expect(root.querySelector("input")!.disabled).toBe(true)
    replies[3].resolve(Response.json({ output: { capacityBytes: 4_000_000_000 } }))
    await settle()
    expect(root.textContent).toContain("参考上限已保存")
    expect(root.textContent).toContain("已使用 1.6 GB / 4 GB")
    expect(root.querySelector("section")?.dataset.severity).toBe("normal")
    expect(root.querySelector("details")!.open).toBe(true)
    // A lost write response must issue a read, not repeat the write.
    edit("3")
    await settle()
    save().click()
    await settle()
    replies[4].reject(new TypeError("Lost write response"))
    await settle()
    expect(new URL(requests[5].url).pathname).toBe("/api/rpc/mhxing.storage/getCapacity")
    expect(root.textContent).toContain("正在确认保存结果")
    replies[5].resolve(Response.json({ output: { capacityBytes: 3_000_000_000 } }))
    await settle()
    expect(root.textContent).toContain("参考上限已保存")
    expect(root.querySelector("input")!.value).toBe("3")
    expect(root.querySelector("section")?.dataset.severity).toBe("warning")
    expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/setCapacity"))).toHaveLength(2)
    root.querySelector("button")!.click()
    await settle()
    replies[6].resolve(Response.json({ error: "unavailable" }, { status: 503 }))
    await settle()
    expect(root.textContent).toContain("刷新失败，当前显示上次统计")
    expect(root.textContent).toContain("已使用 1.6 GB / 3 GB")
    root.querySelector("button")!.click()
    await settle()
    dispose()
    replies[7].resolve(Response.json({ output: {} }))
    await settle()
    expect(root.textContent).toBe("")
  } finally {
    dispose()
    events.dispose()
    root.remove()
  }
})
