import { expect, test } from "bun:test"
import { ImageModel, ImageResponse, Media, ProviderID } from "@opencode/ai/effect"
import { RequestExecutor } from "@opencode/ai/route"
import { TestLLM } from "@opencode/ai/testing"
import { Generate } from "@opencode/core/generate"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { Effect, Layer } from "effect"

const ref = Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("image") })
const generate = (asset: Media.Asset) => {
  const model = new ImageModel({
    id: "image",
    provider: "fixture",
    route: {
      id: "fixture-image",
      provider: ProviderID.make("fixture"),
      protocol: "fixture-image",
      kind: "inline",
      generate: () => Effect.succeed(new ImageResponse({ images: [asset] })),
    },
  })
  const layer = Generate.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ModelResolver.Service, { resolveImage: () => Effect.succeed(model) }),
        Layer.mock(Model.Service, { available: () => Effect.succeed([]) }),
        TestLLM.testLayer(),
        RequestExecutor.fetchLayer,
      ),
    ),
  )
  return Effect.runPromise(
    Generate.Service.use((service) => service.image({ model: ref, prompt: "Local fixture" })).pipe(Effect.provide(layer)),
  )
}

for (const length of [0, 1, 2, 3, 255, 256, 257, 4096, 4097]) {
  test(`encodes exactly the ${length}-byte view without adjacent backing bytes`, async () => {
    const backing = Uint8Array.from({ length: length + 14 }, (_, index) => (index * 137 + 19) % 256)
    const bytes = backing.subarray(7, 7 + length)
    const original = bytes.slice()
    const asset = Media.bytes(bytes, "image/png")
    const expected = await Effect.runPromise(asset.base64().pipe(Effect.provide(RequestExecutor.fetchLayer)))
    const result = await generate(asset)
    expect(result).toEqual({ images: [{ type: "image", data: expected, mime: "image/png" }] })
    expect(new Uint8Array(Buffer.from(result.images[0].data, "base64"))).toEqual(original)
    expect(bytes).toEqual(original)
  })
}

test("keeps inline base64 source representation and declared MIME unchanged", async () => {
  const result = await generate(Media.base64("AQID\r\nBA==", "image/webp"))
  expect(result).toEqual({ images: [{ type: "image", data: "AQID\r\nBA==", mime: "image/webp" }] })
})
