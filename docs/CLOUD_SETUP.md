# 云端部署：你要做的事（GitHub + Vercel + Supabase）

你的 GitHub 账号：**ShouzhiLPB**。下面按顺序做即可；代码仓库里已包含浏览器登录、**整包 AppData 上传 / 从云端覆盖本机**（见「数据」页）。

**用白话讲**：应用平时把学习记录存在你这台设备上，用着很快。你按下面步骤把「账号 + 数据库 + 网站」接好后，登录同一个账号，数据可以备份到网上、换手机或换电脑时再拉下来。不部署也能一直本地用；部署是为了**换设备不丢进度**。应用里「从云端恢复」会**整份换成云上的数据**，动手前记得先导出本机备份。

---

## 0. 完全不懂「数据库 / SQL」？只要分清两件事

**第一件事：写代码、改网页里的逻辑**——在 Cursor / 本仓库里完成，**不用你懂数据库**。

**第二件事：在网上「租一个小格子」存大家的学习数据**——这就是 **Supabase**。你要做的只是：**用你的浏览器登录 Supabase → 把仓库里现成的几段文字（SQL 文件）复制进去 → 点运行**。可以把它想成：**给那个网站一份说明书，让它知道怎么帮你存 JSON**，不需要你会写 SQL。

### 只有你能完成、我（AI）在这里无法替你点的操作

| 你必须亲自做的 | 为什么 AI 做不了 | 怎么做（最简） |
|----------------|------------------|----------------|
| 在 **supabase.com** 用你的邮箱**注册 / 登录**并**新建项目** | 要你的人脸/邮箱/密码 | 打开网站按提示注册 |
| 在 Supabase 里 **运行本仓库 `app/supabase/migrations/` 下按文件名顺序的 SQL**（至少前 4 个；**大备份易超时请再跑第 5 个**） | 必须在你的项目里执行，我没有你的账号 | 左侧 **SQL** → **New query** → 打开本机对应 `.sql` → **全选复制** → 粘贴到灰框 → 点 **Run**（每个文件各执行一次即可） |
| 把 **Project URL** 和 **anon key** 填进 **Vercel / 本机 `.env.local`** | 密钥只该出现在你的电脑与托管网站 | 见下文 §2 与 §4 |
| 用**自己的手机**打开部署好的网址做一遍手感 | 物理设备与手指操作 | 打开浏览器访问你的 `https://xxx.vercel.app`，数据页登录上传；可按 **`/qa`** 第二节勾清单 |

**若以上不做**：应用里「上传到云端」可能报 **表不存在** 等错——多半是 **SQL 还没在你的 Supabase 里跑**，不是程序写坏了。

---

## 1. Supabase（数据库 + 登录）

