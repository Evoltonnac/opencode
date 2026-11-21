/** Only large ASCII image data URLs are written directly. Every other string is escaped and encoded whole. */
export const isLargeInlineImage = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 256 * 1024 &&
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+(?![\s\S])/.test(value)

const utf8 = new TextEncoder()

/** Input is a detached plain JSON snapshot. This preserves JSON.stringify property order and escaping. */
export function encodeImageJsonBytes(body: unknown): Uint8Array {
  const segments: (Uint8Array | string)[] = []
  const text = (value: string) => segments.push(utf8.encode(value))
  const put = (value: unknown): void => {
    if (isLargeInlineImage(value)) {
      text('"')
      segments.push(value)
      text('"')
      return
    }
    if (Array.isArray(value)) {
      text("[")
      value.forEach((item, index) => {
        if (index) text(",")
        put(item)
      })
      text("]")
      return
    }
    if (value !== null && typeof value === "object") {
      text("{")
      let first = true
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue
        if (!first) text(",")
        first = false
        text(JSON.stringify(key))
        text(":")
        put(item)
      }
      text("}")
      return
    }
    text(JSON.stringify(value ?? null))
  }
  put(body)
  const output = new Uint8Array(segments.reduce((sum, segment) => sum + segment.length, 0))
  let offset = 0
  for (const segment of segments) {
    if (typeof segment === "string") utf8.encodeInto(segment, output.subarray(offset, offset + segment.length))
    else output.set(segment, offset)
    offset += segment.length
  }
  return output
}
