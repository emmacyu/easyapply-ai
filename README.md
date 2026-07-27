# JobPilot — 个人求职全流程自动化（自用）

> 一个跑在本地的个人求职自动化系统。从最初的「发现→评分→定制材料」求职管道，已成长为覆盖**求职全流程**的自用工具箱：
> **自动发现职位 → AI 打分筛选 → 定制简历/求职信 → 浏览器扩展一键填表投递 → Gmail 验证码读取**。
>
> 📦 **本仓库现聚焦「发现→投递」主管道。** 面试/测评相关功能已拆分为独立仓库：
> **DeepDive + FinalRoundAI + OA → `jobpilot-copilot`**；**Presentation → `jobpilot-presentation`**。
>
> 设计原则：**自动化"准备"，人工"提交"**（human-in-the-loop）。不做全自动投递，不碰账号风控红线。
>
> 本项目综合借鉴了以下开源项目的最佳实践：
> - **JobSpy**（职位发现层，事实标准的多平台抓取库）
> - **AIHawk / Auto_Jobs_Applier_AI_Agent**（用户画像 YAML schema、答案记忆 answer-memory）
> - **career-ops**（10 维度加权 A–F 职位评分体系、"过滤器而非海投"理念）
> - **ApplyPilot**（分阶段流水线、"简历定制但绝不编造"原则）
> - **JobSearch-Agent (sreekar2858)**（sync/async 统一 pipeline、SQLite 去重、agents/prompts 分层）
> - **Final Round AI / Cluely**（面试实时副驾的产品形态，本项目定位为"提词器"——只呈现你自己准备好的答案）

---

## 0. 功能地图与当前进度

| 能力 | 组件 | 状态 |
|---|---|---|
| 职位发现（JobSpy 多平台免登录抓取） | `discovery/jobspy_source.py` | ✅ 可用 |
| 手动贴 URL 入库（扩展"★ Save this job"） | `discovery/manual.py`、`POST /api/jobs/save` | ✅ 可用 |
| SQLite 入库 / 跨平台去重 / 状态机 | `db/database.py` | ✅ 可用 |
| AI 10 维加权评分（A–F） | `ai/scorer.py` + `prompts/score_job.md` | ✅ 可用 |
| 整篇 `.tex` 保守改写 + tectonic 编译自愈 | `ai/resume_tailor.py`、`render/latex.py` | ✅ 可用 |
| 简历/求职信 预览 / A-B 对比 / 词级 diff | `render/textdiff.py`、`JobDetail.tsx` | ✅ 可用 |
| LLM Provider 抽象 + Gemini 多模型额度回退 | `ai/provider.py` | ✅ 可用 |
| React 两栏看板（列表/详情/统计） | `frontend/` | ✅ 可用 |
| 画像在线编辑（保留注释的 YAML 往返写回） | `config_store.py`、`pages/Profile.tsx` | ✅ 可用 |
| Chrome 扩展自动填表（只填不交，含 Workday） | `extension/` | ✅ 可用 |
| 表单问题 AI 作答 + 答案记忆缓存 | `ai/answerer.py`、`bq_store.py` | ✅ 可用 |
| DeepDive / FinalRoundAI（文字+音频）/ OA 截图答题 | **已拆分为独立仓库 `jobpilot-copilot`** | ↗ 移出本仓库 |
| Presentation：GitHub 仓库 → LLM → 幻灯片 → `.pptx` / Google Slides | **已拆分为独立仓库 `jobpilot-presentation`** | ↗ 移出本仓库 |
| Gmail 只读读取注册验证码（限 `emmayu.cs@gmail.com`） | `integrations/gmail_client.py` | 🔴 代码就绪，等你完成 Google Cloud OAuth 配置 |
| Playwright 半自动 Greenhouse 投递（暂停等人工 Submit） | `automation/apply.py` | 🔴 脚手架完成，真实页面未测 |
| APScheduler 每日定时抓取 | `scheduler.py` | ✅ 可用（`serve --schedule`） |
| LinkedIn 人脉外联（找职位→给 HR 发个性化 connect） | — | ⚪ 纯设计，封号风险高，仅半自动 |

图例：✅ 可用并验证过 · 🟡 已接通但未在真实场景验证 · 🔴 代码就绪但卡在外部配置/真实页面 · ⚪ 仅设计

