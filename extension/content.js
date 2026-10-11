// Runs in every frame of every page. Each frame reports whether it looks like a
// job-application form (ATS forms are often embedded in an iframe); the top frame
// owns the on-page panel and drives the apply flow through the service worker,
// which is the only part that can reach the backend and all frames.
;(() => {
  if (window.__jpContentLoaded) return
  window.__jpContentLoaded = true
  if (!(document.documentElement instanceof HTMLElement)) return

  const IS_TOP = window === window.top
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message })
          else resolve(resp || { ok: false, error: 'no response' })
        })
      } catch (e) {
        // Extension was reloaded/updated under this page.
        resolve({ ok: false, error: 'EasyApply extension was reloaded — refresh this page.' })
      }
    })
  }

  // sessionStorage throws in sandboxed frames; treat it as best-effort.
  const ss = {
    get(k) {
      try { return sessionStorage.getItem(k) } catch (e) { return null }
    },
    set(k, v) {
      try { sessionStorage.setItem(k, v) } catch (e) {}
    },
    del(k) {
      try { sessionStorage.removeItem(k) } catch (e) {}
    },
  }

  // -------------------------------------------------------------------------
  // Detection (every frame)
  // -------------------------------------------------------------------------

  const ATS_HOST =
    /(^|\.)(greenhouse\.io|lever\.co|myworkdayjobs\.com|myworkdaysite\.com|ashbyhq\.com|icims\.com|smartrecruiters\.com|jobvite\.com|bamboohr\.com|workable\.com|taleo\.net|successfactors\.com|oraclecloud\.com|breezy\.hr|recruitee\.com|teamtailor\.com|ultipro\.com|dayforcehcm\.com|paylocity\.com|rippling\.com)$/i
  // Workday shows no form until you click Apply and sign in, so its job pages
  // get the panel up front (with a hint) instead of waiting for fields.
  const WORKDAY_HOST = /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/i
  const isWorkdayJobPage = () =>
    WORKDAY_HOST.test(location.hostname) && /\/(job|details)\//.test(location.pathname)
  const URL_HINT = /apply|application|candidate|career|job|recruit|hiring/i
  const NAME_RE = /\b(first|last|full|given|family|legal|preferred) ?name\b|\bsurname\b|^name\b/
  const EMAIL_RE = /\be ?mail\b/
  const PHONE_RE = /\b(phone|mobile|telephone)\b/
  const RESUME_RE = /\b(resume|cv|curriculum)\b/

  const norm = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()

  const hintOf = (el) =>
    norm(
      [
        (el.labels && el.labels[0] && el.labels[0].innerText) || '',
        el.getAttribute('aria-label') || '',
        el.placeholder || '',
        el.name || '',
        el.id || '',
        el.getAttribute('autocomplete') || '',
        el.getAttribute('data-automation-id') || '',
      ].join(' ')
    )

  const hash = (s) => {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return String(h)
  }

  // What this frame's form looks like right now. `sig` identifies the set of
  // fields (not their values), so a new step of a multi-step form changes it.
  function frameState() {
    const controls = [
      ...document.querySelectorAll('input, select, textarea, button[aria-haspopup="listbox"]'),
    ].slice(0, 200)
    const cats = new Set()
    const labels = new Set()
    const radioGroups = {}
    let hasResume = false
    let hasPassword = false
    let fields = 0
    let empty = 0

    for (const el of controls) {
      if (el.tagName === 'BUTTON') {
        // Workday-style custom dropdown; whole steps consist of nothing else.
        const r = el.getBoundingClientRect()
        if (el.disabled || (r.width === 0 && r.height === 0)) continue
        const group = el.closest('[data-automation-id^="formField"], fieldset')
        const lab = group && group.querySelector('label, legend')
        fields++
        labels.add(norm((lab && lab.innerText) || el.getAttribute('aria-label') || el.id))
        if (/^(select|choose)/i.test((el.innerText || '').trim())) empty++
        continue
      }
      const type = (el.type || '').toLowerCase()
      if (type === 'file') {
        // Upload inputs are usually hidden behind a styled drop zone.
        const around = el.closest('[class*="field"], [class*="upload"], [data-automation-id], label, fieldset')
        if (RESUME_RE.test(hintOf(el) + ' ' + norm(((around && around.innerText) || '').slice(0, 300)))) {
          hasResume = true
        }
        continue
      }
      if (el.disabled || el.readOnly) continue
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0 && !el.closest('label')) continue
      if (type === 'password') {
        hasPassword = true
        continue
      }
      if (type === 'checkbox') continue
      if (type === 'radio') {
        const key = el.name || 'radio'
        radioGroups[key] = radioGroups[key] || el.checked
        labels.add('radio ' + key)
        continue
      }

      const hint = hintOf(el)
      fields++
      labels.add(hint)
      if (el.tagName === 'SELECT' ? el.selectedIndex <= 0 : !el.value) empty++
      if (NAME_RE.test(hint)) cats.add('name')
      if (type === 'email' || EMAIL_RE.test(hint)) cats.add('email')
      if (type === 'tel' || PHONE_RE.test(hint)) cats.add('phone')
      if (hint.includes('linkedin')) cats.add('linkedin')
    }
    for (const checked of Object.values(radioGroups)) {
      fields++
      if (!checked) empty++
    }

    const ats = ATS_HOST.test(location.hostname)
    const urlHint = URL_HINT.test(location.href)
    // Once a form was recognised in this tab, later steps (which may hold only
    // screening questions) still count.
    const sticky = ss.get('jp:active') === '1'
    const applyFlow = /\/apply(\/|$)/.test(location.pathname)
    let detected = ats
      ? cats.size >= 2 || hasResume || (sticky && fields >= 2) || (applyFlow && fields >= 1)
      : (hasResume && cats.size >= 1) || (urlHint && (cats.size >= 3 || (sticky && fields >= 2)))
    // Sign-in / create-account pages are not the application itself; on an ATS
    // they are still a step of it (the panel can fill the account e-mail/password).
    if (hasPassword && !hasResume) detected = ats && cats.has('email')
    if (detected) ss.set('jp:active', '1')

    // Only while a Submit click is awaiting confirmation (reading the page text
    // every tick would be wasteful otherwise).
    // Boxes for an e-mailed verification code (often one per digit).
    const codeBoxes = controls.filter((el) => {
      const r = el.getBoundingClientRect()
      return (
        el.tagName === 'INPUT' &&
        (r.width > 0 || r.height > 0) &&
        /verification code|one time (code|pass)|\botp\b|passcode|security code|confirmation code/.test(hintOf(el))
      )
    }).length
    const submitted = watchSuccess && SUCCESS_RE.test((document.body.innerText || '').slice(0, 20000))
    return { detected, fields, empty, submitted, codeBoxes, sig: hash([...labels].sort().join('|')) }
  }

  // -------------------------------------------------------------------------
  // Submission tracking (every frame)
  // -------------------------------------------------------------------------

  // The site's own final button. Deliberately not "Apply": that usually just
  // opens or scrolls to the form.
  const SUBMIT_RE = /^(submit|send)( my| your| the)?( application| form)?$|^complete application$/i
  // What sites say once an application went through.
  const SUCCESS_RE =
    /thank(s| you) for (applying|your application|your submission|submitting)|application (has been |was |is )?(successfully )?(submitted|received|sent)|successfully (submitted|applied)|(we.ve|we have|have) received your application|your (application|response|submission) (has been|was) (successfully )?(submitted|received|recorded)/i
  let watchSuccess = false

  // The form's current values, labelled the way the applicant reads them.
  function formValues() {
    const out = []
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').replace(/\s*\*$/, '').trim().slice(0, 200)
    const question = (el) => {
      const box = el.closest(
        'fieldset, [role="radiogroup"], [role="group"], [class*="field-entry"], [class*="fieldEntry"], [data-automation-id^="formField"], .form-group'
      )
      const lab = box && box.querySelector('legend, label')
      return (lab && lab.innerText) || ''
    }
    const labelOf = (el) => {
      if (el.labels && el.labels[0] && el.labels[0].innerText.trim()) return el.labels[0].innerText
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
      const ids = el.getAttribute('aria-labelledby')
      const byId = ids && ids.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ').trim()
      return byId || question(el) || el.placeholder || el.name || ''
    }
    const add = (label, value) => {
      label = clean(label)
      value = String(value || '').trim().slice(0, 4000)
      if (label && value) out.push({ label, value })
    }
    for (const el of [...document.querySelectorAll('input, select, textarea')].slice(0, 400)) {
      const type = (el.type || '').toLowerCase()
      if (['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search'].includes(type)) continue
      if (/captcha/i.test(el.name + el.id) || el.closest('[aria-hidden="true"]')) continue
      if (type === 'file') {
        if (el.files && el.files.length) add(labelOf(el) || question(el) || 'File', el.files[0].name)
        continue
      }
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0 && !el.closest('label')) continue
      if (type === 'checkbox') {
        // Not the hidden state-holder of a Yes/No button pair (read below).
        if (el.checked && !(el.parentElement && el.parentElement.querySelector(':scope > button[aria-pressed]'))) {
          add(labelOf(el), 'checked')
        }
      } else if (type === 'radio') {
        if (el.checked) add(question(el) || el.name, labelOf(el))
      } else if (el.tagName === 'SELECT') {
        const opt = el.options[el.selectedIndex]
        if (opt && el.selectedIndex >= 0 && !/^(select|choose|--)/i.test(opt.text.trim())) add(labelOf(el), opt.text)
      } else if (el.getAttribute('role') === 'combobox') {
        // react-select: the choice is rendered beside the (empty) search input.
        const ctl = el.closest('[class*="control"]')
        const shown = ctl && ctl.querySelector('[class*="single-value"], [class*="singleValue"]')
        add(labelOf(el), (shown && shown.innerText) || el.value)
      } else {
        add(labelOf(el), el.value)
      }
    }
    for (const btn of document.querySelectorAll('button[aria-pressed="true"]')) add(question(btn), btn.innerText)
    for (const btn of document.querySelectorAll('button[aria-haspopup="listbox"], div[role="combobox"]')) {
      const text = (btn.innerText || '').trim()
      if (text && !/^(select|choose)/i.test(text)) add(labelOf(btn), text)
    }
    return out.slice(0, 200)
  }

  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button, input[type="submit"], [role="button"]')
      if (!btn) return
      const text = (btn.innerText || btn.value || btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
      if (!SUBMIT_RE.test(text)) return
      const fields = formValues()
      if (IS_TOP) onSubmitClick(fields)
      else send({ type: 'jp-submit-click', fields })
    },
    true
  )

  let lastReported = ''
  function report(force) {
    // LinkedIn swaps the job on screen without touching any form, so screen on
    // every tick rather than only when the fields change.
    if (IS_TOP) {
      screenLinkedInJob()
      checkSubmitted()
    }
    const state = frameState()
    const key = JSON.stringify(state)
    if (!force && key === lastReported) return
    lastReported = key
    if (IS_TOP) onFrameState(0, state)
    else send({ type: 'jp-frame-state', state })
  }

  // SPAs render the form late and swap steps in place, so keep watching.
  // Throttled (not debounced) so a constantly-mutating page still gets checked.
  let reportTimer = null
  const scheduleReport = () => {
    if (reportTimer) return
    reportTimer = setTimeout(() => {
      reportTimer = null
      report(false)
    }, 1000)
  }
  new MutationObserver(scheduleReport).observe(document.documentElement, { childList: true, subtree: true })
  document.addEventListener('change', scheduleReport, true)

  // The fill functions the service worker injects run in this same isolated
  // world; they report each field here so the panel can list it live.
  window.__jpProgress = (item) => {
    if (IS_TOP) onProgress(item)
    else send({ type: 'jp-progress', item })
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return
    if (msg.type === 'jp-report') report(true)
    if (msg.type === 'jp-watch-success') watchSuccess = true
    if (!IS_TOP) return
    if (msg.type === 'jp-submit-click') onSubmitClick(msg.fields)
    if (msg.type === 'jp-progress') onProgress(msg.item)
    if (msg.type === 'jp-frame-state') onFrameState(msg.frameId, msg.state)
    if (msg.type === 'jp-status') setStatus(msg.text)
    if (msg.type === 'jp-open-panel') {
      openPanel(true)
      sendResponse({ ok: true })
    }
  })

  if (!IS_TOP) {
    report(true)
    return
  }

  // -------------------------------------------------------------------------
  // Panel (top frame only)
  // -------------------------------------------------------------------------

  const CSS_TEXT = `
    :host { all: initial; }
    .card {
      width: 300px; box-sizing: border-box; background: #fff; color: #111827;
      border: 1px solid #d1d5db; border-radius: 12px; overflow: hidden;
      box-shadow: 0 8px 30px rgba(0,0,0,.25);
      font: 13px/1.4 -apple-system, system-ui, sans-serif;
    }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; background: #2563eb; color: #fff; cursor: move; user-select: none;
    }
    .head b { font-size: 13px; }
    .head button {
      width: auto; margin: 0 0 0 4px; padding: 0 4px; background: none; border: 0;
      color: #fff; font-size: 16px; line-height: 1; cursor: pointer;
    }
    .body { padding: 10px; }
    .min .body { display: none; }
    select {
      width: 100%; box-sizing: border-box; padding: 7px; border: 1px solid #d1d5db;
      border-radius: 8px; font-size: 12px; background: #fff; color: #111827;
    }
    button {
      width: 100%; box-sizing: border-box; margin-top: 8px; padding: 9px; border: 0;
      border-radius: 8px; background: #2563eb; color: #fff; font: inherit;
      font-weight: 600; cursor: pointer;
    }
    button:disabled { opacity: .6; cursor: default; }
    .row { display: flex; gap: 6px; }
    .row button { background: transparent; color: #2563eb; border: 1px solid currentColor; font-weight: 500; padding: 7px; }
    button.text { margin-top: 6px; padding: 4px; background: none; color: #2563eb; font-weight: 500; font-size: 12px; }
    .status a { color: #2563eb; }
    label { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 11px; color: #6b7280; cursor: pointer; }
    label input { margin: 0; }
    .status { margin-top: 10px; font-size: 12px; min-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 22vh; overflow: auto; }
    .ok { color: #16a34a; } .warn { color: #d97706; } .err { color: #dc2626; }
    .sum { margin-top: 10px; font-size: 11px; font-weight: 600; color: #6b7280; }
    .sum:empty { display: none; }
    .list { position: relative; margin-top: 4px; max-height: 34vh; overflow: auto; }
    .item { display: flex; align-items: flex-start; gap: 6px; padding: 6px 4px; border-top: 1px solid #e5e7eb; }
    .item.filling { background: #eff6ff; }
    .ico { flex: none; width: 14px; text-align: center; font-weight: 700; color: #9ca3af; }
    .done .ico { color: #16a34a; } .failed .ico { color: #dc2626; } .skipped .ico { color: #d97706; }
    .spin {
      display: inline-block; width: 9px; height: 9px; border: 2px solid #93c5fd;
      border-top-color: #2563eb; border-radius: 50%; animation: jp-spin .8s linear infinite;
    }
    @keyframes jp-spin { to { transform: rotate(360deg); } }
    .txt { flex: 1; min-width: 0; }
    .q {
      font-size: 11px; color: #6b7280; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .v { font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .failed .v, .skipped .v { font-weight: 400; color: #b45309; }
    .tag { flex: none; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 700; }
    .tag.rule { background: #dcfce7; color: #166534; }
    .tag.ai { background: #dbeafe; color: #1e40af; }
    .tag.saved { background: #ccfbf1; color: #115e59; }
    .tag.file { background: #e5e7eb; color: #374151; }
    @media (prefers-color-scheme: dark) {
      .card { background: #111827; color: #f9fafb; border-color: #374151; }
      select { background: #1f2937; color: #f9fafb; border-color: #374151; }
      .row button, button.text, .status a { color: #60a5fa; }
      label { color: #9ca3af; }
      .sum, .q { color: #9ca3af; }
      .item { border-color: #374151; }
      .item.filling { background: #1e3a5f; }
      .failed .v, .skipped .v { color: #fbbf24; }
    }
  `

  const states = new Map() // frameId -> latest frameState()
  const seenSteps = new Set() // step keys already filled (auto-fill runs once per step)
  let ui = null
  let closed = ss.get('jp:closed') === location.pathname // user dismissed it on this page
  let busy = false
  let armed = false // user ran Apply here; following steps may auto-fill
  let armedPath = ''
  let waitingForForm = false // panel is showing the "no form yet" hint
  // Which application a URL belongs to: Workday keeps /job/<id>/apply/... across
  // its steps, so everything from "/apply" on is ignored.
  const appKey = () => location.pathname.split('/apply')[0]
  const DETECTED_MSG = 'Application form detected. Pick a resume, then Apply. Nothing is submitted for you.'
  let resumeDone = false

  const el = (tag, props, children) => {
    const node = Object.assign(document.createElement(tag), props || {})
    for (const c of children || []) node.append(c)
    return node
  }

  function buildPanel() {
    const host = el('div', { id: 'jp-panel-host' })
    host.style.cssText = 'all:initial;position:fixed;top:16px;left:16px;z-index:2147483647'
    const root = host.attachShadow({ mode: 'open' })
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(CSS_TEXT)
    root.adoptedStyleSheets = [sheet]

    const minBtn = el('button', { textContent: '–', title: 'Minimize' })
    const closeBtn = el('button', { textContent: '×', title: 'Close (reopen from the extension icon)' })
    const head = el('div', { className: 'head' }, [
      el('b', { textContent: '⚡ EasyApply Autofill', title: 'Click to minimize / expand, drag to move' }),
      el('span', null, [minBtn, closeBtn]),
    ])
    const jobSel = el('select', { title: 'Which tailored resume to attach' }, [
      el('option', { value: '', textContent: 'Resume: none (fill fields only)' }),
      // Default; loadJobs() switches to a tailored one when the page names its company.
      el('option', { value: 'base', textContent: 'Resume: base résumé (not tailored)', selected: true }),
    ])
    const applyBtn = el('button', { textContent: '⚡ Apply — fill everything' })
    const fillBtn = el('button', { textContent: 'Fill fields' })
    const aiBtn = el('button', { textContent: 'AI answers' })
    const codeBtn = el('button', { className: 'text', textContent: '📧 Get verification code from email' })
    const recordBtn = el('button', {
      className: 'text',
      textContent: '✓ I submitted this application — record it',
      title: 'Normally recorded automatically when the site confirms your submission',
    })
    const autoBox = el('input', { type: 'checkbox', checked: true })
    const status = el('div', { className: 'status' })
    const sum = el('div', { className: 'sum' })
    const list = el('div', { className: 'list' })
    const card = el('div', { className: 'card' }, [
      head,
      el('div', { className: 'body' }, [
        jobSel,
        applyBtn,
        el('div', { className: 'row' }, [fillBtn, aiBtn]),
        codeBtn,
        recordBtn,
        el('label', null, [autoBox, 'Auto-fill the next steps after Apply']),
        status,
        sum,
        list,
      ]),
    ])
    root.append(card)
    document.documentElement.append(host)

    // Draggable by the header.
    let drag = null
    head.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return
      const r = host.getBoundingClientRect()
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, moved: false }
      e.preventDefault()
    })
    window.addEventListener('mousemove', (e) => {
      if (!drag) return
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 4) return // still a click
      drag.moved = true
      host.style.left = Math.max(0, e.clientX - drag.dx) + 'px'
      host.style.top = Math.max(0, e.clientY - drag.dy) + 'px'
      host.style.right = 'auto'
    })
    window.addEventListener('mouseup', () => {
      // A click on the header (no drag) minimizes / expands the panel.
      if (drag && !drag.moved) card.classList.toggle('min')
      drag = null
    })

    minBtn.addEventListener('click', () => card.classList.toggle('min'))
    closeBtn.addEventListener('click', () => {
      closed = true
      ss.set('jp:closed', location.pathname)
      host.style.display = 'none'
    })
    jobSel.addEventListener('change', () => (resumeDone = false))
    applyBtn.addEventListener('click', () => run('apply', false))
    fillBtn.addEventListener('click', () => run('fill', false))
    aiBtn.addEventListener('click', () => run('ai', false))
    codeBtn.addEventListener('click', getEmailCode)
    recordBtn.addEventListener('click', () =>
      recordApplication(pending ? pending.snapshot : buildSnapshot(formValues()), 'manual')
    )

    try {
      chrome.storage.local.get({ jpAutoSteps: true }, (v) => {
        if (!chrome.runtime.lastError) autoBox.checked = !!v.jpAutoSteps
      })
      autoBox.addEventListener('change', () => {
        try { chrome.storage.local.set({ jpAutoSteps: autoBox.checked }) } catch (e) {}
        maybeAutoStep()
      })
    } catch (e) {
      /* extension context gone */
    }

    return { host, card, jobSel, autoBox, status, sum, list, buttons: [applyBtn, fillBtn, aiBtn, codeBtn] }
  }

  // Live list of what this run touched: one row per field, tagged by where the
  // value came from (profile rule / AI / saved answer / file).
  const items = new Map() // id -> { id, label, value, source, state }
  const TAGS = { rule: 'Rule', ai: 'AI', saved: 'Saved', file: 'File' }
  const ICONS = { pending: '·', done: '✓', failed: '✕', skipped: '–' }

  function onProgress(item) {
    if (!ui || !item || !item.id) return
    items.set(item.id, { ...items.get(item.id), ...item })
    renderItems()
  }

  function renderItems() {
    const all = [...items.values()]
    const count = (f) => all.filter(f).length
    const filling = count((i) => i.state === 'filling' || i.state === 'pending')
    const missed = count((i) => i.state === 'failed' || i.state === 'skipped')
    ui.sum.textContent = all.length
      ? [
          `${count((i) => i.state === 'done' && i.source === 'rule')} by rule`,
          `${count((i) => i.state === 'done' && i.source !== 'rule' && i.source !== 'file')} by AI`,
          filling ? `${filling} in progress…` : '',
          missed ? `${missed} not filled` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
    let active = null
    ui.list.replaceChildren(
      ...all.map((i) => {
        const row = el('div', { className: 'item ' + i.state }, [
          el('div', { className: 'ico' }, [
            i.state === 'filling' ? el('span', { className: 'spin' }) : ICONS[i.state] || '',
          ]),
          el('div', { className: 'txt' }, [
            el('div', { className: 'q', textContent: i.label, title: i.label }),
            el('div', {
              className: 'v',
              textContent:
                i.state === 'filling' ? (i.source === 'ai' ? 'asking AI…' : `filling “${i.value}”…`)
                : i.state === 'pending' ? 'waiting…'
                : i.value || '',
            }),
          ]),
          el('span', { className: 'tag ' + i.source, textContent: TAGS[i.source] || i.source }),
        ])
        if (i.state === 'filling') active = row
        return row
      })
    )
    // Keep the field being filled in view.
    if (active) ui.list.scrollTop = active.offsetTop - ui.list.clientHeight / 2
  }

  function setStatus(text, cls) {
    if (!ui) return
    ui.status.textContent = text
    ui.status.className = 'status ' + (cls || '')
  }

  // Fill the resume picker from jobs that already have tailored materials,
  // auto-selecting the one whose company appears on this page.
  async function loadJobs() {
    const r = await send({ type: 'jp-jobs' })
    if (!r.ok) {
      setStatus("Can't reach the EasyApply backend — is it running? (" + r.error + ')', 'warn')
      return
    }
    const pageText = (document.title + ' ' + ((document.body && document.body.innerText) || ''))
      .slice(0, 4000)
      .toLowerCase()
    for (const j of r.jobs) {
      const opt = el('option', {
        value: String(j.id),
        textContent: `Resume: ${j.company} — ${j.title}`.slice(0, 58),
      })
      if (j.company && pageText.includes(String(j.company).toLowerCase())) opt.selected = true
      ui.jobSel.append(opt)
    }
  }

  function openPanel(forced) {
    if (forced) {
      closed = false
      ss.del('jp:closed')
    }
    if (closed) return
    if (!ui) {
      ui = buildPanel()
      waitingForForm = ![...states.values()].some((s) => s.detected)
      setStatus(
        waitingForForm
          ? 'No form on this page yet. Click the site\'s Apply (on Workday: "Apply Manually", then sign in). ' +
              'When the form appears, click ⚡ Apply here.'
          : DETECTED_MSG
      )
      loadJobs()
      screenApplicationPage()
    }
    ui.host.style.display = ''
    if (forced) ui.card.classList.remove('min')
  }

  // Identifies the current step across all frames that hold a form.
  const stepKey = () =>
    [...states.entries()]
      .filter(([, s]) => s.detected)
      .map(([id, s]) => id + ':' + s.sig)
      .sort()
      .join('|')

  // -------------------------------------------------------------------------
  // Recording submitted applications
  // -------------------------------------------------------------------------

  let pending = null // { snapshot, at } — Submit was clicked, awaiting the site's confirmation

  // Employer and role, as well as the page gives them away.
  function guessJob() {
    const host = location.hostname
    const seg = location.pathname.split('/').filter(Boolean)
    const meta = (name) => (document.querySelector(`meta[property="${name}"], meta[name="${name}"]`) || {}).content || ''
    let company = ''
    if (/(greenhouse\.io|lever\.co|ashbyhq\.com)$/.test(host)) company = seg[0] || ''
    else if (/(myworkdayjobs\.com|applytojob\.com|bamboohr\.com|recruitee\.com|teamtailor\.com)$/.test(host)) company = host.split('.')[0]
    company = company.replace(/[-_]+/g, ' ').trim() || meta('og:site_name')
    if (!company) {
      // "Job Application for Data Engineer at Acme", "Data Engineer @ Acme | Careers"
      const m = document.title.match(/(?:\bat|@)\s+([^|–—-]+?)\s*(?:[|–—-]|$)/)
      if (m) company = m[1].trim()
    }
    const h1 = (document.querySelector('h1') || {}).innerText || ''
    const title = (h1.trim().length > 2 && h1.trim().length < 120 ? h1 : meta('og:title') || document.title).trim()
    return { company, title }
  }

  function buildSnapshot(fields) {
    const key = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40)
    // Tag each submitted value with how it got there, where the panel filled it.
    const sources = new Map([...items.values()].filter((i) => i.state === 'done').map((i) => [key(i.label), i.source]))
    const answers = (fields || []).map((f) => ({ ...f, source: sources.get(key(f.label)) || '' }))
    const resumeRow = items.get('resume')
    const picked = ui && ui.jobSel.selectedOptions[0]
    const jobId = picked && /^\d+$/.test(picked.value) ? picked.value : null
    let job = guessJob()
    if (jobId) {
      // "Resume: Company — Title" of the saved job whose tailored résumé was used.
      const m = picked.textContent.replace(/^Resume:\s*/, '').split(' — ')
      job = { company: m[0] || job.company, title: m.slice(1).join(' — ') || job.title }
    }
    return {
      url: location.href,
      page_title: document.title,
      company: job.company,
      title: job.title,
      job_id: jobId,
      resume:
        resumeRow && resumeRow.state === 'done'
          ? String(resumeRow.value).replace(/\s*\(.*\)$/, '')
          : ((fields || []).find((f) => /resume|\bcv\b/i.test(f.label) && /\.\w{2,4}$/.test(f.value)) || {}).value || '',
      answers,
    }
  }

  const pageConfirms = () => SUCCESS_RE.test((document.body.innerText || '').slice(0, 20000))

  function onSubmitClick(fields) {
    // Only for forms this extension recognised or was opened on.
    if (!ui && ![...states.values()].some((s) => s.detected)) return
    // If the page already carried "thank you for applying"-like text, that text
    // can't serve as the confirmation.
    pending = { snapshot: buildSnapshot(fields), at: Date.now(), baseline: pageConfirms() }
    watchSuccess = true
    send({ type: 'jp-pending-set', snapshot: pending.snapshot })
    setTimeout(checkSubmitted, 1500)
  }

  // Record once the site confirms. A Submit that only produced validation
  // errors never shows a confirmation, so nothing is recorded for it.
  async function checkSubmitted() {
    if (!pending) return
    if (Date.now() - pending.at > 3 * 60 * 1000) {
      pending = null
      send({ type: 'jp-pending-clear' })
      return
    }
    const confirmed =
      (!pending.baseline && pageConfirms()) ||
      [...states.values()].some((s) => s.submitted) ||
      /[/?&=](thanks?|thank-you|success|confirmation|submitted)\b/i.test(location.pathname + location.search)
    if (confirmed) recordApplication(pending.snapshot, 'page')
  }

  let lastRecorded = '' // what this page already recorded, so the manual button can't duplicate it
  async function recordApplication(snapshot, confirmation) {
    if (confirmation === 'manual') {
      const prev = lastRecorded || (await send({ type: 'jp-recorded-get' })).what
      if (prev) {
        setStatus(`Already recorded: ${prev}`, 'ok')
        return
      }
    }
    pending = null
    const what = [snapshot.company, snapshot.title].filter(Boolean).join(' — ') || snapshot.page_title
    const r = await send({ type: 'jp-record', application: { ...snapshot, confirmation }, what })
    openPanel(true)
    if (r.ok) lastRecorded = what
    if (r.ok) setStatus(`✓ Application recorded in EasyApply: ${what}`, 'ok')
    else setStatus(`Submitted, but couldn't record it in EasyApply: ${r.error}`, 'err')
  }

  // -------------------------------------------------------------------------
  // Company screening
  // -------------------------------------------------------------------------

  const IS_LINKEDIN = /(^|\.)linkedin\.com$/i.test(location.hostname)

  // Company + industry of the LinkedIn job on screen, read from the page the
  // user is already looking at (text patterns, since LinkedIn's markup shifts).
  function linkedInJob() {
    if (!IS_LINKEDIN || !/\/jobs\//.test(location.pathname)) return null
    const text = (document.querySelector('main') || document.body).innerText || ''
    // "About the company": "<industry> · 10,001+ employees · …"; signed-out page: "Industries\n<industry>"
    const m =
      text.match(/^[ \t]*([^\n·•]{3,80}?)[ \t]*[·•][ \t]*[\d,]+(?:\+|-[\d,]+)?[ \t]+employees/m) ||
      text.match(/^[ \t]*Industries[ \t]*\n+[ \t]*([^\n]{3,80})$/m)
    const link = document.querySelector(
      '.job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a, .topcard__org-name-link'
    )
    let company = link ? link.innerText.trim() : ''
    if (!company) {
      const title = document.title.replace(/^\(\d+\+?\)\s*/, '')
      const hiring = title.match(/^(.+?) hiring /) // signed out: "Acme hiring Engineer in Toronto | LinkedIn"
      const parts = title.split(' | ') // signed in: "Engineer | Acme | LinkedIn"
      company = hiring ? hiring[1] : parts.length >= 3 ? parts[parts.length - 2] : ''
    }
    const jobKey = new URLSearchParams(location.search).get('currentJobId') || location.pathname
    return { company: company.trim(), industry: m ? m[1].trim() : '', jobKey }
  }

  let screened = '' // last job screened, so each one is checked once
  let blockedMsg = '' // standing warning for the job / page on screen
  async function screenLinkedInJob() {
    const job = linkedInJob()
    if (!job || !job.company) return
    const key = `${job.jobKey}|${job.company}|${job.industry}`
    if (key === screened) return
    screened = key
    const r = await send({ type: 'jp-company-check', company: job.company, industry: job.industry })
    if (key !== screened) return // the user moved on to another job meanwhile
    const wasBlocked = !!blockedMsg
    blockedMsg = ''
    if (!r.ok || !r.blocked) {
      // Replace the previous job's warning rather than leave it standing.
      if (wasBlocked && r.ok) setStatus(`${job.company}${job.industry ? ' · ' + job.industry : ''} — not blacklisted.`, 'ok')
      return
    }
    blockedMsg =
      r.reason === 'industry'
        ? `⛔ Skip this job: ${job.company} is in "${r.match}", an industry you blacklisted.` +
          (r.added ? ` ${job.company} was added to your company blacklist.` : '')
        : `⛔ Skip this job: ${job.company} is on your company blacklist ("${r.match}").`
    openPanel(true)
    setStatus(blockedMsg, 'err')
  }

  // On an application page (off LinkedIn) the employer isn't labelled, so look
  // for a blacklisted name in the page title as a whole-word phrase.
  async function screenApplicationPage() {
    if (IS_LINKEDIN) return
    const r = await send({ type: 'jp-blacklist' })
    if (!r.ok) return
    const flat = (t) => ' ' + String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '
    const title = flat(document.title)
    const hit = (r.companies || []).find((c) => flat(c).trim() && title.includes(flat(c)))
    if (!hit) return
    blockedMsg = `⛔ ${hit} is on your company blacklist — you probably don't want to apply here.`
    setStatus(blockedMsg, 'err')
  }

  // A "confirm your identity" page: fetch the code from the mailbox by itself,
  // retrying while the e-mail is on its way. Verifying stays the user's click.
  let codePage = '' // the page already handled
  async function watchForCode(boxes) {
    if (codePage === location.href) return
    codePage = location.href
    openPanel(true)
    const status = await send({ type: 'jp-email-code', digits: boxes, minutes: 5 })
    if (!status.ok) {
      // Gmail not connected (or backend down): explain once instead of retrying.
      setStatus(
        `This page wants a verification code from your e-mail. EasyApply can't read the mailbox yet: ${status.error}\n` +
          'Connect Gmail once (README §8.6), or type the code in yourself.',
        'warn'
      )
      return
    }
    let r = status
    for (let i = 0; i < 24 && !(r.ok && r.found && r.filled); i++) {
      if (location.href !== codePage) return
      setStatus(`Waiting for the verification e-mail… (${i * 5}s)`)
      await sleep(5000)
      r = await send({ type: 'jp-email-code', digits: boxes, minutes: 5 })
    }
    if (r.ok && r.found && r.filled) {
      setStatus(`Code ${r.code} entered ✓ (from: ${r.subject}).\nCheck it, then click the site's Verify button.`, 'ok')
    } else {
      setStatus('No verification e-mail arrived in 2 minutes. Use "Send New Code" on the page, then the 📧 button here.', 'warn')
    }
  }

  function onFrameState(frameId, state) {
    states.set(frameId, state)
    if (state.codeBoxes) watchForCode(state.codeBoxes > 1 ? state.codeBoxes : 0)
    if (state.detected || isWorkdayJobPage()) openPanel(false)
    if (state.detected && waitingForForm && ui && !busy) {
      waitingForForm = false
      setStatus(DETECTED_MSG)
    }
    maybeAutoStep()
  }

  // After the user ran Apply once, fill each following step of the same
  // application as it appears. Only fills — moving on / submitting stays manual.
  function maybeAutoStep() {
    if (!armed || busy || !ui || !ui.autoBox.checked) return
    if (appKey() !== armedPath) {
      armed = false // navigated elsewhere (e.g. another job) — require a fresh click
      return
    }
    const key = stepKey()
    if (!key || seenSteps.has(key)) return
    if (![...states.values()].some((s) => s.detected && s.empty > 0)) return
    seenSteps.add(key)
    run('apply', true)
  }

  function resumeNote(r) {
    if (r.resume === 'ok') return ' Resume attached ✓.'
    if (r.resume === 'unverified') return ' Resume set but NOT verified — check the upload!'
    if (r.resume === 'missing') return ' (No file upload found — attach resume manually.)'
    if (r.resume === 'error') return ` (Resume attach failed: ${r.resumeError} — attach manually.)`
    return ''
  }

  function showResult(mode, auto, r) {
    if (!r.ok) return setStatus(`${mode === 'apply' ? 'Apply' : mode === 'fill' ? 'Fill' : 'AI-answer'} failed: ${r.error}`, 'err')
    if (mode === 'fill') {
      return r.filled > 0
        ? setStatus(`Filled ${r.filled} field(s). Review the green-outlined fields, then submit.`, 'ok')
        : setStatus('No matching fields found. Try "Scan page (debug)" from the extension icon.', 'warn')
    }
    if (mode === 'ai') {
      if (r.total === 0) return setStatus('No blank question fields found (try "Fill fields" first).', 'warn')
      const extra = r.total > r.answered ? ` (${r.total - r.answered} not answered — cap per run or quota)` : ''
      return r.answered
        ? setStatus(`AI-filled ${r.answered} field(s) in blue — review them before submitting.${extra}`, 'ok')
        : setStatus("Couldn't answer any (LLM quota/error?).", 'warn')
    }
    if (auto && r.filled === 0 && r.answered === 0 && r.resume !== 'ok') {
      return setStatus('New step: nothing here matched your profile. Fill it manually.', 'warn')
    }
    // Pre-submit summary of high-impact fields (work auth / sponsorship / comp / EEO).
    const important = r.fields.filter((f) => f.important)
    const summary = important.length
      ? '\n\n⚠ Review before Submit:\n' + important.map((f) => `• ${f.label}: ${f.value}`).join('\n')
      : ''
    // Captchas are the site checking for a human; they are left for the user.
    const captcha = document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha'
    )
      ? '\n\n⚠ This page has a captcha — tick it yourself before submitting.'
      : ''
    // On auto-filled steps a missing upload is expected, not worth a warning.
    const note = auto && r.resume === 'missing' ? '' : resumeNote(r)
    setStatus(
      `✓ ${auto ? 'New step: filled' : 'Filled'} ${r.filled} field(s), AI-answered ${r.answered}.${note}\n` +
        `Green = profile, blue = AI. Review, then click the site's own button.${summary}${captcha}`,
      'ok'
    )
  }

  // Sign-up verification: read the newest e-mail from the connected Gmail mailbox.
  async function getEmailCode() {
    if (busy || !ui) return
    busy = true
    for (const b of ui.buttons) b.disabled = true
    setStatus('Checking your mailbox…')
    const boxes = Math.max(0, ...[...states.values()].map((s) => s.codeBoxes || 0))
    const r = await send({ type: 'jp-email-code', digits: boxes > 1 ? boxes : 0 })
    if (!r.ok) {
      setStatus(`Couldn't read the mailbox: ${r.error}`, 'err')
    } else if (!r.found) {
      setStatus('No new e-mail in the last 15 minutes yet. Wait a few seconds and try again.', 'warn')
    } else {
      const code = r.code
        ? `Code: ${r.code}${r.filled ? ' — entered on the page ✓' : ' — no code box found here, type it in yourself'}`
        : 'No code in this e-mail.'
      setStatus(`From: ${r.from}\nSubject: ${r.subject}\n${code}\nCheck this is the right e-mail before using it.`, r.code ? 'ok' : 'warn')
      if (r.link && /^https?:\/\//i.test(r.link)) {
        ui.status.append(
          '\n',
          el('a', { href: r.link, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open the first link in this e-mail' })
        )
      }
    }
    busy = false
    for (const b of ui.buttons) b.disabled = false
  }

  async function run(mode, auto) {
    if (busy || !ui) return
    busy = true
    for (const b of ui.buttons) b.disabled = true
    if (mode === 'apply' && !auto) {
      armed = true
      armedPath = appKey()
      seenSteps.add(stepKey())
    }
    if (mode !== 'ai') {
      // "AI answers" on its own adds to what "Fill fields" just listed.
      items.clear()
      renderItems()
    }
    setStatus(auto ? 'New step detected — filling…' : 'Working…')
    // Messages keep the service worker alive through a long fill.
    const ping = setInterval(() => send({ type: 'jp-ping' }), 10000)
    const r = await send({
      type: 'jp-run',
      mode,
      jobId: ui.jobSel.value,
      // Attach once: a lone upload on a later step is likely not the resume.
      attach: !resumeDone,
      auto,
    })
    clearInterval(ping)
    if (r.ok && r.resume === 'ok') resumeDone = true
    showResult(mode, auto, r)

    // Filling can reveal dependent fields; let the frames re-report, then count
    // the result as the same step so it doesn't trigger another auto-fill.
    await sleep(1500)
    seenSteps.add(stepKey())
    busy = false
    for (const b of ui.buttons) b.disabled = false
    maybeAutoStep()
  }

  report(true)
  // Frames may have loaded (and reported) before this listener existed.
  send({ type: 'jp-broadcast-report' })
  // A Submit clicked on the previous page of this tab may be confirmed on this one.
  send({ type: 'jp-pending-get' }).then((r) => {
    if (!r.ok || !r.pending) return
    pending = { ...r.pending, baseline: false }
    watchSuccess = true
    checkSubmitted()
  })
})()
