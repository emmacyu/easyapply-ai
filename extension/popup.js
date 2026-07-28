const BACKEND = 'http://localhost:8000'

const statusEl = document.getElementById('status')
const fillBtn = document.getElementById('fill')
const scanBtn = document.getElementById('scan')

function setStatus(msg, cls) {
  statusEl.textContent = msg
  statusEl.className = cls || ''
}

async function getProfile() {
  const res = await fetch(`${BACKEND}/api/profile`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

const MAX_AI_FIELDS = 10 // cap LLM calls per click (free-tier quota)

// Shared steps, reused by the standalone buttons and the combined "Apply".
async function doFill(tab, profile) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: fillForm,
    args: [profile],
  })
  const filled = results.reduce((n, r) => n + ((r.result && r.result.filled) || 0), 0)
  const fields = []
  for (const r of results) for (const f of (r.result && r.result.fields) || []) fields.push(f)
  return { filled, fields }
}

// Log a blocker (ApplyPilot-style) against the selected job, if any.
async function logBlocker(jobId, kind, detail) {
  if (!jobId) return
  try {
    await fetch(`${BACKEND}/api/jobs/${jobId}/blocker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, detail }),
    })
  } catch (e) {
    /* best-effort */
  }
}

async function doAiAnswer(tab, setMsg) {
  const injResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: collectBlanks,
  })
  const pending = []
  for (const r of injResults)
    for (const b of (r.result && r.result.blanks) || []) pending.push({ frameId: r.frameId, ...b })
  if (pending.length === 0) return { answered: 0, total: 0 }
  const batch = pending.slice(0, MAX_AI_FIELDS)
  if (setMsg) setMsg(`Answering ${batch.length} question(s) with AI…`)
  const byFrame = {}
  let answered = 0
  for (const p of batch) {
    try {
      const res = await fetch(`${BACKEND}/api/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: p.label, options: p.options || undefined }),
      })
      const j = await res.json()
      if (res.ok && j.answer) {
        ;(byFrame[p.frameId] = byFrame[p.frameId] || []).push({ idx: p.idx, answer: j.answer })
        answered++
      }
    } catch (e) {
      /* one field failed */
    }
  }
  for (const [frameId, items] of Object.entries(byFrame)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [Number(frameId)] },
        func: applyAnswers,
        args: [items],
      })
    } catch (e) {
      /* frame gone */
    }
  }
  return { answered, total: pending.length }
}

// Fetch the job's tailored resume PDF and drop it into the page's file input(s).
async function doAttachResume(tab, jobId, setMsg) {
  if (!jobId) return { attached: 0 }
  if (setMsg) setMsg('Fetching tailored resume…')
  const res = await fetch(`${BACKEND}/api/jobs/${jobId}/resume`)
  if (!res.ok) throw new Error(`resume HTTP ${res.status}`)
  const blob = await res.blob()
  const b64 = await new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1])
    r.readAsDataURL(blob)
  })
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: attachResumeFn,
    args: [b64, `resume_${jobId}.pdf`],
  })
  return {
    attached: results.reduce((n, r) => n + ((r.result && r.result.attached) || 0), 0),
    verified: results.reduce((n, r) => n + ((r.result && r.result.verified) || 0), 0),
  }
}

// Populate the resume picker from jobs that already have tailored materials,
// auto-selecting the one whose company appears on the current page.
async function loadApplyJobs() {
  const sel = document.getElementById('applyJob')
  try {
    const res = await fetch(`${BACKEND}/api/jobs?status=materials_ready&page_size=50`)
    const data = await res.json()
    const jobs = (data && data.items) || []
    if (!jobs.length) return
    let pageText = ''
    try {
      const tab = await activeTab()
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (document.body.innerText || '').slice(0, 4000).toLowerCase(),
      })
      pageText = result || ''
    } catch (e) {
      /* can't read page (e.g. chrome:// tab) */
    }
    for (const j of jobs) {
      const opt = document.createElement('option')
      opt.value = String(j.id)
      opt.textContent = `Resume: ${j.company} — ${j.title}`.slice(0, 58)
      if (pageText && j.company && pageText.includes(String(j.company).toLowerCase())) {
        opt.selected = true
      }
      sel.appendChild(opt)
    }
  } catch (e) {
    /* backend down — leave "none" */
  }
}
loadApplyJobs()