---

## 1. 目标与非目标

### 目标
- 每天自动从 LinkedIn / Indeed / Glassdoor / Google Jobs 拉取符合条件的新职位（目标市场：加拿大多伦多 + Remote）
- 对每个职位用 LLM 做匹配度评分，只保留高分职位
- 为每个高分职位生成：完整定制简历（基于 Overleaf LaTeX 模板，整篇保守改写 → tectonic 编译 PDF）与求职信
- 提供本地 Web 看板：按分数排序浏览职位、下载/预览/对比材料、一键打开申请页、更新申请状态
- 在申请、OA、面试三个环节各提供一件辅助工具（扩展填表 / OA 截图答题 / 面试副驾），全部 **human-in-the-loop**
- 全部数据存本地 SQLite，零云依赖（除 LLM API 调用外）

### 非目标（明确不做）
- ❌ 自动提交申请（不自动点击任何"提交/Submit"按钮）。扩展与 Playwright 脚本可**自动填表**，但**只填不交**，提交由你人工完成。
- ❌ 存储或使用 LinkedIn 账号密码登录抓取（发现层只用免登录方式）；LinkedIn 相关一律半自动。
- ❌ 任何共享账号/凭证抓取功能
- ❌ 多用户、注册登录、云端部署
- ❌ 简历/答案内容编造：AI 只能重组、强调、改写措辞，**不得虚构经历、技能或数据**
- ❌ Gmail 集成越界：只读、且**只允许** `emmayu.cs@gmail.com`，绝不触碰个人主账号

---

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 语言 | Python 3.11+ | `pip` + `requirements.txt` 管理 |
| 职位发现 | `python-jobspy` | 一次调用并发抓 LinkedIn/Indeed/Glassdoor/Google Jobs，免登录 |
| 半自动投递（可选） | Playwright（宿主机跑） | 单个 Greenhouse 申请页填表 + 附件，暂停等人工提交 |
| 数据库 | SQLite（内置 `sqlite3`） | 单文件 `backend/data/jobs.db` |
| LLM | 抽象 Provider 接口 | Anthropic / OpenAI / Gemini / Ollama，`.env` 配置；音频/视觉能力仅 Gemini |
| 后端 | FastAPI | REST API（+ CORS）+ 生产模式挂载前端静态包 |
| 前端看板 | React 18 + Vite + TypeScript | Tailwind CSS + TanStack Query |
| PDF 生成 | LaTeX（Tectonic 编译） | AI 对 `.tex` 模板全文保守改写 → `tectonic` 编译（镜像预装并预热缓存） |
| 申请表自动填写 | Chrome 扩展（MV3，`extension/`） | 从 `/api/profile` 读画像，按标签模糊匹配填字段（含 Workday）；只填不交 |
| 面试/OA 副驾 | 扩展 + Gemini 多模态 | tab 音频 / 屏幕截图 → Gemini 转写并作答 |
| Gmail 验证码 | `google-auth-oauthlib` + Gmail API | 只读，账户白名单硬限制 |
| 调度 | APScheduler（进程内） | 每天定时跑一次 discovery+scoring |
| 配置 | YAML + `.env` | 画像/搜索/评分/答案用 YAML，密钥用 `.env` |

---

## 3. 项目结构（与当前代码一致）

