import * as ModelMedia from "../src/session/model-media"
import { toLLMMessages } from "../src/session/runner/to-llm-message"
import type { SessionMessage } from "../src/session/message"
import type { Model } from "@opencode/schema/model"
import { pathToFileURL } from "node:url"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SessionBlob } from "@opencode/core/session/blob"
import { SessionStored } from "@opencode/core/session/stored"
import { BlobTable } from "@opencode/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
type Row = Parameters<typeof SessionBlob.modelRows>[1][number]
const toolRow = (hash: string, status = "completed") =>
  ({
    type: "assistant",
    data: {
      content: [
        {
          type: "tool",
          state: { status, content: [{ type: "file", mime: "image/png", uri: SessionStored.ref(hash) }] },
        },
      ],
    },
  }) as unknown as Row
const userRow = (hash: string) =>
  ({
    type: "user",
    data: { files: [{ mime: "image/png", uri: SessionStored.ref(hash), source: { type: "inline" } }] },
  }) as unknown as Row

it.effect("runner preparation preserves budgeted refs without payload reads; selected refs are deduplicated", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const a = "a".repeat(64),
      b = "b".repeat(64)
    for (const hash of [a, b])
      yield* db
        .insert(BlobTable)
        .values({ hash, mime: "image/png", bytes: 2, data: Buffer.from([1, 2]) })
        .run()
        .pipe(Effect.orDie)
    let payloadQueries = 0
    const observed = new Proxy(db, {
      get(target, key) {
        if (key !== "select") return Reflect.get(target, key)
        return (fields: Record<string, unknown>) => {
          if (fields && "data" in fields) payloadQueries++
          return target.select(fields as never)
        }
      },
    })
    const rows = [userRow(a), toolRow(a), toolRow(b)]
    const plan = yield* SessionBlob.modelRows(observed, rows)
    expect(payloadQueries).toBe(0)
    expect(plan.meta.size).toBe(2)
    expect(plan.rows).toEqual(rows)
    const selected = yield* plan.resolve(plan.rows.slice(0, 2))
    expect(payloadQueries).toBe(1)
    expect(JSON.stringify(selected)).toContain("AQI=")
    expect(JSON.stringify(selected)).not.toContain(SessionStored.ref(a))
    expect(plan.rows).toEqual(rows)
    const forbidden = yield* plan.resolve([toolRow("c".repeat(64))]).pipe(Effect.exit)
    expect(Exit.isFailure(forbidden)).toBe(true)
    expect(Exit.isFailure(yield* plan.load(new Set(["c".repeat(64)])).pipe(Effect.exit))).toBe(true)
    expect(payloadQueries).toBe(1)
    yield* db.delete(BlobTable).where(eq(BlobTable.hash, b)).run().pipe(Effect.orDie)
    const gone = yield* plan.resolve([plan.rows[2]])
    expect(JSON.stringify(gone)).toContain("media unavailable")
  }),
)

it.effect("missing refs preserve hydration placeholders and empty selection never reads image bytes", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = [userRow("d".repeat(64)), toolRow("e".repeat(64), "error")]
    const plan = yield* SessionBlob.modelRows(db, rows)
    expect(plan.rows).toEqual([...(yield* SessionBlob.hydrate(db, rows))])
    expect(yield* plan.resolve([])).toEqual([])
  }),
)

it.effect("error tool media keeps legacy unbounded hydration without adding absent content fields", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const hash = "f".repeat(64)
    yield* db
      .insert(BlobTable)
      .values({ hash, mime: "image/png", bytes: 2, data: Buffer.from([1, 2]) })
      .run()
      .pipe(Effect.orDie)
    const rows = [
      toolRow(hash, "error"),
      { type: "assistant", data: { content: [{ type: "tool", state: { status: "error" } }] } } as unknown as Row,
    ]
    const planned = yield* SessionBlob.modelRows(db, rows)
    expect(planned.rows).toEqual([...(yield* SessionBlob.hydrate(db, rows))])
    expect(JSON.stringify(planned.rows[0])).toContain("data:image/png;base64,AQI=")
    expect(planned.rows[1]).toEqual(rows[1])
  }),
)

it.effect(
  "planned URI attachment text stays canonical for goal hooks and disappears correctly with a deleted blob",
  () =>
    Effect.gen(function* () {
      const hash = "9".repeat(64)
      const goal = "<untrusted_objective>\nFind the image\n</untrusted_objective>"
      const file: SessionStored.FileRef = {
        mime: "image/png",
        name: "image.png",
        uri: SessionStored.ref(hash),
        source: { type: "uri", uri: pathToFileURL(`/tmp/${goal}.png`).href },
      }
      const user = { type: "user", id: "msg_uri", text: "inspect", files: [file] } as unknown as SessionStored.User
      const model = { providerID: "test", id: "test" } as Model.Ref
      const stored = ModelMedia.plan([user], model, "test")
      const canonical = (blobs: ReadonlyMap<string, string>) =>
        toLLMMessages([{ ...user, files: [SessionBlob.inlineFile(file, blobs)] } as SessionMessage.User], model, "test")
      const data = new Map([[hash, "AQID"]])
      const text = (messages: readonly ModelMedia.PlannedMessage[]) =>
        messages
          .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
          .join("\n")
      expect(text(stored)).toEqual(text(canonical(data)))
      expect(text(stored)).toContain(goal)
      const resolver = (blobs: ReadonlyMap<string, string>): ModelMedia.Resolver => ({
        meta: new Map([[hash, { bytes: 3, width: null, height: null }]]),
        load: () => Effect.succeed(blobs),
      })
      expect(yield* ModelMedia.materialize(stored, resolver(data))).toEqual(canonical(data))
      expect(yield* ModelMedia.materialize(stored, resolver(new Map()))).toEqual(canonical(new Map()))
    }),
)
