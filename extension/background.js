// Service worker. Content scripts run under the page's origin, so they can't
// call localhost directly (CORS). Everything that talks to the backend, or has
// to reach every frame of the tab, is orchestrated here on their behalf.
importScripts('page_fns.js')

const BACKEND = 'http://localhost:8010'
const MAX_AI_FIELDS = 10 // cap LLM calls per run (free-tier quota)
// Chrome kills the worker when a fetch takes >30s to respond; fail that one
// call instead. (A slow answer is still cached by the backend for the next run.)
const FETCH_TIMEOUT_MS = 25000

async function api(path, opts) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(`${BACKEND}${path}`, { ...opts, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

const postJson = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

async function getProfile() {
  const res = await api('/api/profile')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function doFill(tabId, profile) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
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
  if (!jobId || jobId === 'base') return // blockers are tracked per saved job
  try {
    await postJson(`/api/jobs/${jobId}/blocker`, { kind, detail })
  } catch (e) {
    /* best-effort */
  }
}

// Per-field progress row for the on-page panel.
const progress = (tabId, item) =>
  chrome.tabs.sendMessage(tabId, { type: 'jp-progress', item }, { frameId: 0 }).catch(() => {})

async function doAiAnswer(tabId, say) {
  const injResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: collectBlanks,
  })
  const pending = []
  for (const r of injResults)
    for (const b of (r.result && r.result.blanks) || []) pending.push({ frameId: r.frameId, ...b })
  if (pending.length === 0) return { answered: 0, total: 0 }
  const batch = pending.slice(0, MAX_AI_FIELDS)
  say(`Answering ${batch.length} question(s) with AI…`)
  const row = (p, state, value, source) => ({
    id: `ai:${p.frameId}:${p.idx}`,
    label: String(p.label).replace(/\s+/g, ' ').trim().slice(0, 120),
    source: source || 'ai',
    state,
    value,
  })
  pending.forEach((p, i) =>
    progress(tabId, i < MAX_AI_FIELDS ? row(p, 'pending') : row(p, 'skipped', `over the ${MAX_AI_FIELDS}-per-run cap`))
  )
  let answered = 0
  // One question at a time, written into the page as soon as it's answered.
  for (const p of batch) {
    progress(tabId, row(p, 'filling'))
    let answer = ''
    let source = 'ai'
    let applied = false
    try {
      const res = await postJson('/api/answer', { question: p.label, options: p.options || undefined })
      const j = await res.json()
      if (res.ok && j.answer) {
        answer = j.answer
        if (j.source === 'bq') source = 'saved' // your own hand-written answer, not the LLM
      }
    } catch (e) {
      /* one field failed */
    }
    if (answer) {
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [p.frameId] },
          func: applyAnswers,
          args: [[{ idx: p.idx, answer }]],
        })
        applied = !!(r && r.result && r.result.filled)
      } catch (e) {
        /* frame gone */
      }
    }
    if (applied) answered++
    progress(
      tabId,
      applied
        ? row(p, 'done', answer, source)
        : row(p, 'failed', answer ? `couldn't enter "${answer}"` : 'no answer (LLM error/quota?)', source)
    )
  }
  return { answered, total: pending.length }
}