```
easyapply-ai/
├── .env                        # LLM_PROVIDER / key / LLM_MODEL / LLM_FALLBACK_MODELS / GMAIL_ACCOUNT（gitignore）
├── Dockerfile                  # 多阶段：Node 构建前端 → Python + tectonic 运行
├── docker-compose.yml          # 单容器；挂载命名卷 jobpilot-data + bind-mount profile.yaml/bq.yaml/secrets
├── backend/                    # Python 后端
│   ├── main.py                 # CLI 入口：run / discover / score / tailor / serve / gmail-auth
│   ├── requirements.txt
│   ├── config/
│   │   ├── profile.yaml        # 画像（personal 块用于扩展填表；UI 可编辑，注释保留）
│   │   ├── bq.yaml             # ⚠️ 你手写的专业/行为问答（answer-memory 优先命中；代码只读不写）
│   │   ├── search.yaml         # 搜索条件 + schedule_cron + score_threshold
│   │   ├── scoring.yaml        # 评分维度与权重
│   │   ├── blacklist_companies.txt
│   │   ├── secrets/            # gmail_credentials.json + gmail_token.json（gitignore）
│   │   └── templates/          # Overleaf 简历/求职信模板 + 字体
│   │       ├── resume.tex / resume.cls
│   │       ├── coverletter.tex / cover.cls
│   │       └── fonts/Main/*.otf
│   ├── src/
│   │   ├── pipeline.py         # 编排器：discover → dedupe → score → tailor(A/B)
│   │   ├── scheduler.py        # APScheduler 每日 cron
│   │   ├── config_store.py     # profile.yaml 读/写（ruamel 往返，保留注释与顺序）
│   │   ├── bq_store.py         # bq.yaml 只读模糊查询（LLM 之前的高置信快路径）
│   │   ├── discovery/          # jobspy_source.py（抓取）、manual.py（贴 URL 入库）、models.py
│   │   ├── db/                 # database.py、schema.sql（jobs / answers / chat_sessions / chat_messages / oa_answers）
│   │   ├── ai/
│   │   │   ├── provider.py     # LLM 抽象 + Gemini 多模型回退 + JSON 抽取工具
│   │   │   ├── scorer.py       # 10 维加权评分
│   │   │   ├── resume_tailor.py# 整篇 .tex 保守改写 + 编译自愈（简历+求职信）
│   │   │   ├── answerer.py     # 表单问题作答（bq → 缓存 → LLM），带答案记忆
│   │   │   ├── oa_vision.py    # 截图 → Gemini 读题作答（Gemini-only）
│   │   │   └── finalround_audio.py # 会议音频 → Gemini 转写+作答（Gemini-only）
│   │   ├── prompts/            # score_job / tailor_resume_tex / cover_letter_tex / fix_latex /
│   │   │                       #   answer_question / deepdive(_extract) / finalround(_audio) / oa_answer / extract_job
│   │   ├── render/             # latex.py（tectonic 装配编译）、textdiff.py（LaTeX 抽文本+词级 diff）
│   │   ├── integrations/       # gmail_client.py（只读验证码，账户白名单）
│   │   └── web/                # FastAPI 应用（按功能拆分成独立路由板块）
│   │       ├── app.py          # 仅装配：建 app + 中间件 + include_router + SPA 挂载
│   │       ├── deps.py         # 共享：唯一 Database 实例、路径、media 类型
│   │       └── routers/        # 每个板块一个 APIRouter（路径不变，纯内部重组）
│   │           ├── pipeline.py    # Run Pipeline：职位看板 + 发现/评分/定制 + stats
│   │           ├── deepdive.py    # 聊天会话（FinalRoundAI 文字版按 kind 复用）
│   │           ├── finalround.py  # FinalRoundAI 音频（转写+作答）
│   │           └── core.py        # 共享：答案库 + profile + gmail
│   │                              #（DeepDive/FinalRoundAI/OA → jobpilot-copilot；
│   │                              # Presentation → jobpilot-presentation）
│   ├── data/                   # jobs.db + output/（gitignore，容器里为命名卷）
│   └── tests/test_pipeline.py  # mock provider 跑通各阶段 + 去重单测
├── frontend/                   # React 看板（Vite + TS）
│   └── src/
│       ├── main.tsx            # 路由：/  /jobs/:id  /profile
│       ├── components/         # JobsLayout / JobCard / StatsBar / ScoreBadge / ScoreBreakdown / StatusActions
│       ├── pages/              # JobDetail / EmptyDetail / Profile
│       └── api/client.ts       # 前后端契约封装
├── extension/                  # Chrome 扩展（MV3）
│   ├── manifest.json
│   ├── popup.html / popup.js   # 6 个动作按钮（见 §8.5）
│   ├── background.js           # service worker：转发音频/截图到后端
│   └── README.md
├── automation/                 # 宿主机 Playwright 半自动投递器
│   ├── apply.py                # Greenhouse-first；复用扩展填表逻辑；暂停等人工 Submit
│   └── requirements.txt
└── README.md
```

---

## 4. 数据模型与状态机

`jobs` 表核心字段（`db/schema.sql`）：`source / url(unique) / title / company / location / is_remote / salary_* / date_posted / description / dedupe_key / score / grade / score_reasons(JSON) / red_flags(JSON) / resume_path / cover_letter_path / status / created_at / updated_at`。

