// Functions injected into the application page via chrome.scripting.executeScript.
// Each one is serialized on its own, so it must be self-contained (no shared helpers).
// Loaded by the service worker (importScripts) and by the popup (scanPage).

async function collectBlanks() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

  // Honeypots: fields a real applicant never sees, or is told to leave empty.
  // Filling one gets the application flagged as a bot.
  const isTrap = (el, label) => {
    const text = `${label || ''} ${el.name || ''} ${el.id || ''} ${el.className || ''} ${el.getAttribute('data-automation-id') || ''}`.toLowerCase()
    if (/leave (this |the )?(field |box |input |question )?(blank|empty)|do not (fill|enter|complete)|don.?t fill|(be left|remain) (blank|empty)|honey ?pot|bot[-_ ]?field|beecatcher/.test(text)) return true
    if (el.closest('[aria-hidden="true"]')) return true
    const r = el.getBoundingClientRect()
    if (r.right <= 0 || r.bottom <= 0) return true // parked off-screen
    const cs = getComputedStyle(el)
    return cs.visibility === 'hidden' || cs.opacity === '0'
  }

  const blanks = []
  let idx = 0
  // Voluntary self-identification is the applicant's to answer: filled only from
  // an explicit profile entry (fillForm), never guessed by the LLM.
  const selfId = /\b(race|racial|ethnic|ethnicity|hispanic|latino|gender|lgbtq?|sexual orientation|transgender|disabilit(y|ies)|veteran|pronouns?)\b/i
  // Indexes restart every run; drop the previous run's markers so they can't collide.
  document.querySelectorAll('[data-jp-idx]').forEach((n) => n.removeAttribute('data-jp-idx'))
  const fields = [...document.querySelectorAll('input, select, textarea')]
  for (const el of fields) {
    if (el.disabled || el.readOnly) continue
    const type = (el.type || '').toLowerCase()
    if (['hidden', 'submit', 'button', 'file', 'password', 'image', 'reset', 'radio', 'checkbox'].includes(type)) continue
    if (el.getAttribute('role') === 'combobox') continue // a dropdown's search box, handled below
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const isSelect = el.tagName === 'SELECT'
    const empty = isSelect ? el.selectedIndex <= 0 : !el.value
    if (!empty) continue

    const label = labelText(el).trim()
    const nlabel = norm(label)
    if (nlabel.length < 3 || selfId.test(label) || isTrap(el, label)) continue
    // A verification code comes from the applicant's e-mail, not from the LLM.
    if (/verification code|one.?time (code|pass)|\botp\b|passcode|security code|confirmation code/i.test(label)) continue

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

  // Custom listbox dropdowns (Workday and similar): the options only exist while
  // the menu is open, so open each unanswered one, read its options, close it.
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
  const openOptions = () =>
    [...document.querySelectorAll('[role="option"], [data-automation-id="promptOption"]')].filter(
      (o) => o.offsetParent !== null
    )
  const triggers = [
    ...document.querySelectorAll(
      'button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"], [role="combobox"]'
    ),
  ].filter((t) => {
    const r = t.getBoundingClientRect()
    return !t.disabled && (r.width > 0 || r.height > 0)
  })
  for (const trigger of triggers) {
    // A react-select keeps its <input> empty and shows the choice beside it.
    const ctl = trigger.closest('[class*="control"]')
    const shown = ctl && ctl.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]')
    const current = norm((shown && shown.innerText) || trigger.innerText || trigger.value)
    if (current && !/^(select|choose|no selection)/.test(current)) continue // already chosen
    const label = labelText(trigger).trim()
    if (norm(label).length < 3 || selfId.test(label)) continue

    realClick(trigger)
    let opts = []
    for (let i = 0; i < 12; i++) {
      await sleep(120)
      opts = openOptions()
      if (opts.length) break
    }
    const options = opts
      .map((o) => (o.innerText || '').trim())
      .filter((t) => t && !/^(select|choose|no selection)/i.test(t))
    if (opts.length) {
      ;(document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
      )
      await sleep(100)
      if (openOptions().length && trigger.tagName !== 'INPUT') {
        realClick(trigger)
        await sleep(100)
      }
    }
    if (trigger.tagName === 'INPUT') trigger.blur()
    // Long lists (country, state, school…) are lookups, not questions for the LLM.
    if (options.length === 0 || options.length > 25) continue

    trigger.setAttribute('data-jp-idx', String(idx))
    blanks.push({ idx, label, options, tag: 'listbox' })
    idx++
  }

  // Unanswered toggle-button choices (Ashby's Yes / No pair and similar).
  const seenGroups = new Set()
  for (const btn of document.querySelectorAll('button[aria-pressed]')) {
    const group = btn.parentElement
    if (!group || seenGroups.has(group)) continue
    seenGroups.add(group)
    const opts = [...group.querySelectorAll(':scope > button[aria-pressed]')].filter((o) => !o.disabled)
    if (opts.length < 2 || opts.some((o) => o.getAttribute('aria-pressed') === 'true')) continue
    const entry = group.closest(
      '[class*="field-entry"], [class*="fieldEntry"], [data-automation-id^="formField"], fieldset, [role="group"]'
    )
    const lab = entry && entry.querySelector('label, legend')
    const label = ((lab && lab.innerText.trim()) || group.getAttribute('aria-label') || labelText(group)).trim()
    const options = opts.map((o) => (o.innerText || '').trim()).filter(Boolean)
    if (norm(label).length < 3 || options.length < 2 || selfId.test(label)) continue
    group.setAttribute('data-jp-idx', String(idx))
    blanks.push({ idx, label, options, tag: 'buttons' })
    idx++
  }
  return { blanks }
}