fillBtn.addEventListener('click', async () => {
  fillBtn.disabled = true
  setStatus('Loading profile…')
  let profile
  try {
    profile = await getProfile()
  } catch (e) {
    setStatus(`Can't reach JobPilot at ${BACKEND}. Is it running? (${e.message})`, 'err')
    fillBtn.disabled = false
    return
  }
  const tab = await activeTab()
  setStatus('Filling… (Workday dropdowns take a moment)')
  try {
    const { filled } = await doFill(tab, profile)
    if (filled > 0) {
      setStatus(`Filled ${filled} field(s). Review the green-outlined fields, then submit.`, 'ok')
    } else {
      setStatus('No matching fields found. Try "Scan page (debug)" and share the console output.', 'warn')
    }
  } catch (e) {
    setStatus(`Fill failed: ${e.message}`, 'err')
  }
  fillBtn.disabled = false
})

// Combined one-click: fill fields + AI-answer questions + attach tailored resume,
// then stop for you to review and hit the site's own Submit.
const applyBtn = document.getElementById('apply')
applyBtn.addEventListener('click', async () => {
  applyBtn.disabled = true
  setStatus('Loading profile…')
  let profile
  try {
    profile = await getProfile()
  } catch (e) {
    setStatus(`Can't reach JobPilot at ${BACKEND}. Is it running? (${e.message})`, 'err')
    applyBtn.disabled = false
    return
  }
  const tab = await activeTab()
  const jobId = document.getElementById('applyJob').value
  try {
    setStatus('Filling fields… (Workday dropdowns take a moment)')
    const { filled, fields } = await doFill(tab, profile)
    const { answered } = await doAiAnswer(tab, setStatus)
    let resumeMsg = ''
    if (jobId) {
      try {
        const { attached, verified } = await doAttachResume(tab, jobId, setStatus)
        if (attached && verified) {
          resumeMsg = ' Resume attached ✓.'
        } else if (attached) {
          resumeMsg = ' Resume set but NOT verified — check the upload!'
          logBlocker(jobId, 'upload', 'resume file set but could not be verified')
        } else {
          resumeMsg = ' (No file upload found — attach resume manually.)'
          logBlocker(jobId, 'missing_file', 'no file input found on the application page')
        }
      } catch (e) {
        resumeMsg = ` (Resume attach failed: ${e.message} — attach manually.)`
        logBlocker(jobId, 'upload', `resume attach failed: ${e.message}`)
      }
    }
    if (filled === 0 && answered === 0) {
      logBlocker(jobId, 'other', 'nothing filled — form may be a custom/complex ATS')
    }
    // Pre-submit summary of high-impact fields (work auth / sponsorship / comp / EEO).
    const important = fields.filter((f) => f.important)
    const summary = important.length
      ? '\n\n⚠ Review before Submit:\n' + important.map((f) => `• ${f.label}: ${f.value}`).join('\n')
      : ''
    setStatus(
      `✓ Filled ${filled} field(s), AI-answered ${answered}.${resumeMsg}\n` +
        `Green = profile, blue = AI. Review, then click the site's Submit.${summary}`,
      'ok'
    )
  } catch (e) {
    setStatus(`Apply failed: ${e.message}`, 'err')
  }
  applyBtn.disabled = false
})

scanBtn.addEventListener('click', async () => {
  const tab = await activeTab()
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scanPage,
    })
    const count = results.reduce((n, r) => n + ((r.result && r.result.count) || 0), 0)
    setStatus(`Scanned ${count} field(s). Open DevTools → Console on the page to see the "[JobPilot] field inventory" table.`, 'ok')
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
  setStatus('Saving to JobPilot…')
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
    setStatus(`Save failed: ${e.message}. Is JobPilot running?`, 'err')
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
    setStatus('✓ Answered — check your iPad (http://<your-mac-ip>:8000/oa).', 'ok')
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

const aiBtn = document.getElementById('ai')