除 `jobs` 外，DB 还有：
- `answers` — 表单问题的答案记忆（question / answer / options / job_id / reviewed）
- `chat_sessions` + `chat_messages` — DeepDive 与 FinalRoundAI 文字对话（用 `kind` 区分 `deepdive`|`finalround`）
- `oa_answers` — OA 截图答题历史（供 `/oa` 查看页轮询）

状态机（只能沿箭头流转，后端 `PATCH /status` 校验合法性）：

```
discovered → scored → shortlisted → materials_ready → applied → interviewing → offer / rejected
                 ↘ discarded（低于阈值或人工丢弃，终态）
```

去重规则：
1. URL 完全相同 → 跳过；
2. `dedupe_key`（`lower(company)+'|'+normalize(title)`）相同且 `date_posted` 相差 < 14 天 → 视为跨平台重复，保留信息更全的一条。

---

## 5. 画像 `profile.yaml` 与答案库 `bq.yaml`

### `profile.yaml`
所有 AI 生成的事实来源之一，`personal` 块**同时用于扩展自动填表**（key 写成接近自然语言的问题，便于和表单标签模糊匹配，如 `work_authorization`、`Preferred Pronouns`、各类自愿申报项）。可在 `/profile` 页在线编辑，写回时用 ruamel 往返保留注释与键序。

> 注：简历/求职信的**经历真源是 `resume.tex` 本身**（见 §7），无需再在 `profile.yaml` 里重复填经历字段。

### `bq.yaml`（你手写的专业/行为问答）
⚠️ **代码只读、绝不写入。** 在表单作答流程中**优先于 LLM**：若表单问题与某条 Q&A 高置信匹配（Jaccard ≥ 0.7）→ 直接用你的原话（不调 LLM、不写缓存）；措辞差异较大的问题则把整份 bq 作为素材喂给 LLM 参考。

### `search.yaml`
```yaml
sites: [indeed, linkedin, glassdoor, google]
searches:
  - { term: "software engineer", location: "Toronto, ON" }
  - { term: "backend developer",  location: "Remote" }
results_per_site: 30
hours_old: 72
country_indeed: "Canada"
schedule_cron: "0 8 * * *"   # 每天早 8 点（serve --schedule 生效）
score_threshold: 70          # 低于此分自动 discarded
```

---

## 6. AI 评分（career-ops 的 10 维加权体系）

`scoring.yaml` 定义维度与权重（总和 = 100），LLM 按维度打分后加权求和：

```yaml
dimensions:
  skill_match:        { weight: 25, desc: "硬技能与 JD 要求的重合度" }
  experience_level:   { weight: 15, desc: "年限/级别是否匹配（过高过低都扣分）" }
  title_alignment:    { weight: 10, desc: "职位名称与目标方向的一致性" }
  salary_fit:         { weight: 10, desc: "薪资范围（缺失给中性分）" }
  location_remote:    { weight: 10, desc: "地点/远程政策与偏好的匹配" }
  visa_feasibility:   { weight: 10, desc: "身份/签证可行性（硬性排除条款给 0）" }
  company_signal:     { weight: 8,  desc: "公司规模/行业/口碑信号" }
  growth_potential:   { weight: 5,  desc: "技术栈与成长空间" }
  jd_quality:         { weight: 4,  desc: "JD 是否具体清晰" }
  red_flags:          { weight: 3,  desc: "avoid_keywords 命中、骗局特征" }
grades: { A: 85, B: 70, C: 55, D: 40 }
```

`prompts/score_job.md`：输入 profile + JD + scoring.yaml，输出**严格 JSON**（`dimension_scores / total / grade / reasons / red_flags`），指令强调"基于语义推理而非关键词计数"。

---

## 7. 简历 / 求职信定制（整篇 `.tex` 保守改写）

> 早期方案是「LLM 输出 JSON → Jinja2 填模板」；因 Overleaf 简历排版精细、含自定义板块，改用**整篇 `.tex` 保守改写**，保真度更高、改动更小。真源是 `resume.tex` 本身。

