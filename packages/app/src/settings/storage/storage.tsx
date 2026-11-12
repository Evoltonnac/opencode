import { Button } from "@opencode/ui/button"
import { Progress } from "@opencode/ui/progress"
import { TextField } from "@opencode/ui/text-field"
import { uuid } from "@opencode/util/uuid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerApi } from "@/runtime/server/api"
import type { OpenCodeEventStream } from "@/runtime/server/client"
import { StorageRpc, type StorageUsage } from "./rpc"
import type { StorageCapacity } from "./model"
import { formatStorageBytes, storageView, transitionStorage, type StorageEvent, type StorageState } from "./machine"
import "./storage.css"

export function SettingsStorage(props: { api: ServerApi; event: OpenCodeEventStream }) {
  const language = useLanguage()
  const [state, setState] = createSignal<StorageState>({ status: "idle", target: props.api })
  const view = createMemo(() => storageView(state()))
  const requests = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()

  const requestID = (value: StorageState) =>
    value.status === "pending" || value.status === "saving" || value.status === "confirming" ? value.attempt : undefined

  const dispatch = (event: StorageEvent) => {
    if (event.type !== "disposed" && event.type !== "target.changed" && untrack(state).target !== props.api) {
      dispatch({ type: "target.changed", target: props.api })
    }

    const previous = untrack(state)
    const next = transitionStorage(previous, event)

    if (next === previous) return
    setState(next)

    const previousID = requestID(previous)
    const nextID = requestID(next)

    if (previousID === nextID) return

    if (previousID) {
      const request = requests.get(previousID)
      requests.delete(previousID)
      clearTimeout(request?.timer)
      request?.controller.abort()
    }

    if (next.status !== "pending" && next.status !== "saving" && next.status !== "confirming") return
    const attempt = next.attempt
    const controller = new AbortController()

    const failure = () => {
      if (next.status === "saving") dispatch({ type: "save.failed", attempt, confirmAttempt: uuid() })
      else dispatch({ type: next.status === "confirming" ? "confirmation.failed" : "failed", attempt })
    }

    requests.set(attempt, {
      controller,
      timer: setTimeout(failure, 10_000),
    })
    const rpc = props.api.rpc(StorageRpc)
    const options = { location: { directory: "/srv/opencode/workspace" }, signal: controller.signal }
    void Promise.try(() => {
      if (next.status === "saving") return rpc.setCapacity({ capacityBytes: next.wanted }, options)

      if (next.status === "confirming") return rpc.getCapacity({}, options)

      return rpc.usage({}, options)
    }).then((output) => {
      if (next.status === "pending") {
        // SAFETY: The registered RPC validates this JSON against usage's output schema.
        const data = output as StorageUsage
        dispatch({ type: "succeeded", attempt, data })

        return
      }

      // SAFETY: Both capacity methods validate this JSON against their shared output schema.
      const capacity = output as StorageCapacity
      dispatch({
        type: next.status === "saving" ? "capacity.saved" : "capacity.confirmed",
        attempt,
        capacityBytes: capacity.capacityBytes,
      })
    }, failure)
  }

  const refresh = () => dispatch({ type: "refresh", attempt: uuid() })
  createEffect(() => {
    const target = props.api
    untrack(() => {
      dispatch({ type: "target.changed", target })

      refresh()
    })
  })

  const timer = setInterval(() => {
    if (document.visibilityState === "visible") refresh()
  }, 60_000)

  onCleanup(
    props.event.on("plugin.updated", (event) => {
      if (event.location && event.location.directory !== "/srv/opencode/workspace") return
      dispatch({ type: "invalidated", attempt: uuid() })
    }),
  )

  onCleanup(() => {
    clearInterval(timer)
    dispatch({ type: "disposed" })
  })

  return (
    <section class="settings-section settings-storage" data-severity={view().severity}>
      <div class="settings-storage-heading">
        <h3 class="settings-section-title">{language.t("settings.storage.title")}</h3>
        <Button variant="ghost" size="small" disabled={view().pending || view().saving} onClick={refresh}>
          {language.t(view().pending ? "settings.storage.refreshing" : "settings.storage.refresh")}
        </Button>
      </div>
      <Show
        when={view().data}
        fallback={
          <p role="status">{language.t(view().failed ? "settings.storage.failed" : "settings.storage.loading")}</p>
        }
      >
        {(data) => (
          <>
            <div class="settings-storage-heading text-13-regular">
              <span>
                {language.t("settings.storage.used", {
                  used: formatStorageBytes(data().totalBytes),
                  capacity: formatStorageBytes(data().capacityBytes),
                })}
              </span>
              <span class="settings-storage-percentage">{Number((view().percent ?? 0).toFixed(1))}%</span>
            </div>
            <Progress value={Math.min(100, view().percent ?? 0)} hideLabel>
              {language.t("settings.storage.title")}
            </Progress>
            <p class="text-13-regular text-v2-text-text-muted">{language.t("settings.storage.reference")}</p>
            <form class="settings-storage-capacity" onSubmit={(event) => {
              event.preventDefault()
              dispatch({ type: "save", attempt: uuid() })
            }}>
              <TextField
                label={language.t("settings.storage.capacity")}
                inputMode="decimal"
                value={view().input}
                disabled={view().saving}
                validationState={view().invalid ? "invalid" : "valid"}
                error={view().invalid ? language.t("settings.storage.invalidCapacity") : undefined}
                onChange={(value) => dispatch({ type: "draft.changed", value })}
              />
              <div class="settings-storage-actions">
                <Button type="submit" size="small" disabled={!view().canSave}>
                  {language.t(view().saving ? "settings.storage.saving" : "settings.storage.save")}
                </Button>
                <Show when={view().dirty}>
                  <Button type="button" variant="ghost" size="small" disabled={view().saving}
                    onClick={() => dispatch({ type: "draft.cancelled" })}>
                    {language.t("settings.storage.cancel")}
                  </Button>
                </Show>
              </div>
            </form>
            <Show when={view().confirming || view().notice}>
              <p role="status" class="text-13-regular text-v2-text-text-muted">
                {language.t(view().confirming ? "settings.storage.confirming" :
                  view().notice === "saved" ? "settings.storage.saved" : "settings.storage.saveUnknown")}
              </p>
            </Show>
            <Show when={view().failed}>
              <p role="status">{language.t("settings.storage.stale")}</p>
            </Show>
            <Show when={!data().complete}>
              <p role="status">{language.t("settings.storage.partial")}</p>
            </Show>
            <details class="settings-storage-details">
              <summary class="text-13-regular">{language.t("settings.storage.details")}</summary>
              <dl class="settings-storage-list text-13-regular">
                <For each={data().categories}>
                  {(entry) => (
                    <div>
                      <dt>{language.t(`settings.storage.category.${entry.id}`)}</dt>
                      <dd>
                        {formatStorageBytes(entry.bytes)}
                        {entry.complete ? "" : "+"}
                      </dd>
                    </div>
                  )}
                </For>
                <div>
                  <dt>{language.t("settings.storage.sessions")}</dt>
                  <dd>{data().sessions}</dd>
                </div>
                <div>
                  <dt>{language.t("settings.storage.messages")}</dt>
                  <dd>{data().messages}</dd>
                </div>
              </dl>
              <p class="text-13-regular text-v2-text-text-muted">{language.t("settings.storage.scope")}</p>
              <p class="text-13-regular text-v2-text-text-muted">{language.t("settings.storage.freePages")}</p>
            </details>
            <p class="text-11-regular text-v2-text-text-muted">
              {language.t("settings.storage.updated", { time: new Date(data().sampledAt).toLocaleTimeString() })}
            </p>
          </>
        )}
      </Show>
    </section>
  )
}
