import { expect, test } from "bun:test"
import { ai, Media, Message } from "@opencode/ai/effect"
import { LLMClient, RequestExecutor, WebSocketTransport } from "@opencode/ai/route"
import { configure } from "@opencode/ai/providers/openai"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { WebSocketConstructor } from "@opencode/core/effect/websocket-constructor"
import { Session } from "@opencode/schema/session"
import { Effect, Layer } from "effect"
import { Socket } from "effect/socket"

test("live Responses unknown upgrade and ambiguous send protect the same fallback boundary", async () => {
  const http: { sha: string; url: string; auth: string | null; encoding: string | null }[] = []
  let upgradeRejected = 0
  let webSocketFrames = 0
  let reject = true
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (request.method === "GET") {
        if (!reject && server.upgrade(request)) return undefined
        upgradeRejected++
        return new Response(null, { status: 426 })
      }
      http.push({
        sha: new Bun.CryptoHasher("sha256").update(await request.arrayBuffer()).digest("hex"),
        url: request.url,
        auth: request.headers.get("authorization"),
        encoding: request.headers.get("content-encoding"),
      })
      const id = "resp_fixture"
      const sse = [
        { type: "response.created", response: { id } },
        { type: "response.completed", response: { id } },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("")
      return new Response(sse, { headers: { "content-type": "text/event-stream" } })
    },
    websocket: {
      message(socket) {
        webSocketFrames++
        socket.close(1011, "fixture uncertain after send")
      },
    },
  })
  try {
    const model = configure({ baseURL: `http://127.0.0.1:${server.port}`, apiKey: "fixture" }).responses("gpt-5.2")
    const request = ai.request({
      model,
      messages: [
        Message.user([
          { type: "text", text: "fixture" },
          { type: "media", media: Media.base64("AQID", "image/png") },
        ]),
      ],
      http: { encoding: "zstd", query: { trace: "fallbackParity" } },
    })
    const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))
    const main = Effect.gen(function* () {
      const s = yield* SessionModelTransport.Service
      const perform = (id?: string) =>
        LLMClient.Service.use((llm) =>
          llm.generate(request, id ? { webSocket: s.bind(Session.ID.make(id)) } : undefined),
        ).pipe(Effect.provide(layer))
      yield* perform()
      yield* perform("ses_fixture_reject")
      expect(upgradeRejected).toBe(1)
      expect(http).toHaveLength(2)
      expect(http[0]).toEqual(http[1])
      expect(http[1]!.encoding).toBe("zstd")
      expect(http[1]!.auth).toBe("Bearer fixture")
      expect(new URL(http[1]!.url).searchParams.get("trace")).toBe("fallbackParity")
      reject = false
      const result = yield* Effect.result(perform("ses_fixture_ambiguous"))
      expect(result._tag).toBe("Failure")
      expect(webSocketFrames).toBe(1)
      expect(http).toHaveLength(2)
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const constructor = yield* Socket.WebSocketConstructor
        return yield* main.pipe(
          Effect.provide(
            SessionModelTransport.makeLayer({
              open: (input) =>
                WebSocketTransport.open(input).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor)),
            }),
          ),
        )
      }).pipe(Effect.provide(WebSocketConstructor.layer), Effect.scoped),
    )
  } finally {
    await server.stop(true)
  }
})
