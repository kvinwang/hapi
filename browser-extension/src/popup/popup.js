// Popup script — plain JS (no bundling needed)

const $ = (id) => document.getElementById(id)

const statusDot = $('statusDot')
const btnConnect = $('btnConnect')
const btnDisconnect = $('btnDisconnect')
const statusInfo = $('statusInfo')
const hubUrlInput = $('hubUrl')
const tokenInput = $('token')
const machineIdInput = $('machineId')
const machineNameInput = $('machineName')

function generateUUID() {
    return crypto.randomUUID()
}

function updateUI(status) {
    const connected = status?.connected ?? false
    statusDot.classList.toggle('connected', connected)
    btnConnect.disabled = false

    if (connected) {
        btnConnect.classList.add('hidden')
        btnConnect.textContent = 'Connect'
        btnDisconnect.classList.remove('hidden')
        statusInfo.classList.remove('hidden')
        $('infoHub').textContent = status.config?.hubUrl ?? ''
        $('infoMachine').textContent = `${status.config?.machineName ?? ''} (${(status.config?.machineId ?? '').slice(0, 8)}...)`
        $('infoTunnels').textContent = String(status.activeTunnels ?? 0)
    } else {
        btnConnect.classList.remove('hidden')
        btnDisconnect.classList.add('hidden')
        statusInfo.classList.remove('hidden')
        if (status?.error) {
            $('infoHub').textContent = ''
            $('infoMachine').textContent = ''
            $('infoTunnels').textContent = ''
            statusInfo.innerHTML = `<div style="color:#f38ba8">${status.error}</div>`
        } else {
            statusInfo.classList.add('hidden')
        }
    }
}

// Load saved config
chrome.storage.local.get(['hubUrl', 'token', 'machineId', 'machineName'], (data) => {
    if (data.hubUrl) hubUrlInput.value = data.hubUrl
    if (data.token) tokenInput.value = data.token
    if (data.machineId) machineIdInput.value = data.machineId
    if (data.machineName) machineNameInput.value = data.machineName
})

// Generate UUID button
$('genUuid').addEventListener('click', (e) => {
    e.preventDefault()
    machineIdInput.value = generateUUID()
})

// Auto-generate UUID if empty on first load
chrome.storage.local.get(['machineId'], (data) => {
    if (!data.machineId && !machineIdInput.value) {
        machineIdInput.value = generateUUID()
    }
})

// Get current status
chrome.runtime.sendMessage({ type: 'status' }, updateUI)

// Poll status while popup is open
const pollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'status' }, updateUI)
}, 2000)
window.addEventListener('unload', () => clearInterval(pollInterval))

btnConnect.addEventListener('click', () => {
    const machineId = machineIdInput.value.trim() || generateUUID()
    machineIdInput.value = machineId

    const config = {
        hubUrl: hubUrlInput.value.trim().replace(/\/$/, ''),
        token: tokenInput.value.trim(),
        machineId,
        machineName: machineNameInput.value.trim() || 'Browser',
    }

    if (!config.hubUrl || !config.token) {
        alert('Hub URL and Token are required')
        return
    }

    // Show connecting state
    btnConnect.textContent = 'Connecting...'
    btnConnect.disabled = true

    chrome.runtime.sendMessage({ type: 'connect', config }, (resp) => {
        if (resp?.error) {
            updateUI({ connected: false, error: resp.error })
        }
        // Poll will pick up the connected state
    })
})

btnDisconnect.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
        chrome.runtime.sendMessage({ type: 'status' }, updateUI)
    })
})
