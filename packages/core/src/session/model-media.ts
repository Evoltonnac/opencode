/** Private model planning. Local refs are not AI media sources and cannot reach a hook or transport. */
import { createHash } from "node:crypto"
import {
  Message,
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ToolMessage,
  type ContentPart,
  type MediaPart,
  type TextPart,
} from "@opencode/ai/effect"
import type { Model } from "@opencode/schema/model"
import type { Content } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { SessionStored } from "./stored.js"
import { SessionBlob } from "./blob.js"
import { attachmentContent, attachmentLocation, imageMimes, toLLMMessages } from "./runner/to-llm-message.js"
import { unsupportedMedia, imageCut, IMAGE_REMOVED } from "./model-request.js"

export interface LocalMedia {
  readonly type: "local-media"
  readonly file: SessionStored.FileRef
  readonly location?: TextPart
}
export type Part = ContentPart | LocalMedia
export interface PlannedMessage {
  readonly id?: string
  readonly role: Message["role"]
  readonly content: ReadonlyArray<Part>
}
export interface Resolver {
  readonly meta: ReadonlyMap<string, SessionBlob.Meta>
  readonly load: (hashes: ReadonlySet<string>) => Effect.Effect<ReadonlyMap<string, string>>
}
const isRef = Schema.is(SessionStored.FileRef)
const isToolRef = (item: Content): boolean => Schema.is(SessionStored.ToolFileRef)(item)

// Blob payloads hydrate to canonical base64. Noncanonical inline strings keep their old string identity.
const payloadKey = (file: SessionStored.File) => {
  if (isRef(file)) return `hash:${SessionStored.refHash(file.uri)}`
  const bytes = Buffer.from(file.data, "base64")
  return bytes.toString("base64") === file.data
    ? `hash:${createHash("sha256").update(bytes).digest("hex")}`
    : `inline:${file.data}`
}

export const plan = (
  messages: readonly SessionStored.Message[],
  model: Model.Ref,
  provider: string,
): PlannedMessage[] =>
  messages.flatMap((message): PlannedMessage[] => {
    if (message.type !== "user") return toLLMMessages([message], model, provider)
    const files = message.files ?? []
    const deduplicate =
      files.filter((file) => imageMimes.has(file.mime) && file.source.type === "inline" && file.mention?.text).length >
      1
    const seen = new Map<string, Set<string>>()
    const content: Part[] = [
      ...(message.skills ?? []).flatMap((skill) => (skill.text === undefined ? [] : [Message.text(skill.text)])),
      ...(message.text === "" ? [] : [Message.text(message.text)]),
    ]
    for (const file of files) {
      if (deduplicate && imageMimes.has(file.mime) && file.source.type === "inline" && file.mention?.text) {
        const metadata = JSON.stringify([file.mime, file.name ?? null, file.description ?? null, file.mention.text])
        const payloads = seen.get(metadata) ?? new Set<string>()
        const key = payloadKey(file)
        if (payloads.has(key)) continue
        payloads.add(key)
        seen.set(metadata, payloads)
      }
      if (!isRef(file)) {
        content.push(...attachmentContent(file))
        continue
      }
      // Match the existing attachment lowerer's exact MIME whitelist, including case.
      if (!imageMimes.has(file.mime) && file.mime !== "application/pdf") continue
      const path = attachmentLocation(file)
      const location = path === undefined ? undefined : Message.text(`Attached file: ${path}`)
      if (location) content.push(location)
      content.push({ type: "local-media", file, location })
    }
    return content.length === 0 ? [] : [{ id: message.id, role: "user", content }]
  })

const mediaSize = (part: MediaPart) =>
  part.media.source.type === "base64"
    ? part.media.source.data.length
    : part.media.source.type === "bytes"
      ? Math.ceil(part.media.source.data.byteLength / 3) * 4
      : 0
const localSize = (uri: string, meta: Resolver["meta"]) => {
  const value = meta.get(uri.slice("media:".length))
  if (value === undefined) throw new Error("Missing model media metadata")
  return Math.ceil(value.bytes / 3) * 4
}