**简历**（`prompts/tailor_resume_tex.md`）硬性约束：
1. **绝不编造**：不新增模板里没有的公司/职位/技能/证书/数字，不改动任何数字/日期/公司名；
2. 只允许**重写/重排措辞**贴合 JD，不新增 bullet 或板块；
3. **严格一页**：每条改写后不得比原文更长，总长度 ≤ 原文（保守模式）；
4. **完整保留 LaTeX**：所有自定义命令、preamble、注释、间距原样不动，只改人读正文；
5. 正确转义特殊字符（`\& \% \_`），不得从 `%` 注释里提取内容。

**求职信**（`prompts/cover_letter_tex.md`）：moderncv 模板，设 `\position`/`\company`，针对该公司/JD 重写正文段落（约 350–450 词、4–6 段），事实只能来自简历。

**编译与容错**（`ai/resume_tailor.py` + `render/latex.py`）：改写后先跑 sanitizer（转义裸 `&`）→ `tectonic` 编译；失败 → 把报错喂回 LLM（`prompts/fix_latex.md`）做**一次最小修复**再编译；仍失败或 LLM 额度用尽 → 回退**原始模板**（仍出 PDF），看板显示琥珀色「未定制」提示。产物写到 `data/output/<公司>_<职位>/`。

---

## 8. 各功能使用说明

### 8.1 CLI 与看板

```bash
cd backend
python main.py run              # 完整管道：发现→去重→评分→为 A/B 级生成材料
python main.py discover         # 只抓取入库
python main.py score            # 只给 status=discovered 的评分
python main.py tailor --id 42   # 为指定职位重新生成材料
python main.py serve            # 启动后端 API http://localhost:8000
python main.py serve --schedule # 附带每日定时抓取（读 search.yaml 的 schedule_cron）
python main.py gmail-auth       # 一次性授权只读 Gmail（见 §8.6）
python main.py run --mock       # 用 mock LLM，免 key 跑通流程
cd ../frontend && npm run dev   # 前端开发服务器 http://localhost:5173
```

### 8.2 用 Docker 运行（一体化，最简单）

镜像多阶段构建：Node 构建前端静态包 → FastAPI 同时提供 `/api/*` 与前端页面，单容器即可。

```bash
# 1) 配置 .env（首次）：项目根目录 .env 填入对应 provider 的 key（可从 backend/.env.example 复制）
# 2) 构建并启动
docker compose up -d --build
# 3) 打开 http://localhost:8000
docker compose logs -f          # 日志
docker compose down             # 停止
```

- LLM provider/key 放**项目根目录 `.env`**（`main.py` 读 `PROJECT_ROOT.parent/.env`）。
- SQLite 与生成材料存命名卷 `jobpilot-data`（挂载 `/app/backend/data`），重启不丢。
- `profile.yaml`、`bq.yaml`、`secrets/` 为 **bind-mount**：在宿主机改动即时生效、无需重建镜像。
- 端口：`8000` 主服务；`8765` 仅一次性 Gmail OAuth loopback 用。

### 8.3 LLM provider 与免费额度回退

```
LLM_PROVIDER=gemini
LLM_MODEL=gemini-flash-latest
LLM_FALLBACK_MODELS=gemini-2.0-flash,gemini-3-flash-preview
```

Gemini 免费层按模型按天限额（flash 系列约 20 次/天）。主模型额度用尽自动切到 `LLM_FALLBACK_MODELS` 的下一个（每个模型独立额度桶）。全部失败时简历/求职信回退未定制原模板。
> **音频（FinalRoundAI）与视觉（OA）能力目前仅 Gemini 支持**，非 gemini provider 会直接报错。

### 8.4 看板：预览 / 对比 / 高亮差异

职位详情页 Materials 区，简历和求职信各有：
- **Generate / Regenerate**（`POST /tailor?kind=resume|cover|both`，互不覆盖）
- **Preview**：弹窗内嵌 PDF（`?inline=1`）
- **Compare**：并排「原始模板 vs 定制版」；可切到 **Highlight diff** —— 词级对比，🟩绿=新增 / 🟥红删除线=删除
- **Download**：下载定制 PDF

### 8.5 浏览器扩展：填表 + 副驾入口（`extension/`）

多数公司投递在**外部招聘网站**（Scotiabank / Workday 等），因跨域限制，只有扩展能"伸进任意申请页"。popup 有 6 个动作：