async function applyAnswers(items) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
    if (el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('role') === 'combobox') {
      // Custom dropdown: open it and click the option the answer names.
      const click = (node) => {
        const o = { bubbles: true, cancelable: true, view: window }
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
          node.dispatchEvent(new (type === 'pointerdown' ? PointerEvent : MouseEvent)(type, o))
        }
      }
      const na = norm(answer)
      click(el)
      let opt = null
      for (let i = 0; i < 12 && !opt; i++) {
        await sleep(120)
        const opts = [
          ...document.querySelectorAll('[role="option"], [data-automation-id="promptOption"]'),
        ].filter((o) => o.offsetParent !== null)
        opt =
          opts.find((o) => norm(o.innerText) === na) ||
          opts.find((o) => na && norm(o.innerText) && (norm(o.innerText).includes(na) || na.includes(norm(o.innerText))))
        if (opts.length && !opt) break
      }
      if (!opt) {
        // close the menu again
        if (el.tagName === 'INPUT') el.blur()
        else click(el)
        await sleep(80)
        continue
      }
      click(opt)
      await sleep(120)
      if (el.tagName === 'INPUT') {
        el.blur()
        const box = el.closest('[class*="control"]')
        if (box) {
          box.style.outline = '2px solid #3b82f6'
          box.style.outlineOffset = '1px'
        }
      }
    } else if (el.querySelector(':scope > button[aria-pressed]')) {
      // Toggle-button group: press the button the answer names.
      const na = norm(answer)
      const opts = [...el.querySelectorAll(':scope > button[aria-pressed]')]
      const opt = opts.find((o) => norm(o.innerText) === na) || opts.find((o) => na && na.startsWith(norm(o.innerText) + ' '))
      if (!opt) continue
      opt.focus()
      opt.click()
      let pressed = false
      for (let i = 0; i < 12 && !pressed; i++) {
        await sleep(50)
        pressed = opt.getAttribute('aria-pressed') === 'true'
      }
      if (!pressed) continue
      opt.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      opt.blur()
      opt.style.outline = '2px solid #3b82f6'
      opt.style.outlineOffset = '1px'
      filled++
      continue
    } else if (el.tagName === 'SELECT') {
      const na = norm(answer)
      const opt = [...el.options].find(
        (o) => norm(o.text) === na || (na && (norm(o.text).includes(na) || na.includes(norm(o.text))))
      )
      if (!opt) continue
      nativeSet(el, opt.value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      nativeSet(el, String(answer))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      el.dispatchEvent(new FocusEvent('blur'))
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
    if (inputs.length > 1 && (!/resume|cv|résumé/.test(hint) || /autofill/.test(hint))) continue
    try {
      // Some forms (JazzHR) keep the upload collapsed behind an "Attach resume"
      // link, so a file set on it would be sent but never shown. Expand it first.
      // Links only: a button or label here could open the native file dialog.
      if (!(input.offsetWidth || input.offsetHeight)) {
        let box = input.parentElement
        for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
          const link = [...box.querySelectorAll('a[href="#"], a[href^="javascript"], a:not([href])')].find(
            (a) => /\b(attach|upload)\b/i.test(a.innerText || '') && (a.offsetWidth || a.offsetHeight)
          )
          if (link) {
            link.click()
            break
          }
        }
      }
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

// Fallback for forms with no <input type=file> in the page: the "Attach File"
// button creates one on the fly (or keeps it somewhere unreachable) and clicks it.
// Step 1 (isolated world): find the résumé field's attach button and mark it.
function findUploadTriggerFn() {
  const norm = (s) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  document.querySelectorAll('[data-jp-upload]').forEach((n) => n.removeAttribute('data-jp-upload'))
  const buttons = [...document.querySelectorAll('button, [role="button"], a, label')].filter((b) => {
    const text = norm(b.innerText)
    return (
      text.length <= 60 &&
      /^(attach|upload|choose|browse|select|add)\b|\bdrop (your )?files?\b|\bclick to (browse|upload)\b|\bbrowse files\b/.test(text) &&
      (b.offsetWidth || b.offsetHeight)
    )
  })
  for (const btn of buttons) {
    // The nearest ancestor that adds text beyond the button's own is its field.
    const own = norm(btn.innerText).length
    let box = btn.parentElement
    for (let i = 0; i < 5 && box && norm(box.innerText).length <= own + 3; i++) box = box.parentElement
    const hint = norm((box && box.innerText) || '').slice(0, 200)
    if (!/\b(resume|cv|curriculum)\b/.test(hint) || /\bcover letter\b/.test(hint)) continue
    btn.setAttribute('data-jp-upload', '1')
    return { found: 1 }
  }
  return { found: 0 }
}

// Step 2 (page's own world): click the marked button with the file dialog
// intercepted — whichever file input the page tries to open gets our file
// instead, exactly as if the user had picked it.
async function interceptUploadFn(b64, filename, mime) {
  const btn = document.querySelector('[data-jp-upload="1"]')
  if (!btn) return { attached: 0 }
  btn.removeAttribute('data-jp-upload')
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  const file = new File([arr], filename, { type: mime || 'application/pdf' })

  const proto = HTMLInputElement.prototype
  const original = { click: proto.click, showPicker: proto.showPicker }
  let attached = 0
  const give = (input) => {
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    // Count before the events: uploaders such as Uppy take the file on "change"
    // and immediately clear the input again.
    if (input.files && input.files.length) attached++
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  proto.click = function () {
    if (this.type === 'file') return give(this)
    return original.click.apply(this, arguments)
  }
  if (original.showPicker) {
    proto.showPicker = function () {
      if (this.type === 'file') return give(this)
      return original.showPicker.apply(this, arguments)
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const before = new Set(document.querySelectorAll('input[type="file"]'))
  try {
    btn.click()
    for (let i = 0; i < 15 && !attached; i++) {
      await sleep(100)
      // Or the click opened an uploader (e.g. Uppy on Airtable forms) that
      // brings its own file input.
      const fresh = [...document.querySelectorAll('input[type="file"]')].filter(
        (el) => !before.has(el) && !el.webkitdirectory && !el.disabled
      )
      if (!attached && fresh.length) give(fresh[0])
    }
  } finally {
    proto.click = original.click
    if (original.showPicker) proto.showPicker = original.showPicker
  }
  if (!attached) return { attached: 0, verified: 0 }

  // An uploader dialog keeps the file staged until its own "Upload" is pressed.
  // That only hands the file to the form; it does not submit the application.
  const confirmBtn = () =>
    [...document.querySelectorAll('[role="dialog"] button, .uppy-Dashboard button')].find(
      (b) => /^upload( \d+ files?)?$/i.test((b.innerText || '').trim()) && (b.offsetWidth || b.offsetHeight)
    )
  let confirm = null
  for (let i = 0; i < 20 && !confirm; i++) {
    await sleep(100)
    confirm = confirmBtn()
  }
  if (!confirm) return { attached, verified: attached }
  const dialog = confirm.closest('[role="dialog"]') || confirm.closest('.uppy-Dashboard')
  confirm.click()
  // Done when the uploader has closed itself.
  for (let i = 0; i < 200; i++) {
    await sleep(100)
    if (!dialog || !document.contains(dialog) || !(dialog.offsetWidth || dialog.offsetHeight)) {
      return { attached, verified: attached }
    }
  }
  return { attached, verified: 0 } // staged, but the upload didn't visibly finish
}

// Attach a supporting document to the upload field(s) whose label contains
// `label` (e.g. "Additional Documents"). Never touches a field that already has
// a file. Called without `b64` it only counts the matching empty fields, so the
// caller can skip downloading a document no field on this page wants.
function attachDocumentFn(label, b64, filename, mime) {
  const norm = (s) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  const want = norm(label)
  const targets = [...document.querySelectorAll('input[type="file"]')].filter((input) => {
    if (input.disabled || (input.files && input.files.length)) return false
    const box = input.closest('[class*="field"], [class*="form-group"], [data-automation-id], fieldset, label')
    const hint = norm(
      [
        (input.labels && input.labels[0] && input.labels[0].innerText) || '',
        input.getAttribute('aria-label') || '',
        input.name || '',
        input.id || '',
        ((box && box.innerText) || '').slice(0, 300),
      ].join(' ')
    )
    return want && (' ' + hint + ' ').includes(' ' + want + ' ')
  })
  if (!b64) return { matches: targets.length }

  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  const file = new File([arr], filename, { type: mime || 'application/pdf' })
  let attached = 0
  for (const input of targets) {
    try {
      // Same collapsed-upload case as the résumé (see attachResumeFn).
      if (!(input.offsetWidth || input.offsetHeight)) {
        let box = input.parentElement
        for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
          const link = [...box.querySelectorAll('a[href="#"], a[href^="javascript"], a:not([href])')].find(
            (a) => /\b(attach|upload)\b/i.test(a.innerText || '') && (a.offsetWidth || a.offsetHeight)
          )
          if (link) {
            link.click()
            break
          }
        }
      }
      const dt = new DataTransfer()
      dt.items.add(file)
      input.files = dt.files
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      if (input.files && input.files.length > 0) {
        attached++
        input.style.outline = '2px solid #22c55e'
      }
    } catch (e) {
      /* this input rejected the file */
    }
  }
  return { matches: targets.length, attached }
}

// Type an e-mailed verification code into the page: one box, or one box per
// character ("digit 1 of six" …) when the form splits it up.
function fillCodeFn(code) {
  const boxes = [...document.querySelectorAll('input:not([type]), input[type="text"], input[type="tel"], input[type="number"]')].filter((el) => {
    const r = el.getBoundingClientRect()
    if (el.disabled || el.readOnly || (r.width === 0 && r.height === 0)) return false
    const hint = [
      (el.labels && el.labels[0] && el.labels[0].innerText) || '',
      el.getAttribute('aria-label') || '',
      el.placeholder || '',
      el.name || '',
      el.id || '',
      el.getAttribute('autocomplete') || '',
    ].join(' ')
    if (!/verif|one.?time|\botp\b|passcode|security code|confirmation code|access code|\bcode\b/i.test(hint)) return false
    return !/postal|zip|promo|coupon|referral|country|area code|dial/i.test(hint)
  })
  if (!boxes.length) return { filled: 0 }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const type = (el, text) => {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: text.slice(-1), bubbles: true }))
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    el.style.outline = '2px solid #22c55e'
    el.style.outlineOffset = '1px'
  }
  const split = boxes.length >= code.length && boxes.slice(0, code.length).every((el) => el.maxLength === 1 || /digit|character/i.test(el.getAttribute('aria-label') || ''))
  if (split) {
    ;[...code].forEach((ch, i) => type(boxes[i], ch))
    return { filled: 1 }
  }
  const empty = boxes.find((el) => !el.value)
  if (!empty) return { filled: 0 }
  type(empty, code)
  return { filled: 1 }
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
  console.log('[EasyApply] fields (' + controls.length + '):\n' + lines.join('\n'))
  return { count: controls.length }
}

async function fillForm(profile) {
  const P = (profile && profile.personal) || {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // Pause after every field. Some forms (Ashby) save each change a moment later
  // from a snapshot of the whole form; changes made within that moment overwrite
  // each other and a field that looks filled is submitted as missing.
  // Measured on a real Ashby form: 0 ms always loses a field, 10 ms sometimes,
  // 30 ms never (headless, idle machine). 100 ms leaves room for a busy browser.
  const PACE = 100

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
  // Per-field progress for the on-page panel (content.js, same isolated world).
  const clean = (label) => String(label || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const progress = (label, state, value) => {
    try {
      if (window.__jpProgress) {
        window.__jpProgress({ id: 'rule:' + clean(label), label: clean(label), source: 'rule', state, value })
      }
    } catch (e) {}
  }
  add(['first name', 'given name', 'legal first name'], firstName)
  add(['last name', 'surname', 'family name', 'legal last name'], lastName)
  add(['full name', 'legal name', 'applicant name', 'full legal name', 'first and last name'], fullName)
  add(['email', 'e mail', 'email address'], P.email)
  add(['phone', 'mobile', 'telephone', 'phone number', 'cell'], P.phone)
  // Location: split "Toronto, ON, Canada" into city / province / country parts.
  const locParts = String(P.location || '').split(',').map((s) => s.trim()).filter(Boolean)
  // Availability: the value "today" becomes today's date in a date field and
  // "Immediately" in a free-text one (see the natives loop).
  // (A bare "start date" is left out on purpose: work-history sections use it.)
  add(['date available', 'available date', 'available start date', 'earliest start date', 'desired start date', 'preferred start date', 'available to start', 'when can you start', 'when are you available to start'], P['date available'] || 'today')
  add(['street address'], P.address || P['street address'])
  add(['location', 'current location', 'present location', 'where do you currently live', 'where are you located', 'where are you based'], P.location)
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
  add(['require sponsorship', 'need sponsorship', 'visa sponsorship', 'sponsorship', 'sponsorship for employment', 'immigration sponsorship'], P.needs_sponsorship ? 'Yes' : 'No', true)
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
    // Labels made only of very short words ("X", "ID") match exactly or not at all;
    // as substrings they'd hit anything ("x" is in "expected salary").
    if (A.size === 0 || B.size === 0) return a === b ? 1 : 0
    let inter = 0
    for (const x of A) if (B.has(x)) inter++
    let jac = inter / (A.size + B.size - inter)
    const bonus = a.includes(b) || b.includes(a) ? 0.3 : 0
    // Sharing half the words without either containing the other is too weak:
    // "How many years have you been employed as…" is not "Have you been employed by…".
    if (!bonus && jac < 0.6) jac = 0
    // A long question drowns a short alias in Jaccard. A multi-word alias that
    // appears verbatim in the label is a match by itself (longer = more specific).
    const phrase = B.size >= 2 && (' ' + a + ' ').includes(' ' + b + ' ') ? Math.min(0.95, 0.7 + 0.05 * B.size) : 0
    return Math.min(1, Math.max(jac + bonus, phrase))
  }
  const bestEntry = (label) => {
    // A field labelled just "Name" wants the full name. ("name" can't be a
    // general alias: it would also claim "Company name", "School name", …)
    // Work authorization ("Yes") and sponsorship ("No") share their keywords, and
    // mixing them up is the costliest mistake this form-filler can make. So for
    // any question mentioning sponsorship, decide by what is actually asked
    // instead of by keyword overlap.
    if (/\bsponsor/.test(label)) {
      const authorized = entries.find((e) => e.aliases.includes('authorized to work'))
      const sponsorship = entries.find((e) => e.aliases.includes('require sponsorship'))
      // "…authorized to work without sponsorship?", "…will not require sponsorship?"
      const askedNegatively =
        /\bwithout\b[a-z0-9 ]*\bsponsor/.test(label) ||
        /\b(not|never|no)\b( [a-z0-9]+){0,3} (require|need)( [a-z0-9]+){0,3} sponsor/.test(label)
      return (askedNegatively ? authorized : sponsorship) || null
    }
    // "Address" means a street address. Without one in the profile it stays
    // blank — otherwise it fuzzy-matches the "email address" alias.
    if (/^(street |home |mailing |current |residential )?address( line)?( ?[12])?$/.test(label)) {
      return (!/2$/.test(label) && entries.find((e) => e.aliases.includes('street address'))) || null
    }
    if (label === 'name' || label === 'your name') {
      const full = entries.find((e) => e.aliases.includes('full name'))
      if (full) return full
    }
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
    if (!nt || !nv) return false
    // Whole words only: "no" must not match "I am not a veteran" or "unknown".
    const within = (hay, needle) => needle.length > 1 && (' ' + hay + ' ').includes(' ' + needle + ' ')
    return nt === nv || within(nt, nv) || within(nv, nt)
  }

  // A number answered against range options: "6 years" picks "5-7 years",
  // "5 to 10", "3+ years", "More than 5 years"… Returns the matching option.
  const numberOption = (opts, textOf, value) => {
    const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(\+|years?|yrs?)?$/i)
    if (!m) return null
    const n = parseFloat(m[1])
    const within = (text) => {
      const t = String(text || '').toLowerCase().replace(/,/g, '')
      let r = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/)
      if (r) return n >= parseFloat(r[1]) && n <= parseFloat(r[2])
      r = t.match(/(\d+(?:\.\d+)?)\s*\+|(?:more than|over|at least|above)\s*(\d+(?:\.\d+)?)/)
      if (r) return r[1] !== undefined ? n >= parseFloat(r[1]) : /at least/.test(t) ? n >= parseFloat(r[2]) : n > parseFloat(r[2])
      r = t.match(/(?:less than|under|below|fewer than)\s*(\d+(?:\.\d+)?)/)
      if (r) return n < parseFloat(r[1])
      r = t.match(/^\D*(\d+(?:\.\d+)?)\D*$/) // a single number: "6", "6 years"
      return r ? n === parseFloat(r[1]) : false
    }
    // Open-ended options ("1+", "3+", "5+") all hold; the last that does is the tightest.
    const hits = opts.filter((o) => within(textOf(o)))
    return hits.length ? hits[hits.length - 1] : null
  }

  let filled = 0
  const record = (label, best) => {
    filledFields.push({ label: clean(label), value: best.value, important: best.important })
    progress(label, 'done', best.value)
  }

  // 1) Native inputs / textareas / <select>
  const natives = [...document.querySelectorAll('input, select, textarea')].filter((el) => {
    if (el.disabled || el.readOnly) return false
    const type = (el.type || '').toLowerCase()
    if (['hidden', 'submit', 'button', 'file', 'password', 'image', 'reset', 'radio', 'checkbox'].includes(type)) return false
    if (el.getAttribute('role') === 'combobox') return false // a dropdown's search box; see step 3
    const r = el.getBoundingClientRect()
    return r.width > 0 || r.height > 0
  })
  // Honeypots: fields a real applicant never sees, or is told to leave empty.
  // Filling one gets the application flagged as a bot.
  const isTrap = (el, label) => {
    const text = `${label || ''} ${el.name || ''} ${el.id || ''} ${el.className || ''} ${el.getAttribute('data-automation-id') || ''}`.toLowerCase()
    if (/leave (this |the )?(field |box |input |question )?(blank|empty)|do not (fill|enter|complete)|don.?t fill|(be left|remain) (blank|empty)|honey ?pot|bot[-_ ]?field|beecatcher/.test(text)) return true
    if (el.closest('[aria-hidden="true"]')) return true
    const r = el.getBoundingClientRect()
    if (r.right <= 0 || r.bottom <= 0) return true // parked off-screen
    const cs = getComputedStyle(el)
    return cs.visibility === 'hidden' || cs.opacity === '0'
  }

  for (const el of natives) {
    if (el.tagName !== 'SELECT' && el.value) continue
    if (isTrap(el, labelText(el))) continue
    const best = bestEntry(norm(labelText(el)))
    if (!best) continue
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => matchOption(o.text, best.value)) || numberOption([...el.options], (o) => o.text, best.value)
      // Fill even if a default (e.g. "US") is preselected, but not if it's already correct.
      if (!opt || opt.selected) continue
      nativeSet(el, opt.value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
      filled++
      highlight(el)
      record(labelText(el), best)
      await sleep(PACE)
    } else if (/^today$/i.test(best.value.trim())) {
      // A date field gets today's date in the format it asks for; anything else
      // (a "When can you start?" text box) gets the word.
      const label = labelText(el)
      const hint = `${el.placeholder || ''} ${el.name || ''} ${el.id || ''} ${label}`.toLowerCase()
      const isDate = el.type === 'date' || /\bdate\b|[dmy]{2,4}[\/\-. ][dmy]{2,4}/.test(hint) || !!el.closest('[class*="date" i]')
      let value = 'Immediately'
      if (isDate) {
        const now = new Date()
        const y = now.getFullYear()
        const m = String(now.getMonth() + 1).padStart(2, '0')
        const d = String(now.getDate()).padStart(2, '0')
        const ph = (el.placeholder || '').toLowerCase()
        const sep = (ph.match(/[\/\-.]/) || ['/'])[0]
        if (el.type === 'date') value = `${y}-${m}-${d}`
        else if (/^m+.d+.y+/.test(ph)) value = [m, d, y].join(sep)
        else if (/^d+.m+.y+/.test(ph)) value = [d, m, y].join(sep)
        else if (/^d+ m{3,} y+/.test(ph)) value = `${now.getDate()} ${now.toLocaleString('en-US', { month: 'short' })} ${y}`
        else value = `${y}-${m}-${d}` // no stated format: ISO can't be misread as day/month swapped
      }
      el.focus()
      nativeSet(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      if (isDate) {
        el.dispatchEvent(new FocusEvent('blur'))
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
        await sleep(150)
        // Custom date pickers throw away text they can't parse.
        if (!el.value) {
          progress(label, 'skipped', 'date picker not supported — pick the date yourself')
          continue
        }
      }
      filled++
      highlight(el)
      record(label, { value: el.value || value, important: false })
      await sleep(PACE)
    } else {
      // Same event sequence as typing and tabbing away: some forms only commit
      // (or validate) a field when it loses focus.
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      // A number box rejects "6 years"; give it the number.
      const number = el.type === 'number' && String(best.value).match(/-?\d+(\.\d+)?/)
      nativeSet(el, number ? number[0] : String(best.value))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      el.dispatchEvent(new FocusEvent('blur'))
      filled++
      highlight(el)
      record(labelText(el), best)
      await sleep(PACE)
    }
  }

  // 1b) "Create account" / "Sign in" pages: the configured account password goes
  // into every empty password box (password + verify). The e-mail box was filled
  // above. Clicking the site's Create Account / Sign In button stays manual.
  const accountPassword = (profile.account && profile.account.password) || ''
  if (accountPassword) {
    for (const el of document.querySelectorAll('input[type="password"]')) {
      const r = el.getBoundingClientRect()
      if (el.disabled || el.readOnly || el.value || (r.width === 0 && r.height === 0)) continue
      const label = labelText(el)
      if (isTrap(el, label)) continue
      nativeSet(el, accountPassword)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      filled++
      highlight(el)
      record(label || 'Password', { value: '••••••••', important: false }) // never echo it
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
    const ranged = group.some((r) => matchOption(norm(labelText(r)), best.value))
      ? null
      : numberOption(group, (r) => labelText(r), best.value)
    for (const r of group) {
      const rl = norm(labelText(r))
      if (matchOption(rl, best.value) || r === ranged) {
        realClick(r)
        if (!r.checked) r.checked = true
        r.dispatchEvent(new Event('change', { bubbles: true }))
        filled++
        highlight(r.closest('label') || r)
        record(groupLabel(group[0]), best)
        await sleep(PACE)
        break
      }
    }
  }

  // 2b) Standalone checkboxes (consents / acknowledgements). Ticked only when the
  // profile answers that statement affirmatively — never unticked, never guessed.
  const affirmative = /^(yes|true|agree|i agree|checked)$/i
  for (const box of document.querySelectorAll('input[type="checkbox"]')) {
    if (box.disabled || box.checked) continue
    // Hidden state holder of a toggle-button group (handled in 2c), not a real checkbox.
    if (box.parentElement && box.parentElement.querySelector(':scope > button[aria-pressed]')) continue
    const rect = box.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0 && !box.closest('label') && !(box.labels && box.labels.length)) continue
    const label = labelText(box)
    const best = bestEntry(norm(label))
    if (!best || !affirmative.test(best.value.trim())) continue
    realClick(box)
    if (!box.checked) {
      box.checked = true
      box.dispatchEvent(new Event('change', { bubbles: true }))
    }
    filled++
    highlight(box.closest('label') || (box.labels && box.labels[0]) || box)
    filledFields.push({ label: clean(label), value: 'checked', important: true })
    progress(label, 'done', 'checked')
    await sleep(PACE)
  }

  // 2c) Toggle-button choices (Ashby's Yes / No pair and similar): sibling buttons
  // carrying aria-pressed, with the question on the surrounding field container.
  const seenGroups = new Set()
  for (const btn of document.querySelectorAll('button[aria-pressed]')) {
    const group = btn.parentElement
    if (!group || seenGroups.has(group)) continue
    seenGroups.add(group)
    const opts = [...group.querySelectorAll(':scope > button[aria-pressed]')].filter((o) => !o.disabled)
    if (opts.length < 2 || opts.some((o) => o.getAttribute('aria-pressed') === 'true')) continue
    const entry = group.closest(
      '[class*="field-entry"], [class*="fieldEntry"], [data-automation-id^="formField"], fieldset, [role="group"]'
    )
    const lab = entry && entry.querySelector('label, legend')
    const question = (lab && lab.innerText.trim()) || group.getAttribute('aria-label') || labelText(group)
    const best = bestEntry(norm(question))
    if (!best) continue
    const opt =
      opts.find((o) => norm(o.innerText) === norm(best.value)) || opts.find((o) => matchOption(o.innerText, best.value))
    if (!opt) {
      progress(question, 'skipped', `no "${best.value}" option`)
      continue
    }
    // These buttons toggle: a second click on the chosen one un-answers the
    // question. So click once like a person would (focus, click, move on), give
    // the form time to react, and only retry if it clearly did not register.
    const isPressed = async () => {
      for (let i = 0; i < 12; i++) {
        if (opt.getAttribute('aria-pressed') === 'true') return true
        await sleep(50)
      }
      return false
    }
    opt.focus()
    realClick(opt)
    if (!(await isPressed())) {
      opt.click()
      if (!(await isPressed())) {
        progress(question, 'skipped', `couldn't select "${best.value}"`)
        continue
      }
    }
    opt.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    opt.blur()
    filled++
    highlight(opt)
    record(question, best)
    await sleep(PACE)
  }

  // 3) Custom dropdowns: Workday listbox buttons and react-select style
  // comboboxes (Greenhouse), including typeaheads that list nothing until typed in.
  const visibleOptions = () =>
    [...document.querySelectorAll('[role="option"], [data-automation-id="promptOption"]')].filter(
      (o) => o.offsetParent !== null
    )
  // What the widget currently shows as chosen. A react-select keeps its <input>
  // empty and renders the choice in a sibling element.
  const chosenText = (t) => {
    const ctl = t.closest('[class*="control"]')
    const shown = ctl && ctl.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]')
    return norm((shown && shown.innerText) || t.innerText || t.value)
  }
  const isUnset = (text) => !text || /^(select|choose|no selection)/.test(text)
  const closeMenu = async (t) => {
    ;(document.activeElement || t).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
    )
    await sleep(80)
    if (visibleOptions().length && t.tagName !== 'INPUT') realClick(t)
    if (t.tagName === 'INPUT') t.blur()
    await sleep(80)
  }
  const triggers = [...document.querySelectorAll('button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"], [role="combobox"]')].filter((t) => {
    const rect = t.getBoundingClientRect()
    return !t.disabled && (rect.width > 0 || rect.height > 0)
  })
  for (const trigger of triggers) {
    if (!isUnset(chosenText(trigger))) continue // already chosen
    const triggerLabel = labelText(trigger)
    const best = bestEntry(norm(triggerLabel))
    if (!best) continue

    progress(triggerLabel, 'filling', best.value)
    realClick(trigger)
    let options = []
    for (let i = 0; i < 12; i++) {
      await sleep(120)
      options = visibleOptions()
      if (options.length) break
    }
    let opt =
      options.find((o) => norm(o.innerText) === norm(best.value)) || options.find((o) => matchOption(o.innerText, best.value))
    if (!opt) opt = numberOption(options, (o) => o.innerText, best.value)
    // A place offered in another shape: "Toronto, Canada" for "Toronto, ON, Canada".
    if (!opt && best.value.includes(',')) {
      // `metro area` lets a suburb ("North York") accept its city ("Toronto, Canada").
      const mine = new Set(
        best.value.split(',').map(norm).concat(norm(P.city), norm(P.country), norm(P['metro area']))
      )
      for (const part of [...mine]) if (PROV[part.toUpperCase()]) mine.add(norm(PROV[part.toUpperCase()]))
      opt = options.find((o) => {
        const theirs = (o.innerText || '').split(',').map(norm).filter(Boolean)
        return theirs.length >= 2 && theirs.every((part) => mine.has(part))
      })
    }

    // Typeahead (e.g. a location search): search for the first part of the value
    // ("Toronto"), then take the result agreeing with most of its other parts.
    const box = trigger.tagName === 'INPUT' ? trigger : null
    if (!opt && box) {
      const parts = best.value.split(',').map((x) => x.trim()).filter(Boolean)
      const want = parts.map(norm).concat(parts.map((x) => norm(PROV[x.toUpperCase()] || '')).filter(Boolean))
      box.focus()
      nativeSet(box, parts[0])
      box.dispatchEvent(new Event('input', { bubbles: true }))
      let top = null
      let topScore = 0
      for (let i = 0; i < 25 && !top; i++) {
        await sleep(160)
        for (const o of visibleOptions()) {
          const text = ' ' + norm(o.innerText) + ' '
          if (!text.includes(' ' + norm(parts[0]) + ' ')) continue
          const score = want.filter((w) => text.includes(' ' + w + ' ')).length
          if (score > topScore) {
            top = o
            topScore = score
          }
        }
      }
      opt = top
      if (!opt) {
        nativeSet(box, '')
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    if (opt) {
      // Report what was actually picked; it can differ from the profile's wording.
      const picked = (opt.innerText || '').replace(/\s+/g, ' ').trim() || best.value
      realClick(opt)
      await sleep(150)
      // Keyboard repair: the widget can show selected while validation fails.
      if (isUnset(chosenText(trigger)) && trigger.tagName !== 'INPUT') {
        try {
          trigger.focus()
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        } catch (e) {}
      }
      if (trigger.tagName === 'INPUT' && isUnset(chosenText(trigger))) {
        progress(triggerLabel, 'skipped', `couldn't select "${best.value}"`)
        await closeMenu(trigger)
        continue
      }
      filled++
      highlight(trigger.closest('[class*="control"]') || trigger)
      if (trigger.tagName === 'INPUT') trigger.blur()
      record(triggerLabel, { value: picked, important: best.important })
      await sleep(PACE)
    } else {
      progress(triggerLabel, 'skipped', `no "${best.value}" option`)
      // Close the menu to avoid leaving it open over the next field.
      await closeMenu(trigger)
    }
  }

  // 4) Second pass for dependent <select>s (e.g. State/Province re-renders its
  // options once Country is set). Runs once, after a re-render delay.
  await sleep(500)
  for (const el of document.querySelectorAll('select')) {
    if (el.disabled) continue
    const best = bestEntry(norm(labelText(el)))
    if (!best) continue
    const opt = [...el.options].find((o) => matchOption(o.text, best.value)) || numberOption([...el.options], (o) => o.text, best.value)
    if (!opt || opt.selected) continue
    nativeSet(el, opt.value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
    filled++
    highlight(el)
    record(labelText(el), best)
    await sleep(PACE)
  }

  return { filled, fields: filledFields }
}