/** Same occurrence order, hysteresis and MIME checks as canonical boundImages. */
export const select = (
  messages: readonly PlannedMessage[],
  resolver: Resolver,
  capabilities: Model.Capabilities,
  provider?: string,
): PlannedMessage[] => {
  const replace = (
    input: readonly PlannedMessage[],
    fn: (mime: string, name: string | undefined, bytes: () => number) => string | undefined,
  ) =>
    input.map((message) => ({
      ...message,
      content: message.content.flatMap((part): Part[] => {
        if (part.type === "local-media" || part.type === "media") {
          const text =
            part.type === "local-media"
              ? fn(part.file.mime, part.file.name, () => localSize(part.file.uri, resolver.meta))
              : fn(part.media.mediaType, part.filename, () => mediaSize(part))
          return text === undefined ? [part] : [Message.text(text)]
        }
        if (part.type !== "tool-result" || part.result.type !== "content") return [part]
        return [
          {
            ...part,
            result: {
              ...part.result,
              value: part.result.value.map((item): Content => {
                if (item.type !== "file") return item
                const text = fn(item.mime, item.name, () =>
                  isToolRef(item)
                    ? `data:${item.mime};base64,`.length + localSize(item.uri, resolver.meta)
                    : item.uri.length,
                )
                return text === undefined ? item : { type: "text", text }
              }),
            },
          },
        ]
      }),
    }))
  const supported = replace(messages, (mime, name) => unsupportedMedia(mime, name, capabilities, provider))
  const sizes: number[] = []
  replace(supported, (mime, _name, bytes) => {
    if (mime.toLowerCase().startsWith("image/")) sizes.push(bytes())
    return undefined
  })
  const cut = imageCut(sizes)
  let index = 0
  return cut === 0
    ? supported
    : replace(supported, (mime) =>
        mime.toLowerCase().startsWith("image/") && index++ < cut ? IMAGE_REMOVED : undefined,
      )
}

export const materialize = Effect.fnUntraced(function* (messages: readonly PlannedMessage[], resolver: Resolver) {
  const hashes = new Set<string>()
  for (const message of messages)
    for (const part of message.content) {
      if (part.type === "local-media") hashes.add(SessionStored.refHash(part.file.uri))
      if (part.type === "tool-result" && part.result.type === "content")
        for (const item of part.result.value)
          if (item.type === "file" && isToolRef(item)) hashes.add(SessionStored.refHash(item.uri))
    }
  const blobs = yield* resolver.load(hashes)
  return messages.map((message) => {
    // A deleted selected blob becomes the old text attachment, which has no standalone location prefix.
    const missingLocations = new Set(
      message.content.flatMap((part) =>
        part.type === "local-media" && part.location && !blobs.has(SessionStored.refHash(part.file.uri))
          ? [part.location]
          : [],
      ),
    )
    const content = message.content.flatMap((part): ContentPart[] => {
      if (part.type === "text" && missingLocations.has(part)) return []
      if (part.type === "local-media") {
        const file = SessionBlob.inlineFile(part.file, blobs)
        if (isRef(file)) throw new Error("Unresolved model media")
        const content = attachmentContent(file)
        return part.location && blobs.has(SessionStored.refHash(part.file.uri)) ? content.slice(1) : content
      }
      if (part.type !== "tool-result" || part.result.type !== "content") return [part]
      return [
        {
          ...part,
          result: { ...part.result, value: part.result.value.map((item) => SessionBlob.inlineToolItem(item, blobs)) },
        },
      ]
    })
    // Every role comes from canonical lowering; only user media and tool file values are replaced.
    switch (message.role) {
      case "user":
        return new UserMessage({ ...message, role: "user", content: content as UserMessage["content"] })
      case "assistant":
        return new AssistantMessage({ ...message, role: "assistant", content: content as AssistantMessage["content"] })
      case "tool":
        return new ToolMessage({ ...message, role: "tool", content: content as ToolMessage["content"] })
      case "system":
        return new SystemMessage({ ...message, role: "system", content: content as SystemMessage["content"] })
    }
  })
})

/** Canonical histories supplied by existing callers have no local refs. */
export const emptyResolver: Resolver = {
  meta: new Map(),
  load: (hashes) =>
    hashes.size === 0
      ? Effect.succeed(new Map<string, string>())
      : Effect.die(new Error("Local media requires an authorized history resolver")),
}