async function toBase64(res) {
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

// Supporting documents from the profile's `documents:` map ({form label: file
// name}): each goes into the upload field carrying that label, if the page has one.
async function doAttachDocuments(tabId, documents) {
  for (const [label, name] of Object.entries(documents || {})) {
    if (!name) continue
    const count = (results, key) => results.reduce((n, r) => n + ((r.result && r.result[key]) || 0), 0)
    const target = { tabId, allFrames: true }
    try {
      const probe = await chrome.scripting.executeScript({ target, func: attachDocumentFn, args: [label] })
      if (!count(probe, 'matches')) continue // no such field here (or already has a file)
      const row = (state, value) =>
        progress(tabId, { id: 'doc:' + label, label: `${label} upload`, source: 'file', state, value })
      row('filling', name)
      const res = await api(`/api/documents/${encodeURIComponent(name)}`)
      if (!res.ok) {
        row('failed', `${name} not found in data/supportive_documents`)
        continue
      }
      const mime = (res.headers.get('content-type') || 'application/pdf').split(';')[0]
      const done = await chrome.scripting.executeScript({
        target,
        func: attachDocumentFn,
        args: [label, await toBase64(res), name, mime],
      })
      if (count(done, 'attached')) row('done', name)
      else row('failed', `the page rejected ${name}`)
    } catch (e) {
      /* frame gone / backend down — the résumé result already reports that */
    }
  }
}

// The uploaded file's name is what the recruiter sees.
function resumeFilename(profile) {
  const P = (profile && profile.personal) || {}
  const parts = String(P.name || '').trim().split(/\s+/).filter(Boolean)
  const first = P['first name'] || parts[0] || ''
  const last = P['last name'] || (parts.length > 1 ? parts[parts.length - 1] : '')
  const who = [first, last].filter(Boolean).join('_').replace(/[^\p{L}\p{N}_-]+/gu, '')
  return who ? `${who}_Resume.pdf` : 'Resume.pdf'
}

// Fetch the resume PDF — the job's tailored one, or the untailored base résumé
// (jobId 'base') — and drop it into the page's file input(s).
async function doAttachResume(tabId, jobId, filename) {
  const res = await api(jobId === 'base' ? '/api/templates/resume' : `/api/jobs/${jobId}/resume`)
  if (!res.ok) throw new Error(`resume HTTP ${res.status}`)
  // The user's own PDF is served under its own name; keep it.
  const served = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') || '')
  if (jobId === 'base' && served && served[1] !== 'resume_original.pdf') filename = served[1]
  const b64 = await toBase64(res)
  const sum = (results, key) => results.reduce((n, r) => n + ((r.result && r.result[key]) || 0), 0)
  let results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: attachResumeFn,
    args: [b64, filename],
  })
  if (!sum(results, 'attached')) {
    // No file input in the page: the form opens one from its "Attach" button.
    const marked = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: findUploadTriggerFn,
    })
    const frameIds = marked.filter((r) => r.result && r.result.found).map((r) => r.frameId)
    if (frameIds.length) {
      results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameIds[0]] },
        world: 'MAIN', // must patch the page's own file-dialog call
        func: interceptUploadFn,
        args: [b64, filename, 'application/pdf'],
      })
    }
  }
  return { filename, attached: sum(results, 'attached'), verified: sum(results, 'verified') }
}

// One run of the panel's flow. mode: 'apply' (fill + AI + resume) | 'fill' | 'ai'.
// Never clicks anything that submits or advances the form.
async function runFlow(tabId, { mode, jobId, attach, auto }) {
  const say = (text) =>
    chrome.tabs.sendMessage(tabId, { type: 'jp-status', text }, { frameId: 0 }).catch(() => {})
  const out = { ok: true, filled: 0, fields: [], answered: 0, total: 0, resume: '' }

  let profile = null
  if (mode !== 'ai') {
    say('Loading profile…')
    try {
      profile = await getProfile()
    } catch (e) {
      return { ok: false, error: `Can't reach EasyApply at ${BACKEND}. Is it running? (${e.message})` }
    }
    say('Filling fields… (Workday dropdowns take a moment)')
    Object.assign(out, await doFill(tabId, profile))
  }
  if (mode !== 'fill') Object.assign(out, await doAiAnswer(tabId, say))

  if (mode === 'apply' && jobId && attach) {
    say('Fetching tailored resume…')
    const resumeRow = (state, value) =>
      progress(tabId, { id: 'resume', label: 'Resume / CV upload', source: 'file', state, value })
    resumeRow('filling')
    try {
      const { attached, verified, filename } = await doAttachResume(tabId, jobId, resumeFilename(profile))
      if (attached && verified) {
        out.resume = 'ok'
        resumeRow('done', filename + (jobId === 'base' ? ' (base, not tailored)' : ' (tailored)'))
      } else if (attached) {
        out.resume = 'unverified'
        resumeRow('failed', 'set but not verified — check the upload')
        logBlocker(jobId, 'upload', 'resume file set but could not be verified')
      } else {
        out.resume = 'missing'
        resumeRow('skipped', 'no upload field on this page')
        // Later steps of a multi-step form legitimately have no upload.
        if (!auto) logBlocker(jobId, 'missing_file', 'no file input found on the application page')
      }
    } catch (e) {
      out.resume = 'error'
      out.resumeError = e.message
      resumeRow('failed', e.message)
      logBlocker(jobId, 'upload', `resume attach failed: ${e.message}`)
    }
  }
  if (mode === 'apply' && profile) await doAttachDocuments(tabId, profile.documents)
  if (mode === 'apply' && !auto && out.filled === 0 && out.answered === 0) {
    logBlocker(jobId, 'other', 'nothing filled — form may be a custom/complex ATS')
  }
  return out
}

