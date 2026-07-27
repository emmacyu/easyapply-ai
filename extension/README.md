# JobPilot Autofill (Chrome extension)

A Simplify-style autofiller: on any job application page, it fills fields from
your `backend/config/profile.yaml` (served by the running JobPilot backend).

## Install (unpacked)

1. Make sure JobPilot is running: `docker compose up -d` (backend on :8000).
2. Open `chrome://extensions` → toggle **Developer mode** (top right).
3. Click **Load unpacked** → select this `extension/` folder.
4. Pin the "JobPilot Autofill" icon to the toolbar.

## Use

1. Open the employer's application page and get to the form.
2. Click the extension icon → **Fill this page** (fills from your profile — green outline).
3. Optionally click **AI-answer blank questions** to answer the remaining free-text /
   dropdown questions with the LLM (blue outline = AI-generated, review carefully).
   Each *new* question costs one LLM call (repeats are cached & free); capped at 10 per click.
4. **Review everything** — especially work eligibility, the voluntary self-identification
   (EEO) questions, and every blue field — then submit.

## What it fills

- Standard fields: name / first / last / email / phone / location / LinkedIn /
  GitHub / salary expectation / work eligibility.
- Anything you put under `personal:` in `profile.yaml`, matched by the question
  text (e.g. gender, visible minority, Indigenous, disability, veteran status,
  preferred language, "how did you hear about this job", etc.).

Only fields present in your profile are filled; everything else is left blank.
It never overwrites text you've already typed or a dropdown you've already chosen.

## FinalRoundAI — interview copilot (Phase 1, browser meetings)

For a live interview in a **browser tab** (Google Meet, Zoom web):

1. Open the meeting tab. Click the extension → **🎤 FinalRoundAI**. A draggable panel appears on the page.
2. Click **Start listening** → in Chrome's picker, choose **this meeting tab** and enable **"Share tab audio"**.
3. When the interviewer finishes a question, click **Answer** → the last audio clip is sent to Gemini, which transcribes the question and returns an answer **in your voice** (grounded in your profile/bq). It shows Q + the answer in the panel; keep listening for the next one.

- Audio only leaves your machine to your own backend → Gemini. No third-party STT.
- Each **Answer** = 1 Gemini call. Requires `LLM_PROVIDER=gemini`.
- ⚠️ **Untested scaffold** — built without a live meeting. Known risks to tune on real use:
  - Gemini may not accept `webm/opus`; if answers fail, we'll add in-browser WAV encoding or server-side conversion.
  - The clip = audio since the last **Answer**/Start (no ring buffer yet), so click Answer per question.
  - The overlay is page DOM → **visible if you screen-share** (fine for Meet where you usually don't share your own screen; the screen-share-invisible overlay needs the later macOS desktop app).
- Only for **browser** meetings. Zoom/Teams **desktop** apps need the future desktop app (browser sandbox can't capture them).

## Workday (and similar React ATS)

Workday forms use custom widgets, not plain HTML, so the filler also handles:

- **Custom dropdowns** (`button[aria-haspopup="listbox"]`): it clicks to open the
  menu, waits for the options to render, and clicks the matching option.
- **Native radio-button groups** (Yes/No etc.): checks the option matching your value.

Because every company's Workday instance (`*.myworkdayjobs.com`) differs slightly
and requires signing in, **the first real run may need tuning**. Use the flow below.

## Debugging / tuning on a real page

1. On the application page, click the extension → **Scan page (debug)**.
2. Open DevTools (F12) → **Console** → find the `[JobPilot] field inventory` table.
3. Share that table (or say which fields filled wrong / were missed). The
   `data-automation-id` + label columns let the matching be tightened per ATS.

## Known limitations

- Field matching is heuristic (label text → profile key). It errs on the side of
  leaving a field blank rather than guessing wrong — always review before submit.
- Multi-select widgets, date pickers, and typeahead search boxes aren't handled yet.
- Add/adjust answers by editing `backend/config/profile.yaml` (the `personal:`
  block); the key text is what gets matched against the form's question.
