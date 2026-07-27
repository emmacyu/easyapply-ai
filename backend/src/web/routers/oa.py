"""OA section: screenshot -> on-screen question + answer (Gemini vision), with
conversational follow-up refine, plus the iPad viewer page served at `/oa`."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from src.web.deps import db

router = APIRouter()


_OA_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<title>OA — iPad view</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0b1220; color:#e5e7eb; font:17px/1.55 -apple-system,system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between;
           gap:10px; padding:10px 16px; background:#111827; border-bottom:1px solid #1f2937; }
  header b { font-size:15px; }
  header .home { color:#93c5fd; text-decoration:none; font-size:14px; white-space:nowrap; }
  header .title { display:flex; align-items:center; gap:10px; }
  #live { font-size:12px; color:#22c55e; }
  #q { padding:14px 16px 0; color:#9ca3af; font-size:15px; }
  #thread { padding:8px 16px 210px; font-size:19px; }
  .turn { margin:14px 0; }
  .turn.user { text-align:right; }
  .role { font-size:12px; color:#6b7280; margin-bottom:2px; }
  .bubble { display:inline-block; text-align:left; max-width:94%; }
  .turn.user .bubble { background:#1e3a8a; color:#dbeafe; font-size:16px; padding:8px 12px; border-radius:12px; }
  pre { background:#020617; border:1px solid #1f2937; border-radius:10px; padding:12px;
        overflow:auto; font:15px/1.5 ui-monospace,Menlo,monospace; white-space:pre; }
  .thinking { color:#9ca3af; font-style:italic; }
  form { position:fixed; bottom:52px; left:0; right:0; display:flex; gap:8px; padding:10px 16px;
         background:#0b1220; border-top:1px solid #1f2937; }
  #msg { flex:1; resize:none; height:44px; padding:11px 12px; border-radius:10px;
         border:1px solid #374151; background:#111827; color:#e5e7eb; font-size:16px; }
  #send { padding:0 18px; border:0; border-radius:10px; background:#2563eb; color:#fff; font-size:16px; font-weight:600; }
  #send:disabled { opacity:.5; }
  nav { position:fixed; bottom:0; left:0; right:0; display:flex; gap:10px; padding:8px 16px;
        background:#111827; border-top:1px solid #1f2937; }
  nav button { flex:1; padding:9px; border:1px solid #374151; border-radius:10px;
               background:#1f2937; color:#e5e7eb; font-size:15px; }
  nav button:disabled { opacity:.4; }
  .empty { padding:60px 24px; text-align:center; color:#6b7280; }
</style></head>
<body>
  <header>
    <a class="home" href="/">← JobPilot</a>
    <span class="title"><b>🖥️ OA answers</b><span id="live">● live</span></span>
  </header>
  <div id="q"></div>
  <div id="thread"><div class="empty">Waiting for a screenshot… trigger "OA screening" from the extension on your Mac.</div></div>
  <form id="f">
    <textarea id="msg" enterkeyhint="send"
      placeholder="Ask to tweak the answer — e.g. make it O(n), use Java, add comments, shorten it…"></textarea>
    <button id="send" type="submit">Send</button>
  </form>
  <nav><button id="prev">◀ Older</button><button id="next" disabled>Newer ▶</button></nav>
<script>
  let items = [], pos = 0, following = true, sending = false, pending = null;
  const esc = (s) => String(s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const md = (s) => String(s||'').split('```').map((p,i) =>
    i % 2 ? '<pre>' + esc(p.replace(/^[a-zA-Z]*\\n/,'')) + '</pre>'
          : '<span>' + esc(p).replace(/\\n/g,'<br>') + '</span>').join('');
  const curId = () => items[pos] && items[pos].id;
  const $ = (id) => document.getElementById(id);

  function paint() {
    const q = $('q'), t = $('thread');
    $('send').disabled = sending;
    if (!items.length) { $('prev').disabled = true; $('next').disabled = true; return; }
    const it = items[pos];
    q.textContent = it.question ? 'Q: ' + it.question : '';
    const msgs = (it.messages && it.messages.length) ? it.messages
               : [{role:'assistant', content: it.answer}];
    let html = msgs.map(m =>
      '<div class="turn ' + (m.role === 'user' ? 'user' : 'assistant') + '">' +
        (m.role === 'user' ? '' : '<div class="role">Answer</div>') +
        '<div class="bubble">' + md(m.content) + '</div></div>').join('');
    if (sending && pending && pending.id === it.id)
      html += '<div class="turn user"><div class="bubble">' + esc(pending.msg) + '</div></div>' +
              '<div class="turn assistant"><div class="role">Answer</div>' +
              '<div class="bubble thinking">thinking…</div></div>';
    t.innerHTML = html;
    $('prev').disabled = pos >= items.length - 1;
    $('next').disabled = pos <= 0;
    $('live').style.visibility = following ? 'visible' : 'hidden';
  }

  $('prev').onclick = () => { following = false; if (pos < items.length - 1) { pos++; paint(); } };
  $('next').onclick = () => { if (pos > 0) { pos--; if (pos === 0) following = true; paint(); } };
  $('msg').addEventListener('focus', () => { following = false; paint(); });
  $('msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('f').requestSubmit(); }
  });

  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('msg'), msg = box.value.trim(), id = curId();
    if (!msg || id == null || sending) return;
    sending = true; pending = { id, msg }; box.value = ''; paint();
    try {
      const r = await fetch('/api/oa/' + id + '/refine', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }) });
      if (!r.ok) throw new Error(((await r.json().catch(()=>({}))).detail) || ('HTTP ' + r.status));
      const updated = await r.json();
      const idx = items.findIndex(x => x.id === id);
      if (idx >= 0) items[idx] = { ...items[idx], ...updated };
    } catch (err) {
      box.value = msg; alert('Refine failed: ' + err.message);
    } finally { sending = false; pending = null; paint(); }
  });

  async function poll() {
    if (sending) return;   // don't clobber an in-flight refine
    try {
      const keep = curId();
      items = await (await fetch('/api/oa/history')).json();
      if (following) pos = 0;
      else if (keep != null) { const i = items.findIndex(x => x.id === keep); if (i >= 0) pos = i; }
      paint();
    } catch (e) {}
  }
  poll(); setInterval(poll, 1500);
</script>
</body></html>"""


