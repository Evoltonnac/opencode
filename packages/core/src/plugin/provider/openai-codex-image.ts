export * as OpenAICodexImage from "./openai-codex-image.js"

import type { Credential } from "../../credential.js"

export const id = "gpt-image-2"
export const baseURL = "https://chatgpt.com/backend-api/codex"

export function subscribed(credential: Credential.Value | undefined): Credential.OAuth | undefined {
  if (
    credential?.type === "oauth" &&
    (credential.methodID === "chatgpt-browser" || credential.methodID === "chatgpt-headless")
  )
    return credential
}