const HANDLERS = {
  // Jobs that already have tailored materials, for the panel's resume picker.
  'jp-jobs': async () => {
    const res = await api('/api/jobs?status=materials_ready&page_size=50')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const jobs = ((data && data.items) || []).map((j) => ({ id: j.id, company: j.company, title: j.title }))
    return { ok: true, jobs }
  },

  'jp-run': (msg, sender) => runFlow(sender.tab.id, msg),

  // A sub-frame reporting what it sees; relay to the panel in the top frame.
  'jp-frame-state': async (msg, sender) => {
    await chrome.tabs
      .sendMessage(
        sender.tab.id,
        { type: 'jp-frame-state', frameId: sender.frameId, state: msg.state },
        { frameId: 0 }
      )
      .catch(() => {})
    return { ok: true }
  },

  // A fill function running in a sub-frame reporting a field; relay to the panel.
  'jp-progress': async (msg, sender) => {
    await progress(sender.tab.id, msg.item)
    return { ok: true }
  },

  // The panel asking every frame to (re)send its state.
  'jp-broadcast-report': async (_msg, sender) => {
    await chrome.tabs.sendMessage(sender.tab.id, { type: 'jp-report' }).catch(() => {})
    return { ok: true }
  },

  // --- Recording submitted applications ---
  // The Submit click happened in a sub-frame; hand its form values to the panel.
  'jp-submit-click': async (msg, sender) => {
    await chrome.tabs
      .sendMessage(sender.tab.id, { type: 'jp-submit-click', fields: msg.fields }, { frameId: 0 })
      .catch(() => {})
    return { ok: true }
  },

  // Submit was clicked: keep the snapshot per tab (the confirmation is often a
  // new page) and have every frame watch for the site's confirmation text.
  'jp-pending-set': async (msg, sender) => {
    await chrome.storage.session.set({ [`pending:${sender.tab.id}`]: { snapshot: msg.snapshot, at: Date.now() } })
    await chrome.tabs.sendMessage(sender.tab.id, { type: 'jp-watch-success' }).catch(() => {})
    return { ok: true }
  },

  'jp-pending-get': async (_msg, sender) => {
    const key = `pending:${sender.tab.id}`
    const pending = (await chrome.storage.session.get(key))[key]
    if (!pending || Date.now() - pending.at > 3 * 60 * 1000) return { ok: true, pending: null }
    await chrome.tabs.sendMessage(sender.tab.id, { type: 'jp-watch-success' }).catch(() => {})
    return { ok: true, pending }
  },

  'jp-pending-clear': async (_msg, sender) => {
    await chrome.storage.session.remove(`pending:${sender.tab.id}`)
    return { ok: true }
  },

  'jp-record': async (msg, sender) => {
    const res = await postJson('/api/applications', msg.application)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    // Remembered per tab: the confirmation is often a new page, where the manual
    // "record it" button must not add a second row for the same application.
    await chrome.storage.session.set({ [`recorded:${sender.tab.id}`]: { what: msg.what, at: Date.now() } })
    await chrome.storage.session.remove(`pending:${sender.tab.id}`)
    return { ok: true, ...(await res.json()) }
  },

  'jp-recorded-get': async (_msg, sender) => {
    const key = `recorded:${sender.tab.id}`
    const rec = (await chrome.storage.session.get(key))[key]
    return { ok: true, what: rec && Date.now() - rec.at < 10 * 60 * 1000 ? rec.what : '' }
  },

  // Company screening: is this employer blacklisted, or in a blacklisted industry
  // (then the backend also adds it to the company blacklist)?
  'jp-company-check': async (msg) => {
    const res = await postJson('/api/blacklist/check', { company: msg.company, industry: msg.industry })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, ...(await res.json()) }
  },

  // Blacklisted company names, for recognising them on an application page.
  'jp-blacklist': async () => {
    const res = await api('/api/blacklist')
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, ...(await res.json()) }
  },

  // Latest verification e-mail from the connected (read-only) Gmail mailbox; a
  // code is typed into the page's code box when there is one.
  'jp-email-code': async (msg, sender) => {
    const digits = msg.digits >= 4 && msg.digits <= 8 ? `&digits=${msg.digits}` : ''
    const res = await api(`/api/gmail/verification?minutes=${msg.minutes || 15}${digits}`)
    const j = await res.json()
    if (!res.ok) return { ok: false, error: j.detail || `HTTP ${res.status}` }
    if (!j.found) return { ok: true, found: false }
    let filled = 0
    if (j.code) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, allFrames: true },
        func: fillCodeFn,
        args: [j.code],
      })
      filled = results.reduce((n, r) => n + ((r.result && r.result.filled) || 0), 0)
    }
    return { ok: true, found: true, code: j.code, link: j.link, subject: j.subject, from: j.from, filled }
  },

  // Sent by the panel during a run purely to keep this worker alive.
  'jp-ping': async () => ({ ok: true }),

  // The on-page FinalRoundAI overlay relays its audio clips through here.
  'fr-audio': async (msg) => {
    const r = await postJson('/api/finalround/audio', {
      audio_base64: msg.audio_base64,
      mime_type: msg.mime_type,
      session_id: msg.session_id || null,
    })
    return { ok: r.ok, ...(await r.json()) }
  },
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg && msg.type]
  if (!handler) return
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
  return true // async response
})
