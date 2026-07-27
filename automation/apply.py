#!/usr/bin/env python3
"""Semi-automatic Greenhouse application runner (host-side, Playwright).

L2 "semi-auto": it opens a real browser, fills the form from your JobPilot
profile (reusing the same label->profile matching as the extension), answers
blank questions via /api/answer, and attaches your tailored PDFs — then PAUSES
so YOU review and click Submit. It NEVER submits for you.

Runs on your Mac (needs a visible browser), talking to the Dockerized backend.

    cd automation
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    playwright install chromium
    python apply.py --job-id 21          # or: --url <greenhouse apply url>

Login/session is reused via a persistent browser profile (./.userdata), so you
log in once (if a site needs it); cookies persist across runs. No passwords stored.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import urllib.request
from pathlib import Path

USER_DATA = Path(__file__).resolve().parent / ".userdata"

# --- Fill engine injected into the page (mirrors the extension's matching) ---
FILL_JS = r"""
(profile) => {
  const P = (profile && profile.personal) || {};
  const norm = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  const parts = String(P['first name'] || P.name || '').trim().split(/\s+/);
  const entries = [];
  const add = (al, v) => { if (v===undefined||v===null||v===''||typeof v==='boolean') return; entries.push({aliases: al.map(norm), value: String(v)}); };
  add(['first name','given name'], P['first name'] || parts[0]);
  add(['last name','surname','family name'], P['last name'] || '');
  add(['full name','name','legal name'], P.name || [P['first name'],P['last name']].filter(Boolean).join(' '));
  add(['email','email address'], P.email);
  add(['phone','mobile','telephone','phone number'], P.phone);
  add(['address','street address','city','location','current location','location city'], P.location);
  const country = P.country || String(P.location||'').split(',').map(s=>s.trim()).filter(Boolean).pop();
  add(['country','country of residence'], country);
  add(['linkedin','linkedin url','linkedin profile'], P.linkedin);
  add(['github','github url','portfolio','website'], P.github);
  add(['legally eligible to work','authorized to work','eligible to work','work authorization'], 'Yes');
  const skip = new Set(['name','first name','last name','email','phone','location','linkedin','github','needs_sponsorship']);
  for (const [k,v] of Object.entries(P)) { if (skip.has(k)) continue; add([k], v); }

  const sim = (a,b) => {
    if (!a||!b) return 0;
    const A=new Set(a.split(' ').filter(x=>x.length>2)), B=new Set(b.split(' ').filter(x=>x.length>2));
    if (!A.size||!B.size) return (a.includes(b)||b.includes(a))?0.6:0;
    let i=0; for (const x of A) if (B.has(x)) i++;
    return Math.min(1, i/(A.size+B.size-i) + ((a.includes(b)||b.includes(a))?0.3:0));
  };
  const labelText = (el) => {
    if (el.id) { const l=document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l&&l.innerText.trim()) return l.innerText; }
    const w=el.closest('label'); if (w&&w.innerText.trim()) return w.innerText;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.placeholder) return el.placeholder;
    let n=el; for (let i=0;i<4&&n;i++){ n=n.parentElement; if(!n) break; const c=n.cloneNode(true); c.querySelectorAll('input,select,textarea,option,button').forEach(x=>x.remove()); const t=(c.innerText||'').trim(); if (t&&t.length<200) return t; }
    return '';
  };
  const nativeSet = (el, value) => {
    const proto = el.tagName==='SELECT'?window.HTMLSelectElement.prototype:(el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype);
    const d=Object.getOwnPropertyDescriptor(proto,'value'); if (d&&d.set) d.set.call(el,value); else el.value=value;
  };
  const best = (label) => { let b=null,s=0; for (const e of entries) for (const a of e.aliases){ const v=sim(label,a); if (v>s){s=v;b=e;} } return s>=0.5?b:null; };

  const fields=[...document.querySelectorAll('input,select,textarea')].filter(el=>{
    if (el.disabled||el.readOnly) return false;
    const t=(el.type||'').toLowerCase();
    if (['hidden','submit','button','file','password','image','reset','radio','checkbox'].includes(t)) return false;
    const r=el.getBoundingClientRect(); return r.width>0||r.height>0;
  });
  let filled=0; const blanks=[]; let idx=0;
  for (const el of fields) {
    const isSel=el.tagName==='SELECT';
    if (isSel ? el.selectedIndex>0 : el.value) continue;
    const label=labelText(el).trim(); const nl=norm(label); if (nl.length<3) continue;
    const b=best(nl);
    if (b) {
      if (isSel) { const o=[...el.options].find(o=>norm(o.text)===norm(b.value)||norm(o.text).includes(norm(b.value))); if(!o) {} else { nativeSet(el,o.value); el.dispatchEvent(new Event('change',{bubbles:true})); filled++; el.style.outline='2px solid #22c55e'; continue; } }
      else { nativeSet(el,String(b.value)); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); filled++; el.style.outline='2px solid #22c55e'; continue; }
    }
    // unmatched question -> candidate for AI
    let options=null;
    if (isSel){ options=[...el.options].map(o=>o.text.trim()).filter(t=>t&&!/^(select|choose|no selection)/i.test(t)); if(!options.length) continue; }
    const isQ = el.tagName==='TEXTAREA'||isSel||nl.length>=15||label.includes('?');
    if (!isQ) continue;
    el.setAttribute('data-jp-idx', String(idx));
    blanks.push({idx, label, options}); idx++;
  }
  return {filled, blanks};
}
"""

APPLY_JS = r"""
(items) => {
  const norm=(s)=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  const nativeSet=(el,v)=>{const proto=el.tagName==='SELECT'?window.HTMLSelectElement.prototype:(el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype);const d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set)d.set.call(el,v);else el.value=v;};
  let filled=0;
  for (const {idx,answer} of items){
    const el=document.querySelector(`[data-jp-idx="${idx}"]`); if(!el||!answer) continue;
    if (el.tagName==='SELECT'){ const na=norm(answer); const o=[...el.options].find(o=>norm(o.text)===na||norm(o.text).includes(na)||na.includes(norm(o.text))); if(!o) continue; nativeSet(el,o.value); el.dispatchEvent(new Event('change',{bubbles:true})); }
    else { nativeSet(el,String(answer)); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    el.style.outline='2px solid #3b82f6'; filled++;
  }
  return {filled};
}
"""


def api_get(base: str, path: str):
    with urllib.request.urlopen(f"{base}{path}") as r:
        return json.load(r)


def api_post(base: str, path: str, body: dict):
    req = urllib.request.Request(
        f"{base}{path}", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def download(base: str, path: str, suffix: str) -> str | None:
    try:
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        with urllib.request.urlopen(f"{base}{path}") as r:
            tmp.write(r.read())
        tmp.close()
        return tmp.name
    except Exception as exc:
        print(f"  (couldn't download {path}: {exc})")
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Semi-auto Greenhouse applier")
    ap.add_argument("--job-id", type=int, help="JobPilot job id (for profile-tailored PDFs)")
    ap.add_argument("--url", help="Apply page URL (defaults to the job's url)")
    ap.add_argument("--backend", default="http://localhost:8000")
    ap.add_argument("--no-ai", action="store_true", help="Skip /api/answer for blank questions")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    profile = api_get(args.backend, "/api/profile")
    job = api_get(args.backend, f"/api/jobs/{args.job_id}") if args.job_id else {}
    url = args.url or job.get("url")
    if not url:
        raise SystemExit("Provide --url or a --job-id whose job has a url.")

    resume_pdf = cover_pdf = None
    if args.job_id and job.get("resume_path"):
        resume_pdf = download(args.backend, f"/api/jobs/{args.job_id}/resume?inline=1", ".pdf")
    if args.job_id and job.get("cover_letter_path"):
        cover_pdf = download(args.backend, f"/api/jobs/{args.job_id}/cover-letter?inline=1", ".pdf")

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(str(USER_DATA), headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        print(f"→ Opening {url}")
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(2000)

        res = page.evaluate(FILL_JS, profile)
        print(f"✓ Filled {res['filled']} field(s) from profile (green).")

        if not args.no_ai and res.get("blanks"):
            items = []
            for b in res["blanks"][:10]:
                try:
                    ans = api_post(args.backend, "/api/answer", {"question": b["label"], "options": b.get("options")})
                    if ans.get("answer"):
                        items.append({"idx": b["idx"], "answer": ans["answer"]})
                except Exception as exc:
                    print(f"  (answer failed for '{b['label'][:40]}': {exc})")
            if items:
                r2 = page.evaluate(APPLY_JS, items)
                print(f"✓ AI-answered {r2['filled']} blank question(s) (blue — review).")

        # File uploads — best-effort; tune selectors per real Greenhouse DOM.
        for pdf, kind in ((resume_pdf, "resume"), (cover_pdf, "cover")):
            if not pdf:
                continue
            try:
                inputs = page.query_selector_all('input[type="file"]')
                target = None
                for inp in inputs:
                    around = (inp.evaluate("e => (e.closest('div,section,fieldset')||e.parentElement)?.innerText || ''") or "").lower()
                    if kind == "resume" and ("resume" in around or "cv" in around):
                        target = inp
                    if kind == "cover" and "cover" in around:
                        target = inp
                if target is None and inputs:
                    target = inputs[0] if kind == "resume" else (inputs[1] if len(inputs) > 1 else None)
                if target:
                    target.set_input_files(pdf)
                    print(f"✓ Attached {kind} PDF.")
            except Exception as exc:
                print(f"  (couldn't attach {kind}: {exc})")

        print("\n=== Review the form in the browser, fix anything, then SUBMIT manually. ===")
        input("Press Enter here when you're done to close the browser…")
        ctx.close()


if __name__ == "__main__":
    main()
