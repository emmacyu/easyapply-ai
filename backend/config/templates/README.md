# 简历 / 求职信模板

把你的 Overleaf 原始 LaTeX 源码放这里：

- `resume.tex`      — 你的简历
- `coverletter.tex` — 你的求职信

放**原样的 Overleaf 源码即可**（不用自己改成占位符）。
后续会由代码把它们转成 Jinja 模板（`\VAR{...}` / `\BLOCK{...}`），
再用 tectonic 针对每个职位编译出定制 PDF。

如果用了自定义字体（XeLaTeX + fontspec），把字体文件也放进本目录，
并在此说明用的是哪个字体。
