import { describe, expect } from "bun:test"
import { gunzipSync, zstdDecompressSync } from "node:zlib"
import { Effect } from "effect"
import { Headers, HttpClientRequest } from "effect/http"
import { ai, Media, Message, type RequestEncoding } from "../../src/effect.js"
import { configure } from "../../src/providers/openai.js"
import { Auth, LLMClient, type WebSocketChannelExecutor } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const baseURL = "https://responses.example.test/v1"
const model = configure({ baseURL, apiKey: "fixture" }).responses("fixture")
const prompt = [Message.user([{ type: "media", media: Media.base64("AQID", "image/png") }, Message.text("hello")])]
const fallback: WebSocketChannelExecutor = {
  execute: (exchange) => Effect.succeed({ frames: exchange.fallback(), complete: Effect.void }),
}
const sse = sseEvents(
  { type: "response.created", response: { id: "response" } },
  { type: "response.completed", response: { id: "response" } },
)

describe("OpenAI Responses lazy HTTP fallback", () => {
  it.effect("preserves a detached fallback snapshot and materializes its request at most once", () =>
    Effect.gen(function* () {
      const request = ai.request({ model, messages: prompt })
      const compiled = yield* compileRequest(request)
      const prepared = yield* model.route.prepareTransport(compiled.body, request, { webSocket: fallback })
      expect(Object.getOwnPropertyDescriptor(prepared, "http")?.get).toBeDefined()
      const expected = JSON.stringify(compiled.body)
      ;(compiled.body as { input: unknown[] }).input.splice(0)
      const preparedHttp = prepared.http
      expect(prepared.http).toBe(preparedHttp)
      const web = yield* HttpClientRequest.toWeb(preparedHttp.request)
      expect(yield* Effect.promise(() => web.text())).toBe(expected)
    }),
  )

  it.effect("keeps overlays and custom body-signing auth on the eager route", () =>
    Effect.gen(function* () {
      const signed: string[] = []
      const signer = Auth.custom((input) => {
        signed.push(input.body)
        return Effect.succeed(Headers.set(input.headers, "x-test-echo", "signed"))
      })
      const signedModel = configure({ baseURL, auth: signer }).responses("fixture")
      for (const [activeModel, overlay] of [
        [signedModel, undefined],
        [model, { service_tier: "priority" }],
      ] as const) {
        const request = ai.request({ model: activeModel, messages: prompt, http: { body: overlay } })
        const compiled = yield* compileRequest(request)
        signed.length = 0 // compilation by itself also prepares the eager HTTP route
        const prepared = yield* activeModel.route.prepareTransport(compiled.body, request, { webSocket: fallback })
        expect(Object.getOwnPropertyDescriptor(prepared, "http")?.get).toBeUndefined()
        const web = yield* HttpClientRequest.toWeb(prepared.http.request)
        const text = yield* Effect.promise(() => web.text())
        if (overlay) expect(JSON.parse(text)).toMatchObject(overlay)
        else {
          expect(signed).toEqual([text])
          expect(prepared.channel!.headers["x-test-echo"]).toBe("signed")
        }
      }
    }),
  )

  for (const encoding of [undefined, "gzip", "zstd"] satisfies (RequestEncoding | undefined)[]) {
    it.effect(`matches eager HTTP and runs middleware once on fallback (${encoding ?? "plain"})`, () =>
      Effect.gen(function* () {
        const request = ai.request({ model, messages: prompt, http: { query: { trace: "abc" }, encoding } })
        const seen: {
          bytes: Uint8Array
          url: string
          encoding: string | null
          auth: string | null
          marker: string | null
        }[] = []
        const layer = dynamicResponse((input) =>
          Effect.succeed(input.respond(sse, { headers: { "content-type": "text/event-stream" } })),
        )
        let middlewareCalls = 0
        for (const webSocket of [undefined, fallback]) {
          yield* LLMClient.generate(request, {
            webSocket,
            http: (req, next) =>
              Effect.gen(function* () {
                middlewareCalls++
                const web = yield* HttpClientRequest.toWeb(req).pipe(Effect.orDie)
                const bytes = new Uint8Array(yield* Effect.promise(() => web.arrayBuffer()))
                seen.push({
                  bytes,
                  url: web.url,
                  encoding: web.headers.get("content-encoding"),
                  auth: web.headers.get("authorization"),
                  marker: web.headers.get("x-test-echo"),
                })
                const sent = HttpClientRequest.setHeader(req, "x-test-echo", "middleware")
                const result = yield* next(sent)
                return result
              }),
          }).pipe(Effect.provide(layer))
        }
        expect(middlewareCalls).toBe(2)
        expect(seen).toHaveLength(2)
        expect(seen[1]).toEqual(seen[0])
        expect(new URL(seen[1]!.url).searchParams.get("trace")).toBe("abc")
        expect(seen[1]!.auth).toBe("Bearer fixture")
        expect(seen[1]!.encoding).toBe(encoding ?? null)
        const bytes = seen[1]!.bytes
        const decoded =
          encoding === "zstd" ? zstdDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : bytes
        expect(new TextDecoder().decode(decoded)).toContain("data:image/png;base64,AQID")
      }),
    )
  }
})
