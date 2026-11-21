import { Clock, Duration, Effect, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/http"
import { Auth } from "../auth.js"
import { render as renderEndpoint } from "../endpoint.js"
import { Framing } from "../framing.js"
import type { HttpMiddleware, Transport, TransportPrepareInput } from "./index.js"
import * as ProviderShared from "../../protocols/shared.js"
import {
  AIError,
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
  mergeJsonRecords,
  timeoutConfig,
  TransportError,
  type HttpContext,
  type HttpTimeout,
  type LLMRequest,
} from "../../schema/index.js"
import { RequestExecutor } from "../executor.js"
import { encodeImageJsonBytes, isLargeInlineImage } from "../../utils/segmented-json.js"

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
  readonly url: string
  readonly jsonBody: Body | Record<string, unknown>
  readonly bodyText: string
  readonly deferredBodyText?: true
  readonly encodeImageBytes?: () => Uint8Array
  readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly framing: Framing.Definition<Frame>
  readonly middleware?: HttpMiddleware
}

const bodyWithOverlay = <Body>(body: Body, request: LLMRequest, encodeBody: (body: Body) => string) =>
  Effect.gen(function* () {
    if (request.http?.body === undefined) return { jsonBody: body, bodyText: encodeBody(body) }
    if (ProviderShared.isRecord(body)) {
      const overlaid = mergeJsonRecords(body, request.http.body) ?? {}
      return { jsonBody: overlaid, bodyText: ProviderShared.encodeJson(overlaid) }
    }
    return yield* ProviderShared.invalidRequest("http.body can only overlay JSON object request bodies")
  })

const unsupportedSnapshot = Symbol("non-JSON request body")

// Copy only containers so later mutations cannot change the fallback body. Scalar strings (including
// large inline images) remain shared. Exotic objects keep the old eager, exact encoder semantics.
const snapshotBody = <Body>(body: Body, requireLargeImage: boolean): Body | undefined => {
  let hasLargeImage = false
  const ancestors = new Set<object>()
  const copy = (value: unknown, depth: number): unknown => {
    if (requireLargeImage && !hasLargeImage && isLargeInlineImage(value)) hasLargeImage = true
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value
    if (typeof value !== "object" || depth >= 128 || ancestors.has(value)) throw unsupportedSnapshot
    const proto = Object.getPrototypeOf(value)
    const array = Array.isArray(value)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw unsupportedSnapshot
    ancestors.add(value)
    // A null-prototype container also preserves real "__proto__" keys without an assignment setter.
    const result = array ? [] : Object.create(null)
    const keys = Object.keys(value)
    if (array && keys.length !== (value as unknown[]).length) throw unsupportedSnapshot
    for (const [index, key] of keys.entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor) || key === "toJSON" || (array && key !== String(index)))
        throw unsupportedSnapshot
      result[key] = copy(descriptor.value, depth + 1)
    }
    // JSON.stringify also checks a non-enumerable toJSON property.
    if (Object.hasOwn(value, "toJSON")) throw unsupportedSnapshot
    ancestors.delete(value)
    return result
  }
  try {
    const snapshot = copy(body, 0) as Body
    return requireLargeImage && !hasLargeImage ? undefined : snapshot
  } catch {
    return undefined
  }
}