1. 打开 [https://supabase.com](https://supabase.com) → 新建 **Project**（记下数据库密码）。
2. **Project Settings → API**：复制 **Project URL**、**anon public** key（不要泄露 **service_role**）。
3. **Authentication → Providers → Email**：保持开启（邮箱 + 密码）。
4. **SQL Editor**：新建查询，按顺序执行本仓库迁移 SQL（可合并在一个查询里先后粘贴执行）：

   1. `app/supabase/migrations/20260417000000_user_app_data.sql` — 表 **`public.user_app_data`**（每用户一行，`payload` 为整包学习 JSON）。
   2. `app/supabase/migrations/20260418000000_merge_payload_delta.sql` — 函数 **`public.jp_learn_merge_payload_delta`**（`stats` / `mediaLibrary` 等增量合并；未执行则应用会回退为整包 upsert）。
   3. `app/supabase/migrations/20260421120000_merge_payload_delta_notes_favs.sql` — 同一 RPC 扩展：**`lessonNotes`**、**`favoriteSentences`** 整段合并；未执行时客户端仍安全（未开环境变量则笔记/收藏变更走整包 upsert）。
   4. `app/supabase/migrations/20260423140000_merge_payload_delta_main_arrays.sql` — 同一 RPC 再扩展：**`lessons`**、**`vocabCards`**、**`sentenceTasks`**、**`grammarTasks`**、**`chatSessions`** 整段合并（i2-4 收口）；未执行且未开扩展 env 时上述字段变更仍走整包 upsert。  
      当前应用已支持：在已登录且已跑本条迁移时，**课文内聊天**（发消息 / 改名 / 新建或删除会话）会经客户端 **2.5 秒防抖** 调用同一 RPC 上传 **`chatSessions`** 子树（无需再跑额外 SQL）。
   5. `app/supabase/migrations/20260424120000_user_app_data_sync_guard_and_rpc_upsert.sql` — **强烈建议**：大 JSON 备份时减轻超时与流量 — 新增 **`jp_learn_remote_sync_guard_meta`**（空壳判断不拉整包）、**`jp_learn_upsert_user_app_data`**（服务端整包写入并放宽 `statement_timeout`）、并为 **`jp_learn_merge_payload_delta`** 合并同样放宽超时。未执行时客户端仍回退为旧行为（整包 select + REST upsert），大 payload 下仍可能报 `statement timeout`。
   6. `app/supabase/migrations/20260425120000_jp_learn_patch_lesson_payload.sql` — **可选但推荐**：新增 **`jp_learn_patch_lesson_payload`**，在已有云端整包的前提下，课文阅读里改 **标题 / 正文 / 时间戳** 可走 **2.5 秒防抖小补丁**（减轻整包重写）。未执行时应用静默跳过该 RPC，仍依赖整包与子树增量同步。  
      若已执行过上一文件，可再执行 **`app/supabase/migrations/20260426120000_jp_learn_patch_lesson_payload_extend.sql`**：`CREATE OR REPLACE` 同一函数，**扩展白名单**（分类、作者、行译、译文显隐、`lessonKind`、封面/音频/视频的 data URL 或 **MediaKey** 与 `videoSourceUrl`、`videoCues`、`trashedAt` 等）。仅跑 2512 而未跑 2612 时，客户端仍只会上传「旧三字段」子集，服务端不报错。
   7. `app/supabase/migrations/20260427120000_jp_learn_patch_vocab_card_payload.sql` — **可选**：**`jp_learn_patch_vocab_card_payload`**，词卡编辑 / SRS 进度可走 **2.5 秒防抖小补丁**（`term` / `kana` / `meanings` / 干扰项 / `mastery` / `reviewStage` / `nextReviewDay` / `reviewGraduated` 等）。未执行时静默跳过。
   8. `app/supabase/migrations/20260428120000_jp_learn_patch_sentence_and_grammar_task_payload.sql` — **可选**：**`jp_learn_patch_sentence_task_payload`** 与 **`jp_learn_patch_grammar_task_payload`**，句子题 / 语法题 **详情保存** 与 **练习 SRS** 可走防抖小补丁。未执行时静默跳过。
   9. `app/supabase/migrations/20260429120000_jp_learn_patch_lesson_note_and_favorite_sentence.sql` — **可选**：**`jp_learn_patch_lesson_note_payload`**（改笔记正文等）、**`jp_learn_patch_favorite_sentence_payload`**（改收藏句）；**新增/删除** 笔记或收藏句时应用仍走已有 **`jp_learn_merge_payload_delta`** 防抖整段子树合并。

10. （可选）**Authentication → URL configuration**：把将来 Vercel 的站点地址加入 **Redirect URLs**，避免邮件链接类场景被拦。

---

## 2. 本地开发自测（可选）

在 **`app/`** 目录下新建 `.env.local`（不要提交到 Git）：

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

然后 `cd app` → `npm run dev` → 浏览器打开应用 → **数据** 标签：注册 / 登录 → **上传到云端** / **从云端恢复**。弱网与多端验收步骤可打开同一站点下的 **`/qa`** 页面第二节照做。

---

## 3. GitHub 仓库（ShouzhiLPB / nihongo-nook）

本仓库地址：**[https://github.com/ShouzhiLPB/nihongo-nook](https://github.com/ShouzhiLPB/nihongo-nook)**。

1. 若你本机还没有关联远程，在**包含 `app` 子目录的项目根**执行（已有关联则跳过 `remote add`）：

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/ShouzhiLPB/nihongo-nook.git
   git push -u origin main
   ```

2. 若你另建了同名空仓库，把上面 `origin` 换成你的地址即可；**Vercel 里选中的仓库**须与推送目标一致，这样线上才会跟 GitHub 最新提交同步。

---

## 4. Vercel 部署

1. [https://vercel.com](https://vercel.com) → 用 GitHub 登录 → **Add New → Project** → 选中 **ShouzhiLPB/nihongo-nook**。
2. **Root Directory 必须填 `app`**（本仓库是 npm workspace：Next 应用在 `app/` 下；**不要留空**，否则 Vercel 可能当成静态站并在构建后找 **`public` 输出目录**，从而报错 `No Output Directory named "public" found`）。
3. **Settings → General**：**Framework Preset** 选 **Next.js**；**Output Directory** 保持默认/留空（**不要**填 `public`；Next 的构建产物在 **`app/.next`**）。若你曾把 Output Directory 改成过 `public`，请删掉该覆盖项再 **Redeploy**。
4. **Environment Variables** 添加与本地相同的两项，并按需增加增量开关：

   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - （可选，且需已执行上表第 3 条 SQL）`NEXT_PUBLIC_CLOUD_DELTA_NOTES_FAVS=1`：笔记 / 收藏句子树可与 `stats` 等同走 RPC（**不**含课文主数组；未跑 SQL 时不要开）。
   - （可选，且需已执行上表第 4 条 SQL）`NEXT_PUBLIC_CLOUD_DELTA_EXTENDED=1`：**含**笔记/收藏 + **课文 / 词卡 / 句题 / 语法题 / 聊天会话** 等主数组子树 RPC；未跑第 4 条时不要开。

5. **Deploy**。部署完成后把 Vercel 给的 **`https://xxx.vercel.app`** 发给朋友即可访问（免费额度内）。

### 4.1 你已经跑完迁移 SQL、也在 Vercel 里填好两个变量之后——还要不要做什么？

**怎么知道「这一版已经上线了」？**  
在 Vercel → **Deployments** 里打开最新一条，若 **Status** 为 **`Ready`**（且 **Environment** 为 **Production**），表示该次构建已成功部署；默认预览域名多为 **`https://nihongo-nook.vercel.app`**（与 Vercel 项目名一致时）；若绑了自定义域，以控制台显示为准。要让分享链接、OG 图等始终用自定义域，在 Vercel 环境变量里增加 **`NEXT_PUBLIC_SITE_URL`**（例如 `https://你的域名.com`，不要末尾斜杠），保存后 **Redeploy** 一次。

**强烈建议（不做的话，线上可能还用「没钥匙」的旧版本）：**

1. 打开 **Vercel** → 你的项目 → **Deployments** → 点最新一条右侧 **⋯** → **Redeploy**（重新部署）。  
   **原因**：环境变量是在构建/运行时才注入的；你若是**先部署、后加变量**，不点一次 Redeploy，网站有时还在用旧配置。

**建议顺手做（可选，但省以后踩坑）：**

2. **Supabase** → **Authentication** → **URL configuration** → **Redirect URLs**：把你的线上地址 **`https://你的项目.vercel.app`** 加进去并保存（若以后开「邮箱确认链接」之类，不会点链接报错）。
3. **增量上传开关**（可选）：你已执行过第 3、第 4 个 SQL 后，若希望「只改统计 / 只改课文」时少传整包，可在 Vercel 里按上文 §4 再加 **`NEXT_PUBLIC_CLOUD_DELTA_EXTENDED=1`**（并视需要 `NOTES_FAVS`）；**加完同样要 Redeploy**。第一次开 EXTENDED 前，建议先在数据页 **成功上传或同步一次**，让本机写好指纹包（见 §5 里「指纹包」一句）。

**验收（你自己 2 分钟点一下就行）：**

4. 浏览器打开 **线上地址** → **数据** 标签 → **注册 / 登录** → 点 **上传到云端** → 应出现成功提示；再点刷新或重进页面，**云端备份时间** 应有显示。

做到这里，**「云端仓库 + 网站连仓库」这条主干就闭环了**；没有强制要求的下一步，剩下都是「想更省流量 / 想多设备手测」的加分项。

---

## 5. 使用说明（当前能力）

- **上传到云端**：把当前浏览器里的学习数据（课文、词卡、题、统计等）打成一整包 JSON 写入你的 Supabase 行。
- **下载云端 JSON 副本**：不覆盖本机，直接拉取当前云端快照并触发浏览器下载（文件名含用户 id 与时间戳；内容为规范化后的缩进 JSON，便于与「导出本机 json」对照留档）。
- **从云端对齐**：弹层内 **三选一**（合并两边 / 以云端为准覆盖本机 / 以本机为准覆盖云端），并用**白话**列出情境提醒；**合并前摘要**会按 id 提示仅本机 / 仅云端 / 同 id 内容不同的条目，并支持 **关键词筛选 id**；对 **同 id 冲突** 可先 **JSON 对比**，再对每条冲突选 **本机 / 自动（时间戳较新）/ 云端** 整行锁定后点「合并两边」；**仅本机 / 仅云端 id**（单侧 JSON）与 **stats 不一致** 仍可点开 **规范化 JSON 只读双栏**；弹层内可 **复制左/右侧全文**（展示可能截断，复制为未截断原文；非字段级 patch、非全文业务 diff）。覆盖云端前会有**二次确认**。请先 **导出 json 备份**再操作。
- 单条 JSON 若含很大的课文配图 `data URL`，体积会膨胀；客户端已对媒体做 **`mediaLibrary` 去重**（见 `PROJECT_PLAN` i2-3）；自动同步在仅 **`stats`** 变化时可走 **RPC 增量**（需执行上表第 2 个 SQL）。在已执行第 3 个 SQL 且设置 **`NEXT_PUBLIC_CLOUD_DELTA_NOTES_FAVS=1`** 时，**仅笔记/收藏句**变化也可走 RPC。在已执行第 4 个 SQL 且设置 **`NEXT_PUBLIC_CLOUD_DELTA_EXTENDED=1`** 时，**课文 / 词卡 / 题库 / 聊天** 等主数组单独变化也可走 RPC（指纹包需经一次成功同步写入全量子树字段）。若遇写入失败，可先导出备份、删图后再上传。

---

## 6. i2 还要几轮？两轮能全部做完吗？

**不能指望「任意固定 2 次开发迭代 = i2 表格里所有余量清零」。** 仓库里 **MVP 已含**：Supabase 整包 upsert、**`jp_learn_merge_payload_delta` RPC**（在已执行迁移并开对 `NEXT_PUBLIC_CLOUD_*` 时）、本机 **指纹包 + 自动同步**、**三选一合并**与 **id 级合并摘要**、Vitest 云模块单测、CI 先 **`npm run verify`** 再 E2E。

仍写在 **`docs/PROJECT_PLAN.md` §17.2 表格「余量」**里的**增强项**（例如 **单字段级服务端 patch**、**全文 redline 式 diff**、**云真机农场自动化** 等）与「能稳定备份、能对齐、能合并」不是一回事；后者在代码里已较完整，增强项通常仍要 **多轮** 迭代。细则见 **`PROJECT_PLAN.md` §17.4、§17.5**。

---

## 7. 遇到问题

- 登录正常但上传报错 **relation does not exist**：说明未执行第 1 步里的 SQL。
- **RLS / permission**：确认已用当前账号登录，且 SQL 里的 policy 已执行。
- **线上站像「很老的版本」**：多半是 **Vercel 连的 GitHub 仓库里代码不是最新的**——在电脑上 `git push` 后再 Redeploy；本地 `localhost:3000` 跑得新，不代表线上自动更新。
- **线上登录后结构是空的 / 一点覆盖就变空**：**正常情况下的常见误操作**——`localhost:3000` 与 `xxx.vercel.app` 是**两个不同网站**，浏览器存的**本机数据各算各的**；你在 localhost 上传过云端，云端里**有**数据，但若在**空的**线上站点了「**以本机为准（覆盖云端）**」，等于用**空壳**把云端**冲掉**了。恢复办法：若旧电脑或 localhost 里还有数据，在那里**导出 JSON** 再导入到线上，或从旧环境再**上传**一次。应用里已对「本机核心数据条数为 0 但云端有内容」时增加**二次危险确认**（见 `CloudAuthPanel`）。
- **先「以云端为准覆盖本机」再上传，仍然全空**：说明此时 **Supabase 里这份账号的备份已经是空的**（例如先前用空本机覆盖过云端）。「从云端对齐」只是把**当前云端**写回本机，**不会凭空变出**旧数据；要恢复只能依赖 **localhost 或其它设备上未丢的导出 JSON**，或 Supabase 若曾开过**自动备份/回滚**（免费层通常没有「按时间点恢复」按钮，需你方运维策略）。
- **自动同步「没动静」**：若本机课文/词卡等全空而云端尚有资料，应用会**故意不上传**以免冲掉云端；请先「以云端为准」或导入 JSON。仅 **stats** 变化时仍可对云端做 RPC（在已开增量且指纹就绪时）。
- 更细的迭代记录：**`docs/PROJECT_PLAN.md`**（**§17** 云增量 / i2 余量、**Iteration 23-cloud**）。
