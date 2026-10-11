# 简历 / 求职信模板

把你的 Overleaf 原始 LaTeX 源码放这里：

- `resume.tex`      — 你的简历
- `coverletter.tex` — 你的求职信

放**原样的 Overleaf 源码即可**（不用自己改成占位符）。
后续会由代码把它们转成 Jinja 模板（`\VAR{...}` / `\BLOCK{...}`），
再用 tectonic 针对每个职位编译出定制 PDF。

如果用了自定义字体（XeLaTeX + fontspec），把字体文件也放进本目录，
并在此说明用的是哪个字体。

## 你自己的简历 / 求职信放哪

优先读取 `backend/data/`（已 gitignore，不进镜像，Docker 里是 bind-mount，改了即生效）：

- `backend/data/resume/resume.tex` — 简历源码（定制改写的真源）
- `backend/data/resume/*.pdf` — 可选：你自己编译好的简历 PDF。存在时，扩展上传「base résumé」
  用的就是这个文件（沿用它的文件名），不再重新编译
- `backend/data/coverletter/coverletter.tex`（及可选 PDF）— 求职信，规则同上

这些文件不存在时回退到本目录的 `resume.tex` / `coverletter.tex`。
`.cls` 与字体仍取自本目录；放在 `data/resume/` 里的同名 `.cls` / `fonts/` 会覆盖。

## 其他上传栏（论文、成绩单等）

把文件放进 `backend/data/supportive_documents/`，再在 `profile.yaml` 顶层的 `documents:` 里写
「表单上的栏目名: 文件名」，例如 `Additional Documents: "ACM_journal_paper.pdf"`。
扩展点 Apply 时，页面上有这个栏目且还没放文件才会上传；没有就跳过。