| 按钮 | 作用 |
|---|---|
| ★ Save this job to JobPilot | 把当前职位 URL 抓取入库（`POST /api/jobs/save`），进看板评分/定制 |
| **⚡ Apply — fill everything** | **一键完成整张单页申请：填字段 + AI 答空白题 + 附上定制简历 PDF，然后停下等你复核并手动点 Submit**。上方下拉选哪份简历（按当前页公司自动匹配 `materials_ready` 职位）。最适合 Greenhouse/Lever 这类**单页** ATS;Workday 多步只填当前步（见下） |
| Fill this page | 从 `GET /api/profile` 按「标签 ↔ 答案」模糊匹配填字段；命中加绿框；只填有的、不覆盖已填（Apply 的分步版）|
| AI-answer blank questions | 对页面空白问题调 `POST /api/answer`（bq → 缓存 → LLM）作答后回填（Apply 的分步版）|
| 🖥️ OA screening → iPad | 截当前屏 → `POST /api/oa/answer`（Gemini 读题作答）→ 结果推到 `/oa` 查看页（可在 iPad 上开）|
| 🎤 FinalRoundAI | 注入可拖动悬浮窗，`getDisplayMedia` 抓会议 tab 音频 → `POST /api/finalround/audio` → 显示 Q+作答 |
| Scan page (debug) | 把检测到的字段清单打到页面 DevTools 控制台 |

- **支持控件**：标准 `<input>/<textarea>/原生 <select>`、**Workday** 式自定义下拉、原生单选组。多选/日期/typeahead 暂不支持。
- **安装**：`chrome://extensions` → 开发者模式 → 加载已解压 → 选 `extension/`。
- ⚠️ 扩展**不上传简历文件**：PDF 由 JobPilot 生成、你下载后**手动上传**。提交前务必人工复核（尤其工作资格与自愿申报项）。

### 8.6 Gmail 只读验证码（`integrations/gmail_client.py`）🔴 待配置

用于读取注册 ATS 时的**验证码/链接**，减少手动。**账户硬限制：只允许 `emmayu.cs@gmail.com`**，token 属于任何其他账户都会被拒绝丢弃。

一次性配置（你的动作）：
1. Google Cloud：建项目 → 启用 Gmail API → OAuth 同意屏（External，把 `emmayu.cs@gmail.com` 加为 Test user）→ 建 **Desktop app** OAuth client → 下载 JSON → 存为 `backend/config/secrets/gmail_credentials.json`。
2. `docker compose exec jobpilot python main.py gmail-auth` → 打开打印的 URL → 以 emmayu.cs 登录并授权。
3. 注意：Testing 模式 refresh token 约 7 天过期（重跑授权，或把 app 发布到 Production）。

接口：`GET /api/gmail/status`、`GET /api/gmail/verification?sender=&minutes=`。

### 8.7 面试/测评功能（已拆分为独立仓库）

**DeepDive（经历深挖）、FinalRoundAI（面试实时副驾，文字+音频）、OA（截图答题 + `/oa` iPad 查看页）** 已整体拆出为独立服务 **`jobpilot-copilot`**（自带 LLM provider + profile + 聊天/OA 的 DB 表）。
**Presentation（GitHub 仓库 → 幻灯片 → `.pptx`/Google Slides）** 拆为 **`jobpilot-presentation`**。
各自用法见对应仓库的 README。

> ⚠️ 遗留项：`extension/` 里的 **🖥️ OA screening** 与 **🎤 FinalRoundAI** 两个按钮仍指向本地 `:8000` 的 `/api/oa/*`、`/api/finalround/audio`——这些端点已随功能移到 `jobpilot-copilot`。要继续用这两个按钮，需把扩展指向 copilot 服务（默认 `:8020`），或把它们移到 copilot 侧。填表/投递相关按钮不受影响。

### 8.10 Playwright 半自动投递器（`automation/apply.py`）🔴 未在真实页面验证

宿主机跑（需可见浏览器，容器无显示），通过 HTTP 连 Docker 后端。复用扩展的填表逻辑，AI 答空白题，下载并附上定制 PDF，然后**暂停等你复核并手动 Submit——绝不自动提交**。Greenhouse-first。登录复用 `launch_persistent_context('./.userdata')`（登录一次、cookie 持久，不存密码）。

```bash
cd automation && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && playwright install chromium
python apply.py --job-id 42   # 或 --url ...
```

---

## 8bis. 后端 REST API（FastAPI，前后端唯一契约）

