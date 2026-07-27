// Service worker: the on-page FinalRoundAI overlay can't call localhost directly
// (page-origin CORS), so it relays audio here; the extension has host access.
const BACKEND = 'http://localhost:8000'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'fr-audio') {
    fetch(`${BACKEND}/api/finalround/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: msg.audio_base64,
        mime_type: msg.mime_type,
        session_id: msg.session_id || null,
      }),
    })
      .then((r) => r.json().then((j) => sendResponse({ ok: r.ok, ...j })))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true // async response
  }
})
