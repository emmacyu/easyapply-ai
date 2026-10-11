const BACKEND = 'http://localhost:8010'

const statusEl = document.getElementById('status')
const panelBtn = document.getElementById('panel')
const scanBtn = document.getElementById('scan')

function setStatus(msg, cls) {
  statusEl.textContent = msg
  statusEl.className = cls || ''
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

// The apply flow lives in the on-page panel (content.js), which opens by itself
// on application pages. This forces it open where auto-detection missed.
panelBtn.addEventListener('click', async () => {
  const tab = await activeTab()
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'jp-open-panel' }, { frameId: 0 })
    window.close()
  } catch (e) {
    setStatus("Couldn't open the panel here. Reload the page and try again (it can't run on chrome:// pages).", 'err')
  }
})

scanBtn.addEventListener('click', async () => {
  const tab = await activeTab()
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scanPage,
    })
    const count = results.reduce((n, r) => n + ((r.result && r.result.count) || 0), 0)
    setStatus(`Scanned ${count} field(s). Open DevTools → Console on the page to see the "[EasyApply] field inventory" table.`, 'ok')
  } catch (e) {
    setStatus(`Scan failed: ${e.message}`, 'err')
  }
})

const saveBtn = document.getElementById('save')

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true
  const tab = await activeTab()
  setStatus('Reading this page…')
  let grabbed
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        url: location.href,
        title: document.title,
        text: (document.body.innerText || '').slice(0, 20000),
      }),
    })
    grabbed = result
  } catch (e) {
    setStatus(`Couldn't read page: ${e.message}`, 'err')
    saveBtn.disabled = false
    return
  }
  setStatus('Saving to EasyApply…')
  try {
    const res = await fetch(`${BACKEND}/api/jobs/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: grabbed.url, title: grabbed.title, page_text: grabbed.text }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.detail || `HTTP ${res.status}`)
    if (j.duplicate) {
      setStatus(`Already saved: ${j.company} — ${j.title}`, 'warn')
    } else {
      setStatus(`Saved: ${j.company} — ${j.title}. It's in your board (Discovered).`, 'ok')
    }
  } catch (e) {
    setStatus(`Save failed: ${e.message}. Is EasyApply running?`, 'err')
  }
  saveBtn.disabled = false
})

const oaBtn = document.getElementById('oa')
oaBtn.addEventListener('click', async () => {
  oaBtn.disabled = true
  setStatus('Capturing screen…')
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 70 })
    const b64 = dataUrl.split(',')[1]
    setStatus('Reading the question & answering…')
    const res = await fetch(`${BACKEND}/api/oa/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: b64, mime_type: 'image/jpeg' }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.detail || `HTTP ${res.status}`)
    setStatus('✓ Answered — check your iPad (http://<your-mac-ip>:8010/oa).', 'ok')
  } catch (e) {
    setStatus(`OA failed: ${e.message}`, 'err')
  }
  oaBtn.disabled = false
})

const frBtn = document.getElementById('finalround')
frBtn.addEventListener('click', async () => {
  const tab = await activeTab()
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: launchFinalRound })
    setStatus('FinalRoundAI panel opened on the page — click "Start listening" there.', 'ok')
    window.close()
  } catch (e) {
    setStatus(`Couldn't open on this page: ${e.message}`, 'err')
  }
})

// ---------------------------------------------------------------------------
// Everything below is injected into the application page (must be self-contained).
// ---------------------------------------------------------------------------