**职位与材料**
```
GET   /api/jobs?status=&grade=&sort=score&page=1   职位列表（分页）
GET   /api/jobs/{id}                               详情：JD、评分明细、red flags
PATCH /api/jobs/{id}/status                         状态流转（后端校验状态机）
POST  /api/jobs/save                                手动贴 URL 抓取入库
POST  /api/jobs/{id}/tailor?kind=resume|cover|both  生成材料（后台任务）
GET   /api/jobs/{id}/materials-status               每份材料最近结果 running|tailored|fallback|error
GET   /api/jobs/{id}/resume[?inline=1]              定制简历 PDF
GET   /api/jobs/{id}/cover-letter[?inline=1]        定制求职信 PDF
GET   /api/jobs/{id}/diff/{resume|cover}            原版 vs 定制版词级差异
GET   /api/templates/{resume|cover}[?inline=1]      原始模板 PDF（A/B 对比，带缓存）
```
**表单作答（答案记忆）**
```
POST   /api/answer          作答一个问题（bq → 缓存 → LLM）
GET    /api/answers         列出已缓存答案（可复核）
PUT    /api/answers/{key}   人工修订某答案（标记 reviewed）
DELETE /api/answers/{key}   删除某缓存答案
```
（DeepDive/FinalRoundAI 的 `/api/chat/*`、OA 的 `/api/oa/*`+`/oa` 已随功能移到 `jobpilot-copilot`；Presentation 端点移到 `jobpilot-presentation`）

**Gmail / 画像 / 管道 / 统计**
```
GET  /api/gmail/status                         连接状态与允许账户
GET  /api/gmail/verification?sender=&minutes=  最近验证码
GET  /api/profile                              画像（供扩展填表）
GET/PUT /api/profile/raw                        原始 YAML（供 Profile UI 读/写）
POST /api/pipeline/run                          手动触发完整管道（后台任务）
GET  /api/pipeline/status                       管道运行状态（前端轮询）
GET  /api/stats                                 顶部统计：今日新增/待处理/已投递/回复率
GET  /{full_path}                               SPA 兜底（生产模式挂载 frontend/dist）
```

开发模式：FastAPI 开 CORS（`localhost:5173` + `chrome-extension://` / `moz-extension://`），Vite 代理 `/api`；生产模式：`npm run build` 后 FastAPI 挂载 `frontend/dist`，单端口访问。

---

## 9. 前端页面（React，路由 `/  /jobs/:id  /profile`）

- **JobList（`/`）**：顶部 StatsBar（今日新增/待处理/已投递/回复率）+ 状态 Tab + Grade 多选 + 关键词搜索；职位卡片按分数降序（公司/职位/地点/薪资/ScoreBadge/状态/发布时间 + Shortlist/Discard 快捷键）；状态变更用 TanStack Query 乐观更新，失败回滚 + toast。
- **JobDetail（`/jobs/:id`）**：左 JD 全文（Markdown）；右 ScoreBreakdown（10 维得分条+理由）、red flags、材料区（生成/预览/对比/diff/下载）、"打开申请页"主按钮、StatusActions。
- **Profile（`/profile`）**：在线编辑 `profile.yaml`（保留注释往返写回）。

通用：暗色/亮色跟随系统；服务端状态全交 TanStack Query（无 Redux）。

---

## 10. 工程要求

- 所有 LLM 调用带重试（指数退避）与超时；单个职位失败不中断整批；
- JobSpy 调用间隔 ≥ 5 秒/搜索词，LinkedIn 结果数保守（≤ 30/词），429 自动跳过该站点本轮；
- 日志用 `logging`，管道每阶段打印摘要（发现 N / 去重后 M / A 级 K）；
- `.env`、`data/`、`secrets/`、扩展/自动化的 `.userdata`/`.venv` 全部 gitignore；仓库不得出现真实个人信息；
- 测试：`backend/tests/test_pipeline.py` 用 mock provider 跑通各阶段 + 去重单测。

## 11. 免责声明

本项目仅供个人求职使用。抓取公开职位信息请遵守各平台服务条款与当地法律；生成材料、面试/OA 辅助内容均由本人审阅后手动使用与提交。面试/OA 场景请注意录音同意法规与考试/面试诚信要求——本项目定位为**呈现你自己准备好的答案的提词器**，不代替也不鼓励作弊。
