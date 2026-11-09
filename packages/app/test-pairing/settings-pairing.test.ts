import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { createApiForServer } from "@/runtime/server/api"
import { LanguageProvider } from "@/runtime/i18n/language"
import { PlatformProvider } from "@/runtime/platform/platform"
import { SettingsPairing } from "@/settings/pairing/pairing"

// Exercise the real component, generated client and response decoder without contacting a live service.
test("pairing only issues explicit requests and hides late results after target changes and unmount", async () => {
  const requests: Request[] = []
  const replies: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const api = (url: string) =>
    createApiForServer({
      server: { url, password: "test-only-password" },
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        const reply = Promise.withResolvers<Response>()
        replies.push(reply)
        return reply.promise
      },
    })
  const target = { current: api("http://server-a.test") }
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: { platform: "web", openExternal() {}, restart: async () => {}, notify: async () => {} },
        get children() {
          return createComponent(LanguageProvider, {
            locale: "en",
            get children() {
              return createComponent(SettingsPairing, {
                get api() {
                  return target.current
                },
              })
            },
          })
        },
      }),
    root,
  )
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const generate = () => {
    const button = Array.from(root.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("Generate pairing code"),
    )
    expect(button).toBeDefined()
    button!.click()
    button!.click()
  }
  try {
    await settle()
    expect(requests).toHaveLength(0)
    generate()
    await settle()
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("http://server-a.test/api/pair")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].headers.get("authorization")).toBe(`Basic ${btoa("opencode:test-only-password")}`)
    target.current = api("http://server-b.test")
    replies[0].resolve(Response.json({ code: "STALE-CODE", expires_in: 60 }))
    await settle()
    expect(root.textContent).not.toContain("STALE-CODE")
    expect(root.querySelector("input")).toBeNull()
    expect(requests).toHaveLength(1)
    generate()
    await settle()
    replies[1].resolve(Response.json({ code: "BARE-CODE", expires_in: 60 }))
    await settle()
    expect(root.querySelector("input")?.value).toBe("BARE-CODE")
    expect(root.textContent).toContain("Expires in")
    expect(root.textContent).toContain("full access to this server")
    const clear = Array.from(root.querySelectorAll("button")).find((item) => item.textContent === "Clear")
    clear!.click()
    expect(root.querySelector("input")).toBeNull()
    generate()
    await settle()
    expect(requests).toHaveLength(3)
    dispose()
    replies[2].resolve(Response.json({ code: "UNMOUNTED-CODE", expires_in: 60 }))
    await settle()
    expect(root.textContent).not.toContain("UNMOUNTED-CODE")
    expect(root.querySelector("input")).toBeNull()
  } finally {
    dispose()
    root.remove()
  }
})