@router.post("/api/oa/answer")
def oa_answer(body: dict[str, Any]) -> dict[str, Any]:
    """Screenshot → on-screen question + answer (Gemini vision). Stored to history."""
    import base64

    from src.ai.oa_vision import answer_from_image

    b64 = body.get("image_base64")
    if not b64:
        raise HTTPException(status_code=400, detail="image_base64 is required")
    try:
        image = base64.b64decode(b64)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64 image")
    mime = body.get("mime_type") or "image/jpeg"
    try:
        result = answer_from_image(image, mime)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)[:200])
    # Keep the screenshot so follow-up refinements re-ground on the same image.
    oid = db.add_oa_answer(
        result.get("question") or "", result.get("answer") or "", image_base64=b64, mime_type=mime
    )
    return {"id": oid, **result}


@router.post("/api/oa/{oid}/refine")
def oa_refine(oid: int, body: dict[str, Any]) -> dict[str, Any]:
    """Follow-up on an OA answer: tweak/redo the solution per the user's request.

    Re-sends the stored screenshot + conversation so Gemini keeps full context."""
    import base64

    from src.ai.oa_vision import refine_answer

    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    item = db.get_oa_full(oid)
    if not item:
        raise HTTPException(status_code=404, detail="OA item not found")

    image = None
    if item.get("image_base64"):
        try:
            image = base64.b64decode(item["image_base64"])
        except Exception:  # noqa: BLE001
            image = None
    try:
        result = refine_answer(
            question=item.get("question") or "",
            messages=item.get("messages") or [],
            request=message,
            image_bytes=image,
            mime_type=item.get("mime_type") or "image/jpeg",
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)[:200])

    db.append_oa_messages(oid, message, result.get("answer") or "")
    return db.get_oa(oid) or {}


@router.get("/api/oa/latest")
def oa_latest() -> dict[str, Any]:
    return db.get_latest_oa() or {}


@router.get("/api/oa/history")
def oa_history() -> list[dict[str, Any]]:
    return db.list_oa_answers()


@router.delete("/api/oa")
def oa_clear() -> dict[str, str]:
    db.clear_oa_answers()
    return {"status": "ok"}


@router.get("/oa", response_class=HTMLResponse)
def oa_page() -> str:
    return _OA_PAGE
