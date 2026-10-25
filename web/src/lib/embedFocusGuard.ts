/**
 * Tap-only focus for the composer when HAPI is embedded by the owner's car dashboard (any trusted embed, incl. the
 * car frame `embed=car`). There the composer must take focus ONLY from the owner's own tap (or keyboard Tab) on it:
 * a focus would pop up the on-screen keyboard over the car screen. assistant-ui and our own code focus the textarea
 * on run start, scroll to bottom, thread switch, suggestion/phrase insert etc.; rather than chase every call site,
 * this guard
 *  - turns `.focus()` on the composer textarea into a no-op unless a real pointer/touch/click on it (or a Tab key)
 *    happened within INTENT_MS, and
 *  - blurs it at once if it gets focus any other way (a focus event without such an intent), so after he dismissed
 *    the keyboard or tapped elsewhere it stays unfocused until he taps it again.
 * The composer textarea is marked with `data-hapi-composer`. Standalone HAPI never installs the guard.
 */
const INTENT_MS = 800
const ATTR = 'data-hapi-composer'

let installed = false
let intentAt = 0
let intentTarget: Element | null = null

function isComposer(el: unknown): el is HTMLElement {
    return el instanceof HTMLElement && el.hasAttribute(ATTR)
}

function hasIntent(el: Element): boolean {
    if (Date.now() - intentAt >= INTENT_MS || intentTarget === null) return false
    // documentElement = a Tab key press (keyboard navigation), else the tapped composer itself
    return intentTarget === document.documentElement || intentTarget === el || el.contains(intentTarget)
}

export function isFocusGuardActive(): boolean {
    return installed
}

export function installEmbedFocusGuard(): void {
    if (installed || typeof window === 'undefined') return
    installed = true

    const mark = (ev: Event) => {
        const t = ev.target
        if (t instanceof Element) {
            const c = t.closest(`[${ATTR}]`)
            if (c) {
                intentAt = Date.now()
                intentTarget = c
            }
        }
    }
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click']) {
        document.addEventListener(type, mark, { capture: true, passive: true })
    }
    document.addEventListener('keydown', (ev) => {
        // Keyboard navigation into the composer (desktop with a keyboard) counts as his own intent.
        if (ev.key === 'Tab') {
            intentAt = Date.now()
            intentTarget = document.documentElement
        }
    }, { capture: true })

    const proto = HTMLElement.prototype
    const nativeFocus = proto.focus
    proto.focus = function (this: HTMLElement, options?: FocusOptions) {
        if (isComposer(this) && document.activeElement !== this && !hasIntent(this)) {
            return
        }
        return nativeFocus.call(this, options)
    }

    document.addEventListener('focusin', (ev) => {
        const t = ev.target
        if (!isComposer(t)) return
        if (hasIntent(t)) return
        t.blur()
    }, { capture: true })
}
