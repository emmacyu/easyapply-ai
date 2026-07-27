"""Extract readable prose from a LaTeX document and diff two versions.

Used to show what the AI changed between the original template and the
tailored résumé / cover letter (word-level, ignoring LaTeX scaffolding).
"""

from __future__ import annotations

import difflib
import re

# Commands whose bracketed/braced arguments are layout noise we drop entirely.
_DROP_WITH_ARGS = re.compile(
    r"\\(?:vspace|hspace|vskip|hskip|pagenumbering|color|textcolor|definecolor|"
    r"setlength|titlespacing|titleformat|rule|smallskip|medskip|bigskip|"
    r"moderncvstyle|moderncvcolor|hypersetup|geometry|usepackage|documentclass|"
    r"newcommand|renewcommand|enclosure)\*?\s*(?:\[[^\]]*\])?(?:\{[^{}]*\})*",
)
# Formatting commands to unwrap (keep their text argument, drop the command).
_UNWRAP = re.compile(
    r"\\(?:section|subsection|datedsubsection|textbf|textit|emph|underline|name|"
    r"basicInfo|texttt|large|Large|huge|Huge|scshape|centerline|role|opening|"
    r"closing|recipient|makelettertitle|justify|item)\*?"
)


def latex_to_text(tex: str) -> str:
    m = re.search(r"\\begin\{document\}(.*)\\end\{document\}", tex, re.DOTALL)
    body = m.group(1) if m else tex

    # Strip comments (unescaped %).
    body = "\n".join(re.sub(r"(?<!\\)%.*$", "", ln) for ln in body.splitlines())

    body = _DROP_WITH_ARGS.sub(" ", body)
    body = re.sub(r"\\(?:begin|end)\{[^}]*\}", "\n", body)
    body = body.replace(r"\item", "\n• ")
    body = _UNWRAP.sub(" ", body)
    # href{url}{text} -> keep text only
    body = re.sub(r"\\href\s*\{[^{}]*\}\s*\{([^{}]*)\}", r"\1", body)
    # Any remaining control sequence -> space.
    body = re.sub(r"\\[a-zA-Z@]+\*?", " ", body)
    body = body.replace("{", " ").replace("}", " ")

    for a, b in ((r"\&", "&"), (r"\%", "%"), (r"\_", "_"), (r"\#", "#"), (r"\$", "$")):
        body = body.replace(a, b)
    body = body.replace(r"\textasciitilde", "~").replace("~", " ")

    out = []
    for line in body.splitlines():
        line = re.sub(r"[ \t]+", " ", line).strip()
        if line:
            out.append(line)
    return "\n".join(out)


def diff_segments(original_tex: str, tailored_tex: str) -> list[dict[str, str]]:
    a = latex_to_text(original_tex)
    b = latex_to_text(tailored_tex)
    a_toks = re.findall(r"\S+|\s+", a)
    b_toks = re.findall(r"\S+|\s+", b)

    sm = difflib.SequenceMatcher(None, a_toks, b_toks, autojunk=False)
    segments: list[dict[str, str]] = []

    def push(kind: str, text: str) -> None:
        if not text:
            return
        if segments and segments[-1]["type"] == kind:
            segments[-1]["text"] += text
        else:
            segments.append({"type": kind, "text": text})

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            push("equal", "".join(a_toks[i1:i2]))
        elif tag == "delete":
            push("delete", "".join(a_toks[i1:i2]))
        elif tag == "insert":
            push("insert", "".join(b_toks[j1:j2]))
        elif tag == "replace":
            push("delete", "".join(a_toks[i1:i2]))
            push("insert", "".join(b_toks[j1:j2]))
    return segments
