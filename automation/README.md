# Semi-auto applier (Playwright, host-side)

L2 **semi-automatic** Greenhouse applier. It opens a real browser, fills the
form from your JobPilot profile, AI-answers blank questions, attaches your
tailored PDFs — then **pauses for you to review and Submit yourself**.
It **never** clicks Submit.

Runs on your Mac (needs a visible browser); talks to the Dockerized backend on
`localhost:8000`.

## Why it's separate from Docker

Semi-auto needs a browser you can see and click in — a headless container can't
do that. So this is a host script; the backend (jobs, profile, `/api/answer`,
tailored PDFs) stays in Docker and this talks to it over HTTP.

## Setup (once)

```bash
cd automation
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

## Run

Make sure JobPilot is up (`docker compose up -d`) and the job has generated
materials (so the tailored PDFs exist).

```bash
python apply.py --job-id 21          # uses that job's url + tailored PDFs
python apply.py --url "https://job-boards.greenhouse.io/..."   # explicit apply page
python apply.py --job-id 21 --no-ai  # skip LLM answers (save quota)
```

- **Login is reused** via a persistent browser profile in `./.userdata` (gitignored):
  log in once if a site asks; cookies persist. No passwords are stored.
- Green outline = filled from profile. Blue outline = AI-answered (review!).
- The browser stays open until you press Enter in the terminal.

## ⚠️ This is an untested scaffold

It was written without a live Greenhouse page, so expect to tune it on your real
target:

- **Custom dropdowns** (Greenhouse `Country` is react-select) and **autocomplete**
  (`Location (City)`) aren't handled yet — they'll be left blank.
- **File-upload selectors** are best-effort (`input[type=file]` + nearby text);
  if the wrong input gets the file, adjust the matching in `apply.py`.
- Run once, see what's wrong, and share the behavior — the fill engine mirrors the
  extension so fixes there carry over.

## Safety

- **Never auto-submits.** Greenhouse first (mostly no login, standard forms).
  Do **not** point this at LinkedIn (ban risk) — keep LinkedIn manual.
