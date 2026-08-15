import { readStoredAccessToken } from '@/hooks/useAuthSource'

/**
 * Hand the current login over to the low-power UI at `/lite` and navigate there.
 *
 * The token is submitted as a form POST rather than as `/lite?token=...` on purpose:
 * a query string would be written into browser history and into the hub's request log,
 * whereas a POST body is neither. `/lite/login` validates it and sets the 30-day
 * `hapi_lite` cookie.
 *
 * Without an access token (a Telegram session), we just navigate: `/lite` also accepts
 * the SPA's own `hapi_token` cookie, which works for as long as that session is valid.
 */
export function openLiteUi(baseUrl: string): void {
    const origin = baseUrl.replace(/\/+$/, '')
    const token = readStoredAccessToken(baseUrl)

    if (!token) {
        window.location.href = `${origin}/lite`
        return
    }

    const form = document.createElement('form')
    form.method = 'POST'
    form.action = `${origin}/lite/login`
    form.style.display = 'none'

    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = 'token'
    input.value = token
    form.appendChild(input)

    document.body.appendChild(form)
    form.submit()
}