aiBtn.addEventListener('click', async () => {
  aiBtn.disabled = true
  const tab = await activeTab()
  setStatus('Finding blank questions…')
  try {
    const { answered, total } = await doAiAnswer(tab, setStatus)
    if (total === 0) {
      setStatus('No blank question fields found (try "Fill this page" first).', 'warn')
    } else {
      const extra = total > answered ? ` (${total - answered} not answered — cap ${MAX_AI_FIELDS} or quota)` : ''
      setStatus(
        answered
          ? `AI-filled ${answered} field(s) in blue — review them before submitting.${extra}`
          : `Couldn't answer any (LLM quota/error?).`,
        answered ? 'ok' : 'warn'
      )
    }
  } catch (e) {
    setStatus(`AI-answer failed: ${e.message}`, 'err')
  }
  aiBtn.disabled = false
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

function collectBlanks() {
  const norm = (s) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  const labelText = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (l && l.innerText.trim()) return l.innerText
    }
    const wrap = el.closest('label')
    if (wrap && wrap.innerText.trim()) return wrap.innerText
    const grp = el.closest('[data-automation-id^="formField"], fieldset, [role="group"]')
    if (grp) {
      const lab = grp.querySelector('label, legend')
      if (lab && lab.innerText.trim()) return lab.innerText
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
    if (el.placeholder) return el.placeholder
    let node = el
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement
      if (!node) break
      const clone = node.cloneNode(true)
      clone.querySelectorAll('input,select,textarea,option,button').forEach((n) => n.remove())
      const t = (clone.innerText || '').trim()
      if (t && t.length < 200) return t
    }
    return ''
  }

  const blanks = []
  let idx = 0
  const fields = [...document.querySelectorAll('input, select, textarea')]
  for (const el of fields) {
    if (el.disabled || el.readOnly) continue
    const type = (el.type || '').toLowerCase()
    if (['hidden', 'submit', 'button', 'file', 'password', 'image', 'reset', 'radio', 'checkbox'].includes(type)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const isSelect = el.tagName === 'SELECT'
    const empty = isSelect ? el.selectedIndex <= 0 : !el.value
    if (!empty) continue

    const label = labelText(el).trim()
    const nlabel = norm(label)
    if (nlabel.length < 3) continue

    let options = null
    if (isSelect) {
      options = [...el.options]
        .map((o) => o.text.trim())
        .filter((t) => t && !/^(select|choose|no selection)/i.test(t))
      if (options.length === 0) continue
    }
    // Only spend an LLM call on real questions: textareas, selects, or long/?-labels.
    const isQuestion = el.tagName === 'TEXTAREA' || isSelect || nlabel.length >= 15 || label.includes('?')
    if (!isQuestion) continue

    el.setAttribute('data-jp-idx', String(idx))
    blanks.push({ idx, label, options, tag: el.tagName.toLowerCase() })
    idx++
  }
  return { blanks }
}

function applyAnswers(items) {
  const norm = (s) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  const nativeSet = (el, value) => {
    const proto =
      el.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    const d = Object.getOwnPropertyDescriptor(proto, 'value')
    if (d && d.set) d.set.call(el, value)
    else el.value = value
  }
  let filled = 0
  for (const { idx, answer } of items) {
    const el = document.querySelector(`[data-jp-idx="${idx}"]`)
    if (!el || !answer) continue
    if (el.tagName === 'SELECT') {
      const na = norm(answer)
      const opt = [...el.options].find(
        (o) => norm(o.text) === na || (na && (norm(o.text).includes(na) || na.includes(norm(o.text))))
      )
      if (!opt) continue
      nativeSet(el, opt.value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      nativeSet(el, String(answer))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    el.style.outline = '2px solid #3b82f6' // blue = AI-generated, review
    el.style.outlineOffset = '1px'
    filled++
  }
  return { filled }
}

// Drop the tailored resume PDF into the page's file input(s). Works for standard
// <input type=file> (Greenhouse, Lever); custom drop-zones usually still have a
// hidden file input behind them, which this sets via a DataTransfer.
function attachResumeFn(b64, filename) {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  const file = new File([arr], filename, { type: 'application/pdf' })

  const inputs = [...document.querySelectorAll('input[type="file"]')].filter((el) => !el.disabled)
  let attached = 0
  let verified = 0
  for (const input of inputs) {
    // With multiple file inputs, only fill the resume-ish one (skip cover letter,
    // transcripts, etc.). A lone file input on an application form is the resume.
    const hint = (
      (input.name || '') +
      ' ' +
      (input.id || '') +
      ' ' +
      (input.getAttribute('aria-label') || '') +
      ' ' +
      ((input.closest('[class*="field"], label, [data-automation-id]') || {}).innerText || '')
    ).toLowerCase()
    if (inputs.length > 1 && !/resume|cv|résumé/.test(hint)) continue
    try {
      const dt = new DataTransfer()
      dt.items.add(file)
      input.files = dt.files
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      attached++
      // Verify the file actually stuck (some ATS reject programmatic sets).
      if (input.files && input.files.length > 0) {
        verified++
        input.style.outline = '2px solid #22c55e'
      } else {
        input.style.outline = '2px solid #f59e0b' // amber = set but unverified
      }
    } catch (e) {
      /* this input rejected the file */
    }
  }
  return { attached, verified }
}

function scanPage() {
  // Proper label detection: label[for] / el.labels / aria / placeholder / nearby text.
  const detect = (el) => {
    if (el.labels && el.labels[0] && el.labels[0].innerText.trim()) return el.labels[0].innerText
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (l && l.innerText.trim()) return l.innerText
    }
    const wrap = el.closest('label')
    if (wrap && wrap.innerText.trim()) return wrap.innerText
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
    if (el.placeholder) return el.placeholder
    let n = el
    for (let i = 0; i < 4 && n; i++) {
      n = n.parentElement
      if (!n) break
      const c = n.cloneNode(true)
      c.querySelectorAll('input,select,textarea,option,button').forEach((x) => x.remove())
      const t = (c.innerText || '').replace(/\s+/g, ' ').trim()
      if (t && t.length < 120) return t
    }
    return ''
  }
  const controls = [...document.querySelectorAll('input, select, textarea')]
  const lines = controls.map((el, i) => {
    const label = detect(el).replace(/\s+/g, ' ').trim().slice(0, 70)
    const opts =
      el.tagName === 'SELECT'
        ? ' opts=[' +
          [...el.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 6).join(' | ') +
          ']'
        : ''
    const val = (el.value || '').slice(0, 30)
    return `${i} [${el.tagName.toLowerCase()}/${el.type || ''}] "${label}"${el.name ? ' name=' + el.name : ''}${val ? ' val="' + val + '"' : ''}${opts}`
  })
  // One field per line so nothing gets truncated in a screenshot.
  // eslint-disable-next-line no-console
  console.log('[JobPilot] fields (' + controls.length + '):\n' + lines.join('\n'))
  return { count: controls.length }
}

async function fillForm(profile) {
  const P = (profile && profile.personal) || {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const norm = (s) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()

  const _split = String(P.name || '').trim().split(/\s+/).filter(Boolean)
  const firstName = P['first name'] || _split[0] || ''
  const lastName = P['last name'] || (_split.length > 1 ? _split[_split.length - 1] : '')
  const fullName = P.name || [firstName, lastName].filter(Boolean).join(' ')

  const entries = []
  // `important` marks high-impact fields (work auth / sponsorship / comp / EEO)
  // that the pre-submit summary surfaces for the user to review.
  const add = (aliases, value, important) => {
    if (value === undefined || value === null || value === '' || typeof value === 'boolean') return
    entries.push({ aliases: aliases.map(norm), value: String(value), important: !!important })
  }
  const filledFields = [] // {label, value, important} for the pre-submit summary
  add(['first name', 'given name', 'legal first name'], firstName)
  add(['last name', 'surname', 'family name', 'legal last name'], lastName)
  add(['full name', 'legal name', 'applicant name', 'full legal name', 'first and last name'], fullName)
  add(['email', 'e mail', 'email address'], P.email)
  add(['phone', 'mobile', 'telephone', 'phone number', 'cell'], P.phone)
  // Location: split "Toronto, ON, Canada" into city / province / country parts.
  const locParts = String(P.location || '').split(',').map((s) => s.trim()).filter(Boolean)
  add(['location', 'current location', 'present location', 'mailing address'], P.location)
  add(['city', 'town'], locParts[0])
  const PROV = { ON: 'Ontario', BC: 'British Columbia', AB: 'Alberta', QC: 'Quebec', MB: 'Manitoba', SK: 'Saskatchewan', NS: 'Nova Scotia', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island', NT: 'Northwest Territories', YT: 'Yukon', NU: 'Nunavut' }
  if (locParts[1]) add(['province', 'state', 'state province', 'state or province'], PROV[locParts[1].toUpperCase()] || locParts[1])
  // Country: explicit key, else last comma-part of location.
  const country = P.country || locParts[locParts.length - 1]
  add(['country', 'country of residence'], country)
  add(['linkedin', 'linkedin url', 'linkedin profile'], P.linkedin)
  add(['github', 'github url', 'portfolio', 'website'], P.github)
  add(['salary', 'salary expectation', 'expected salary', 'base salary', 'compensation', 'annual base salary'], profile.min_salary_cad, true)
  add(['legally eligible to work', 'authorized to work', 'eligible to work', 'legally authorized', 'right to work', 'work authorization', 'legally entitled to work'], 'Yes', true)
  add(['require sponsorship', 'need sponsorship', 'visa sponsorship', 'sponsorship'], P.needs_sponsorship ? 'Yes' : 'No', true)
  add(['veteran', 'military service', 'armed forces', 'served in the military'], P['had any Canadian military service?'], true)
  add(['indigenous person', 'indigenous', 'first nations', 'aboriginal'], P['an Indigenous/Aboriginal person who is First Nations, Inuit or Métis?'], true)
  add(['disability', 'person with a disability', 'non visible disability', 'visible or non visible disability'], P['a person with a disability'], true)
  add(['visible minority', 'member of a visible minority'], P['visible minority group'], true)
  const skip = new Set(['name', 'first name', 'last name', 'email', 'phone', 'location', 'linkedin', 'github', 'needs_sponsorship'])
  for (const [k, v] of Object.entries(P)) {
    if (skip.has(k)) continue
    add([k], v)
  }

  const sim = (a, b) => {
    if (!a || !b) return 0
    const A = new Set(a.split(' ').filter((x) => x.length > 2))
    const B = new Set(b.split(' ').filter((x) => x.length > 2))
    if (A.size === 0 || B.size === 0) return a.includes(b) || b.includes(a) ? 0.6 : 0
    let inter = 0
    for (const x of A) if (B.has(x)) inter++
    const jac = inter / (A.size + B.size - inter)
    const bonus = a.includes(b) || b.includes(a) ? 0.3 : 0
    return Math.min(1, jac + bonus)
  }
  const bestEntry = (label) => {
    let best = null
    let score = 0
    for (const e of entries)
      for (const a of e.aliases) {
        const s = sim(label, a)
        if (s > score) {
          score = s
          best = e
        }
      }
    return score >= 0.5 ? best : null
  }

  const labelText = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (l && l.innerText.trim()) return l.innerText
    }
    const wrap = el.closest('label')
    if (wrap && wrap.innerText.trim()) return wrap.innerText
    // Workday/ATS: the question label lives on the field-group container.
    const grp = el.closest('[data-automation-id^="formField"], fieldset, [role="group"]')
    if (grp) {
      const lab = grp.querySelector('label, legend')
      if (lab && lab.innerText.trim()) return lab.innerText
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
    const lb = el.getAttribute('aria-labelledby')
    if (lb) {
      const t = lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ')
      if (t.trim()) return t
    }
    if (el.placeholder) return el.placeholder
    let node = el
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement
      if (!node) break
      const clone = node.cloneNode(true)
      clone.querySelectorAll('input,select,textarea,option,button').forEach((n) => n.remove())
      const t = (clone.innerText || '').trim()
      if (t && t.length < 200) return t
    }
    return ''
  }

  const nativeSet = (el, value) => {
    const proto =
      el.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    const d = Object.getOwnPropertyDescriptor(proto, 'value')
    if (d && d.set) d.set.call(el, value)
    else el.value = value
  }

  const realClick = (el) => {
    const o = { bubbles: true, cancelable: true, view: window }
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', o))
    } catch (e) {
      el.dispatchEvent(new MouseEvent('pointerdown', o))
    }
    el.dispatchEvent(new MouseEvent('mousedown', o))
    el.dispatchEvent(new MouseEvent('mouseup', o))
    el.dispatchEvent(new MouseEvent('click', o))
  }

  const highlight = (el) => {
    el.style.outline = '2px solid #22c55e'
    el.style.outlineOffset = '1px'
  }

  const matchOption = (text, value) => {
    const nt = norm(text)
    const nv = norm(value)
    if (!nt) return false
    return nt === nv || (nv.length > 1 && nt.includes(nv)) || (nt.length > 1 && nv.includes(nt))
  }

  let filled = 0
  const record = (label, best) =>
    filledFields.push({
      label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      value: best.value,
      important: best.important,
    })

  // 1) Native inputs / textareas / <select>
  const natives = [...document.querySelectorAll('input, select, textarea')].filter((el) => {
    if (el.disabled || el.readOnly) return false
    const type = (el.type || '').toLowerCase()
    if (['hidden', 'submit', 'button', 'file', 'password', 'image', 'reset', 'radio', 'checkbox'].includes(type)) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 || r.height > 0
  })
  for (const el of natives) {
    if (el.tagName !== 'SELECT' && el.value) continue
    const best = bestEntry(norm(labelText(el)))
    if (!best) continue
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => matchOption(o.text, best.value))
      // Fill even if a default (e.g. "US") is preselected, but not if it's already correct.
      if (!opt || opt.selected) continue
      nativeSet(el, opt.value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
      filled++
      highlight(el)
      record(labelText(el), best)
    } else {
      nativeSet(el, String(best.value))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      filled++
      highlight(el)
      record(labelText(el), best)
    }
  }

  // 2) Native radio-button groups (Yes/No etc.)
  const radios = [...document.querySelectorAll('input[type="radio"]')].filter((r) => {
    const rect = r.getBoundingClientRect()
    return !r.disabled && (rect.width > 0 || rect.height > 0 || r.closest('label'))
  })
  const groups = {}
  for (const r of radios) {
    const key = r.name || (r.closest('[data-automation-id^="formField"], fieldset, [role="radiogroup"]') || {}).outerHTML || 'g'
    ;(groups[key] = groups[key] || []).push(r)
  }
  // The GROUP's question (not the "Yes"/"No" option label).
  const optionLike = /^(yes|no|prefer not|n\/?a|male|female|other|decline)/i
  const groupLabel = (r) => {
    const fs = r.closest('fieldset')
    if (fs) { const lg = fs.querySelector('legend'); if (lg && lg.innerText.trim()) return lg.innerText }
    const rg = r.closest('[role="radiogroup"]')
    if (rg && rg.getAttribute('aria-label')) return rg.getAttribute('aria-label')
    const cont = r.closest('[data-automation-id^="formField"], fieldset, [role="radiogroup"], .form-group, [class*="field"], [class*="question"]')
    if (cont) {
      for (const l of cont.querySelectorAll('label, legend')) {
        const t = l.innerText.trim()
        if (t && t.length > 4 && !optionLike.test(t)) return t
      }
    }
    let node = r
    for (let i = 0; i < 5 && node; i++) {
      node = node.parentElement
      if (!node) break
      let prev = node.previousElementSibling
      while (prev) {
        const t = (prev.innerText || '').trim()
        if (t && t.length > 4 && t.length < 200 && !optionLike.test(t)) return t
        prev = prev.previousElementSibling
      }
    }
    return labelText(r)
  }
  for (const key of Object.keys(groups)) {
    const group = groups[key]
    if (group.some((r) => r.checked)) continue
    const best = bestEntry(norm(groupLabel(group[0])))
    if (!best) continue
    for (const r of group) {
      const rl = norm(labelText(r))
      if (matchOption(rl, best.value)) {
        realClick(r)
        if (!r.checked) r.checked = true
        r.dispatchEvent(new Event('change', { bubbles: true }))
        filled++
        highlight(r.closest('label') || r)
        record(groupLabel(group[0]), best)
        break
      }
    }
  }

  // 3) Custom listbox dropdowns (Workday and similar React widgets)
  const triggers = [...document.querySelectorAll('button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"], [role="combobox"]')].filter((t) => {
    const rect = t.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  })
  for (const trigger of triggers) {
    const current = norm(trigger.innerText || trigger.value)
    if (current && !/select|choose|no selection/.test(current)) continue // already chosen
    const best = bestEntry(norm(labelText(trigger)))
    if (!best) continue

    realClick(trigger)
    let options = []
    for (let i = 0; i < 12; i++) {
      await sleep(120)
      options = [...document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], li[role="option"]')].filter(
        (o) => o.offsetParent !== null
      )
      if (options.length) break
    }
    const opt = options.find((o) => matchOption(o.innerText, best.value))
    if (opt) {
      realClick(opt)
      filled++
      highlight(trigger)
      await sleep(120)
      // Keyboard repair: the widget can show selected while validation fails.
      const after = norm(trigger.innerText || trigger.value)
      if (!after || /select|choose|no selection/.test(after)) {
        try {
          trigger.focus()
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        } catch (e) {}
      }
      record(labelText(trigger), best)
    } else {
      // Close the menu to avoid leaving it open over the next field.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      realClick(trigger)
      await sleep(80)
    }
  }

  // 4) Second pass for dependent <select>s (e.g. State/Province re-renders its
  // options once Country is set). Runs once, after a re-render delay.
  await sleep(500)
  for (const el of document.querySelectorAll('select')) {
    if (el.disabled) continue
    const best = bestEntry(norm(labelText(el)))
    if (!best) continue
    const opt = [...el.options].find((o) => matchOption(o.text, best.value))
    if (!opt || opt.selected) continue
    nativeSet(el, opt.value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
    filled++
    highlight(el)
    record(labelText(el), best)
  }

  return { filled, fields: filledFields }
}
