import type { Page } from "@playwright/test"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACQCAIAAAC5w3GfAAACW0lEQVR42u3du3ECQRQFUWKQTEouASkNIiMs5MvFVgQy+Oww23OqOoTjvncP19O3BvR1/tGADqgBDbSABhpoAQ20gAYaaAENtIAGGmgBDbSABhpoAQ20gAYaaAENtIAGGmgBDbSABhpoAQ20gAYaaAENtIAGGmjtDfTH53HrgBbQQAMNNNBAAy2ggRbQQAMNNNBAAw000HXQt9/LvVEI9FygH0AMN9Azgn4hZayBfhvojRyTDfRo0MMoYw30MamZaaBTlLEGuqmZaaBrmpkGOkUZa6CbmpkGuqaZaaBrmpkGGmigVwK9O81MA13TzDTQNc1MAw000F3QAc1MA13TzDTQQAPdAh3TzDTQQAMNNNBATwg6qXlx00ADDXQCdFjzyqaBBhpooIEGGmiggd4KdF7zsqaBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggQYaaKCBBhpooIEGGmiggXaxQjPQQAMNNNBAAw000D4n0Qw00EAD7fsozUADDTTQQANtY4VmoIEGGmg7hTQDbUmWZqCBBjoOeu+mUQa6Y5pjoDumIQYaaKCXAb0v0wQD3TGNL9Ad0+wCHWFNLdAd08gC3THNK9AR1qQC3TGNKdAR1oACPTSOgU6BfjlrIoF+P+gncVMI9Lyg/ws1oIHWxKAXDzWggRbQQAMtoIEW0EADLaCBFtBAAy2ggRbQQAMtoIEW0EADLaCBFtBAAy2ggRbQQAMtoIEW0EADLaCBFtBAAy2ggRbQQAMtoIEW0EADLaCBFtBAAy2ggRbQQBf7A2j12BH1jwmlAAAAAElFTkSuQmCC",
  "base64",
)

export const privacyFixtureImage = "data:image/png;base64," + png.toString("base64")

export const privacyFixtureFile = { encoding: "base64" as const, content: png.toString("base64") }

export async function mockPrivacyFixtureImages(page: Page) {
  await page.route("**/privacy-fixture-*.png", (route) => route.fulfill({ contentType: "image/png", body: png }))
}

type Sample = { name: string; phase: "inserted" | "loaded"; protected: boolean }

type PrivacyWindow = Window & { privacyImageSamples: Sample[] }

export async function samplePrivacyImageFrames(page: Page) {
  await page.addInitScript(() => {
    const samples = ((window as PrivacyWindow).privacyImageSamples = [])
    const seen = new WeakMap<HTMLImageElement, number>()
    const raw = new WeakSet<HTMLImageElement>()

    const inspect = () => {
      if (localStorage.getItem("opencode-session-image-blur") === "1") {
        for (const image of document.querySelectorAll<HTMLImageElement>(
          ':is([data-slot="session-timeline-scroll"], [data-component="session-timeline"]) img[alt^="privacy-"], [data-session-image-preview] img',
        )) {
          const phase = image.complete && image.naturalWidth > 0 ? 2 : 1
          const name = image.closest("[data-session-image-preview]") ? image.dataset.slot! : image.alt
          let covered = false
          for (let node: HTMLElement | null = image; node; node = node.parentElement) {
            const style = getComputedStyle(node)
            const blur = Number(style.filter.match(/blur\((\d+(?:\.\d+)?)px\)/)?.[1] ?? 0)
            if (blur >= 40 || style.visibility === "hidden" || style.display === "none") covered = true
          }
          const first = (seen.get(image) ?? 0) < phase
          if (first) seen.set(image, phase)
          if (first || (!covered && !raw.has(image))) {
            if (!covered) raw.add(image)
            samples.push({ name, phase: phase === 2 ? "loaded" : "inserted", protected: covered })
          }
        }
      }
      requestAnimationFrame(inspect)
    }
    requestAnimationFrame(inspect)
  })

  return () => page.evaluate(() => (window as PrivacyWindow).privacyImageSamples)
}