// FinalRoundAI: a draggable on-page panel that captures the meeting tab's audio
// and, on demand, sends a clip to the backend (via the service worker) to get
// the transcribed question + your answer. Runs in the content-script world.
function launchFinalRound() {
  const existing = document.getElementById('jp-fr-panel')
  if (existing) {
    existing.style.display = 'flex'
    return
  }
  const panel = document.createElement('div')
  panel.id = 'jp-fr-panel'
  panel.style.cssText =
    'position:fixed;top:80px;right:20px;z-index:2147483647;width:340px;max-height:72vh;display:flex;flex-direction:column;background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:13px/1.45 -apple-system,system-ui,sans-serif;overflow:hidden'
  const btn = 'flex:1;padding:7px;border:0;border-radius:8px;font-weight:600;font-size:12px;cursor:pointer'
  panel.innerHTML =
    '<div id="jp-fr-head" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#1f2937;cursor:move"><b>🎤 FinalRoundAI</b><span><button id="jp-fr-min" style="background:none;border:0;color:#9ca3af;cursor:pointer;font-size:16px">–</button><button id="jp-fr-close" style="background:none;border:0;color:#9ca3af;cursor:pointer;font-size:16px">×</button></span></div>' +
    '<div style="padding:8px 10px;display:flex;gap:6px"><button id="jp-fr-start" style="' + btn + ';background:#2563eb;color:#fff">Start listening</button><button id="jp-fr-answer" style="' + btn + ';background:#374151;color:#fff" disabled>Answer</button></div>' +
    '<div id="jp-fr-status" style="padding:0 10px 6px;color:#9ca3af;font-size:11px"></div>' +
    '<div id="jp-fr-body" style="flex:1;overflow:auto;padding:0 10px 10px"></div>'
  document.body.appendChild(panel)

  const q = (s) => panel.querySelector(s)
  const statusEl = q('#jp-fr-status')
  const body = q('#jp-fr-body')
  const startBtn = q('#jp-fr-start')
  const ansBtn = q('#jp-fr-answer')
  const setS = (t) => (statusEl.textContent = t)
  setS('Click "Start listening", pick this meeting tab, and enable "Share tab audio".')

  // Draggable by the header.
  let dragging = false
  let dx = 0
  let dy = 0
  q('#jp-fr-head').addEventListener('mousedown', (e) => {
    dragging = true
    dx = e.clientX - panel.offsetLeft
    dy = e.clientY - panel.offsetTop
  })
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return
    panel.style.left = e.clientX - dx + 'px'
    panel.style.top = e.clientY - dy + 'px'
    panel.style.right = 'auto'
  })
  document.addEventListener('mouseup', () => (dragging = false))

  let stream = null
  let recorder = null
  let chunks = []
  let mime = 'audio/webm'
  let frSession = null // all answers in this panel go into one saved session

  const stopAll = () => {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch (e) {}
    try { if (stream) stream.getTracks().forEach((t) => t.stop()) } catch (e) {}
  }
  q('#jp-fr-close').addEventListener('click', () => { stopAll(); panel.remove() })
  q('#jp-fr-min').addEventListener('click', () => {
    body.style.display = body.style.display === 'none' ? 'block' : 'none'
  })

  const pickMime = () => {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m
    }
    return 'audio/webm'
  }
  const newRecorder = () => {
    chunks = []
    recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: mime })
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    recorder.start(1000)
  }

  startBtn.addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    } catch (e) {
      setS('Capture cancelled/failed: ' + e.message)
      return
    }
    if (!stream.getAudioTracks().length) {
      setS('No tab audio captured — restart and check "Share tab audio".')
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    stream.getVideoTracks().forEach((t) => t.stop()) // audio only
    mime = pickMime()
    newRecorder()
    startBtn.textContent = 'Listening…'
    startBtn.disabled = true
    ansBtn.disabled = false
    ansBtn.style.background = '#2563eb'
    setS('Listening. When the interviewer finishes a question, click Answer.')
  })

  const render = (question, answer) => {
    const card = document.createElement('div')
    card.style.cssText = 'margin-top:8px;padding:8px;border:1px solid #374151;border-radius:8px;background:#0b1220'
    const esc = (s) => String(s || '').replace(/</g, '&lt;')
    card.innerHTML =
      (question ? '<div style="color:#9ca3af;font-size:11px;margin-bottom:4px">Q: ' + esc(question) + '</div>' : '') +
      '<div style="white-space:pre-wrap">' + esc(answer) + '</div>'
    body.insertBefore(card, body.firstChild)
  }

  ansBtn.addEventListener('click', async () => {
    if (!recorder) return
    ansBtn.disabled = true
    setS('Transcribing & answering…')
    const done = new Promise((res) => { recorder.onstop = res })
    recorder.stop()
    await done
    const blob = new Blob(chunks, { type: mime })
    newRecorder() // keep listening
    const b64 = await new Promise((res) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result).split(',')[1])
      r.readAsDataURL(blob)
    })
    chrome.runtime.sendMessage(
      { type: 'fr-audio', audio_base64: b64, mime_type: mime.split(';')[0], session_id: frSession },
      (resp) => {
        ansBtn.disabled = false
        setS('Listening. (saved to your FinalRoundAI history)')
        if (!resp || !resp.ok) {
          render('', '⚠ ' + ((resp && (resp.detail || resp.error)) || 'request failed'))
          return
        }
        if (resp.session_id) frSession = resp.session_id
        render(resp.question, resp.answer)
      }
    )
  })
}

