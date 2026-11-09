import { Button } from "@opencode/ui/button"
import { TextField } from "@opencode/ui/text-field"
import { uuid } from "@opencode/util/uuid"
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerApi } from "@/runtime/server/api"
import { pairingView, transitionPairing, type PairingEvent, type PairingState } from "./machine"

export function SettingsPairing(props: { api: ServerApi }) {
  const language = useLanguage()
  const [state, setState] = createSignal<PairingState>({ status: "idle" })
  const view = createMemo(() => pairingView(state()))
  const requests = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()

  const dispatch = (event: PairingEvent) => {
    if (event.type !== "disposed" && event.type !== "target.changed" && untrack(state).target !== props.api) {
      dispatch({ type: "target.changed", target: props.api })
    }
    const previous = untrack(state)
    const next = transitionPairing(previous, event)
    if (next === previous) return
    setState(next)
    if (previous.status === "pending") {
      const request = requests.get(previous.attempt)
      requests.delete(previous.attempt)
      clearTimeout(request?.timer)
      request?.controller.abort()
    }
    if (next.status !== "pending") return
    const attempt = next.attempt
    const controller = new AbortController()
    requests.set(attempt, {
      controller,
      timer: setTimeout(() => dispatch({ type: "timeout", attempt }), 15_000),
    })
    void Promise.try(() => props.api.server.pair({ signal: controller.signal })).then(
      (result) =>
        dispatch({ type: "succeeded", attempt, code: result.code, expiresIn: result.expires_in, now: Date.now() }),
      () => dispatch({ type: "failed", attempt }),
    )
  }

  createEffect(() => {
    // Endpoint getters are not signals. Reconnect transitions, ticks, and request results all recheck identity.
    props.api
    untrack(() => {
      if (state().target !== props.api) dispatch({ type: "target.changed", target: props.api })
    })
  })
  const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), 1000)
  onCleanup(() => {
    clearInterval(timer)
    dispatch({ type: "disposed" })
  })

  return (
    <section class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.pairing.title")}</h3>
      <p class="text-13-regular text-v2-text-text-muted">{language.t("settings.pairing.warning")}</p>
      <p class="text-13-regular text-v2-text-text-muted">{language.t("settings.pairing.instructions")}</p>
      <Show when={view().code} keyed>
        {(code) => (
          <div class="flex flex-col gap-2">
            <TextField label={language.t("settings.pairing.code")} value={code} readOnly copyable class="font-mono" />
            <span class="text-13-regular">
              {language.t("settings.pairing.expires", {
                time: `${Math.floor(view().remaining / 60)}:${String(view().remaining % 60).padStart(2, "0")}`,
              })}
            </span>
          </div>
        )}
      </Show>
      <Show when={view().message} keyed>
        {(message) => <p role="status">{language.t(`settings.pairing.${message}`)}</p>}
      </Show>
      <div class="flex gap-2">
        <Button
          disabled={!view().generate}
          onClick={() => dispatch({ type: "generate", attempt: uuid(), now: Date.now() })}
        >
          {language.t(view().pending ? "settings.pairing.generating" : "settings.pairing.generate")}
        </Button>
        <Show when={view().clear}>
          <Button variant="ghost" onClick={() => dispatch({ type: "cancel" })}>
            {language.t("settings.pairing.clear")}
          </Button>
        </Show>
      </div>
      <p class="text-13-regular text-v2-text-text-muted">{language.t("settings.pairing.clearNotice")}</p>
    </section>
  )
}
