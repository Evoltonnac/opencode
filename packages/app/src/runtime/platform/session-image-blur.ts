export const sessionImageBlurKey = "opencode-session-image-blur"

const attribute = "data-session-images-blurred"

export function sessionImagesBlurred() {
  return document.documentElement.hasAttribute(attribute)
}

export function applySessionImageBlur(value: boolean) {
  document.documentElement.toggleAttribute(attribute, value)
}

export function restoreSessionImageBlur() {
  try {
    applySessionImageBlur(localStorage.getItem(sessionImageBlurKey) === "1")
  } catch {
    // The page can still toggle the preference for this visit when storage is unavailable.
  }
}

export function saveSessionImageBlur(value: boolean) {
  applySessionImageBlur(value)
  try {
    localStorage.setItem(sessionImageBlurKey, value ? "1" : "0")
  } catch {
    // The document already reflects the choice.
  }
}
