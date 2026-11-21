import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Headers, HttpClientRequest } from "effect/http"
import { ai } from "../../src/effect.js"
import { configure } from "../../src/providers/openai-compatible.js"
import { Auth } from "../../src/route.js"
import { Endpoint } from "../../src/route/endpoint.js"
import { Framing } from "../../src/route/framing.js"
import { httpJson, jsonRequestParts } from "../../src/route/transport/http.js"
import * as ProviderShared from "../../src/protocols/shared.js"
import { encodeImageJsonBytes, isLargeInlineImage } from "../../src/utils/segmented-json.js"

const model = configure({ baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture" }).model("fixture")
const image = "data:image/png;base64," + "Aa0/".repeat(72 * 1024)
const mixed = '中' + "a".repeat(65_533) + '😀 quoted " slash \\ newline \n lone\ud800\udfff'
const makeInput = (body: unknown, auth = Auth.bearer("fixture"), http?: Parameters<typeof ai.request>[0]["http"]) => ({
  body,
  request: ai.request({ model, messages: [], http }),
  endpoint: { baseURL: "http://127.0.0.1:9", ...Endpoint.path("/chat/completions") },
  auth,
  encodeBody: ProviderShared.encodeJson,
})
const digest = (a: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(a).digest("hex")

test("matches raw JSON UTF-8 for twenty images, Unicode near a byte boundary, escapes and nested metadata", () => {
  const body = {
    messages: Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? "tool" : "user",
      content: [{ type: "text", text: mixed }, { type: "image_url", image_url: { url: image } }],
    })),
    escapes: ["中😀", "\ud800", "\udfff", '\n\r\t"\\', null, undefined, NaN, -0, Infinity],
    json: JSON.parse('{"3":"number key","__proto__":{"valid":true},"2":"order"}'),
    omit: undefined,
  }
  const expected = new TextEncoder().encode(JSON.stringify(body))
  const got = encodeImageJsonBytes(body)
  expect(got.length).toBe(expected.length)
  expect(digest(got)).toBe(digest(expected))
  for (const v of [image + "\n", image + '"', image + "\\", image + "😀", image + "\u2028"]) {
    expect(isLargeInlineImage(v)).toBe(false)
    expect(digest(encodeImageJsonBytes([image, v]))).toBe(digest(JSON.stringify([image, v])))
  }
})

test("direct HTTP writes the same bytes from the authenticated snapshot", async () => {
  const body = { history: [image, mixed], flag: true }
  const expected = digest(JSON.stringify(body))
  const input = makeInput(body)
  const parts = await Effect.runPromise(jsonRequestParts(input, true, true))
  expect(parts.encodeImageBytes).toBeDefined()
  body.history.splice(0)
  expect(digest(parts.encodeImageBytes!())).toBe(expected)
  body.history.push(image, mixed)
  const prepared = await Effect.runPromise(httpJson({ framing: Framing.sse }).prepare(input))
  const web = await Effect.runPromise(HttpClientRequest.toWeb(prepared.request))
  expect(web.headers.get("authorization")).toBe("Bearer fixture")
  expect(web.headers.get("content-type")).toBe("application/json")
  expect(digest(new Uint8Array(await web.arrayBuffer()))).toBe(expected)
})

test("small requests, body-signing auth, overlays and exotic JSON keep the ordinary encoder", async () => {
  const signed: string[] = []
  const signer = Auth.custom(({ body, headers }) => {
    signed.push(body)
    return Effect.succeed(Headers.set(headers, "x-fixture-signature", "test"))
  })
  const large = { input: [image] }
  const signedParts = await Effect.runPromise(jsonRequestParts(makeInput(large, signer), true, true))
  expect(signedParts.encodeImageBytes).toBeUndefined()
  expect(signed).toEqual([JSON.stringify(large)])
  for (const input of [
    makeInput({ input: ["小"] }),
    makeInput({ ...large, exotic: { toJSON: () => "preserved" } }),
    makeInput(large, Auth.bearer("fixture"), { body: { fixture: true } }),
  ]) {
    const parts = await Effect.runPromise(jsonRequestParts(input, true, true))
    expect(parts.encodeImageBytes).toBeUndefined()
  }
})

test("gzip and zstd request paths still send compressed content", async () => {
  for (const encoding of ["gzip", "zstd"] as const) {
    const prepared = await Effect.runPromise(httpJson({ framing: Framing.sse }).prepare(makeInput(
      { input: [image] }, Auth.bearer("fixture"), { encoding },
    )))
    const web = await Effect.runPromise(HttpClientRequest.toWeb(prepared.request))
    expect(web.headers.get("content-encoding")).toBe(encoding)
  }
})