export const jsonRequestParts = <Body>(
  input: JsonRequestInput<Body>,
  deferBodyText = false,
  segmentImageBytes = false,
): Effect.Effect<JsonRequestParts<Body>, AIError> =>
  Effect.gen(function* () {
    const endpoint = renderEndpoint(input.endpoint, { request: input.request, body: input.body })
    if (input.request.http?.query) {
      Object.entries(input.request.http.query).forEach(([key, value]) => endpoint.searchParams.set(key, value))
    }
    const url = endpoint.toString()
    const deferred =
      deferBodyText &&
      Auth.isBodyIndependent(input.auth) &&
      input.request.http?.body === undefined &&
      input.encodeBody === ProviderShared.encodeJson
        ? snapshotBody(input.body, segmentImageBytes)
        : undefined
    const body =
      deferred === undefined ? yield* bodyWithOverlay(input.body, input.request, input.encodeBody) : undefined
    let bodyText = body?.bodyText
    const text = () => (bodyText ??= input.encodeBody(deferred!))
    const authInput = {
      request: input.request,
      method: "POST" as const,
      url,
    }
    const requestHeaders = Headers.fromInput({
      ...input.headers?.({ request: input.request }),
      ...input.request.headers,
    })
    const headers = yield* Auth.toEffect(input.auth)(
      body
        ? { ...authInput, body: body.bodyText, headers: requestHeaders }
        : {
            ...authInput,
            get body() {
              return text()
            },
            headers: requestHeaders,
          },
    )
    if (body) return { url, ...body, headers } satisfies JsonRequestParts
    return {
      url,
      jsonBody: input.body,
      get bodyText() {
        return text()
      },
      deferredBodyText: true,
      ...(segmentImageBytes && deferred !== undefined ? { encodeImageBytes: () => encodeImageJsonBytes(deferred) } : {}),
      headers,
    } satisfies JsonRequestParts
  })

export interface HttpJsonInput<_Body, Frame> {
  readonly framing: Framing.Definition<Frame>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
  readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (prepareInput) =>
    Effect.gen(function* () {
      const encoding = prepareInput.request.http?.encoding
      const segment = encoding === undefined || encoding === "none"
      const parts = yield* jsonRequestParts(prepareInput, segment, segment)
      const request = parts.encodeImageBytes
        ? HttpClientRequest.post(parts.url).pipe(
            HttpClientRequest.setHeaders(parts.headers),
            HttpClientRequest.bodyUint8Array(parts.encodeImageBytes(), "application/json"),
          )
        : ProviderShared.jsonPost({
            url: parts.url,
            body: parts.bodyText,
            headers: parts.headers,
            encoding,
          })
      return {
        request,
        framing: input.framing,
        middleware: prepareInput.middleware,
      }
    }),
  execute: (prepared, request, runtime) =>
    Effect.gen(function* () {
      const timeout = (operation: "request" | "read", message: string, http?: HttpContext) =>
        new AIError({
          reason: new TransportError({
            message,
            transport: "http",
            operation,
            code: "Timeout",
            url: prepared.request.url,
            http,
          }),
        })
      const started = yield* Clock.currentTimeMillis
      const limits = timeoutConfig(request.timeout)
      // Unlike the header and chunk limits, the whole-request budget has no default.
      const total = limits.total ? Duration.millis(limits.total) : Duration.infinity
      const response = yield* RequestExecutor.withTls(runtime.http.execute, request.http?.tls)(
        prepared.request,
        prepared.middleware,
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.min(timeoutDuration(limits.headers), total),
          orElse: () => timeout("request", "Timed out waiting for response headers"),
        }),
      )
      const http = RequestExecutor.responseHttp(response)
      const remaining = Duration.subtract(total, Duration.millis((yield* Clock.currentTimeMillis) - started))
      return {
        frames: prepared.framing.frame(
          RequestExecutor.responseStream(response).pipe(
            Stream.timeoutOrElse({
              duration: timeoutDuration(limits.chunk, DEFAULT_CHUNK_TIMEOUT_MS),
              orElse: () => Stream.fail(timeout("read", "Timed out waiting for response data", http)),
            }),
            Stream.interruptWhen(
              Effect.sleep(remaining).pipe(
                Effect.andThen(Effect.fail(timeout("read", "Timed out waiting for the response to complete", http))),
              ),
            ),
          ),
        ),
        http,
        body: prepared.framing.body,
        raw: prepared.framing.raw,
      }
    }),
})

const timeoutDuration = (value: HttpTimeout | undefined, fallback = DEFAULT_HTTP_TIMEOUT_MS) =>
  value === false ? Duration.infinity : Duration.millis(value ?? fallback)

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
