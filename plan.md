# 问诊助手 MVP 方案

## Summary

开发一个面向临床示教课的响应式网页应用，核心场景是床旁问诊：同组同学通过匿名会话实时协作，主问诊人按系统化问诊流程快速记录信息，辅助问诊人实时补充建议，由 AI 生成追问建议、问题和答案的临床意义、鉴别诊断思路和模板化病历草稿。

第一版技术栈：

- 前端：`Vite + React + TypeScript`
- 后端：`Node.js + Fastify + Socket.IO`
- 数据库：`SQLite`
- AI：后端调用 OpenAI 兼容 API，API Key 仅保存在服务端环境变量中
- 部署形态：本地或局域网可运行的 Web 应用，后续可扩展为云端部署

## Product Scope

第一版优先解决示教课现场的四个问题：

- 不知道接下来该问什么：根据怀疑疾病、主要症状和已获得信息生成下一步问诊问题。
- 不知道问题和答案的意义：每个 AI 建议问题都附带“为什么问”“阳性/阴性结果意味着什么”。
- 小组信息不同步：通过匿名分享码让同组成员进入同一问诊会话，实时查看记录并提出建议。
- 不知道如何整理病历：问诊结束后生成结构化病历草稿、初步诊断思路、鉴别诊断表和缺漏清单。

第一版不做：

- 不提供诊疗建议、处方建议或治疗方案。
- 不保存患者姓名、住院号、身份证号、手机号等可识别身份信息。
- 不做账号体系、班级管理、教师后台和长期学习档案。

## User Roles

### 主问诊人

主问诊人是当前会话的主要操作者，默认由创建会话的人担任。

权限：

- 创建问诊会话并获得分享码。
- 输入怀疑疾病、主要症状和病例背景。
- 查看 AI 生成的标准问诊问题。
- 记录每个问题的答案。
- 采纳、忽略或标记辅助问诊人的建议问题。
- 触发生成下一问、鉴别诊断和病历草稿。

### 辅助问诊人

辅助问诊人通过分享码加入会话。

权限：

- 实时查看问诊进展、已记录答案和 AI 提示。
- 提交建议追问。
- 查看主问诊人对建议的处理状态。

限制：

- 不能直接修改主问诊人的正式问诊记录。
- 不能触发最终病历生成，避免多人同时操作导致状态混乱。

## Core Workflow

1. 创建会话
   - 用户点击“创建问诊会话”。
   - 系统生成 6 位分享码，默认 7 天后过期。
   - 创建者自动成为主问诊人。

2. 初始化病例
   - 主问诊人输入怀疑疾病、主要症状和可选背景信息。
   - 系统提示不得录入真实姓名、住院号、身份证号、手机号等敏感信息。

3. AI 生成首轮问诊问题
   - 后端将脱敏后的病例摘要发送给 AI。
   - AI 返回一组按标准问诊顺序排列的问题。
   - 每个问题包含：问题文本、推荐问法、预设答案选项、问题意义、阳性/阴性结果提示、相关鉴别诊断点。

4. 逐步问诊和记录
   - 主问诊人逐个处理问题。
   - 每个问题支持选择状态：未问、阳性、阴性、不详、待确认。
   - 可补充短文本记录，例如诱因、持续时间、程度、伴随症状、缓解因素。
   - 点击“下一步”后，系统基于当前答案生成下一批问题或进入总结阶段。

5. 小组协作
   - 辅助问诊人可提交建议追问。
   - 建议追问实时显示给主问诊人。
   - 主问诊人可选择采纳、忽略或标记稍后问。
   - 被采纳的问题进入正式问诊队列，显示提示信息并同步给所有成员。

6. 生成结果
   - 问诊结束后，主问诊人点击“完成问诊”。
   - 系统生成初步诊断、结构化病历（主问诊人可在线修改）、初步诊断和治疗思路

## Main Screens

### 会话创建页

- 创建新会话。
- 输入分享码加入已有会话。
- 展示隐私提醒和学习用途声明。

### 问诊工作台

响应式布局：

- 桌面端：左侧问诊队列，中间当前问题和记录区，右侧协作建议与 AI 解释。
- 手机端：使用分段标签切换“当前问题 / 记录 / 建议 / 总结”。

关键模块：

- 病例摘要栏：怀疑疾病、主要症状、问诊进度。
- 当前问题卡片：问题、推荐问法、问题意义、答案选项、备注输入。
- 已问记录列表：按问诊顺序展示所有问题和答案。
- 辅助建议区：显示同组成员提出的建议追问及处理状态。
- AI 提示区：显示下一问建议、鉴别诊断线索、缺漏提醒。

### 结果页

- 病历草稿。
- 初步诊断思路。
- 鉴别诊断表。
- 缺漏清单。
- Markdown 导出按钮。

## API Design

### REST API

- `POST /api/sessions`
  - 创建匿名问诊会话。
  - 返回会话码、主问诊人标识、过期时间。

- `GET /api/sessions/:code`
  - 获取会话信息、参与者、当前问诊状态、已记录事实和建议问题。

- `POST /api/sessions/:code/initialize`
  - 提交怀疑疾病、主要症状和病例背景。
  - 后端先做隐私信息检测，再保存脱敏摘要。

- `POST /api/ai/next-questions`
  - 根据病例摘要、已问问题和已记录答案生成下一批问题。

- `POST /api/ai/differential`
  - 根据当前结构化事实生成鉴别诊断表。

- `POST /api/ai/case-draft`
  - 根据完整问诊记录生成病历草稿。

- `GET /api/sessions/:code/export.md`
  - 导出 Markdown 病历和问诊总结。

### WebSocket Events

- `session:join`
  - 加入会话并广播在线状态。

- `question:created`
  - 新问题进入正式问诊队列。

- `answer:updated`
  - 主问诊人更新问题答案。

- `suggestion:created`
  - 辅助问诊人提交建议追问。

- `suggestion:resolved`
  - 主问诊人采纳、忽略或延后建议。

- `ai:insight-created`
  - AI 生成新的解释、追问或诊断思路。

- `presence:updated`
  - 同步成员在线状态。

## Data Model

### Session

- `id`
- `code`
- `chiefParticipantId`
- `suspectedDisease`
- `chiefComplaint`
- `backgroundSummary`
- `status`: `created | initialized | interviewing | summarized | expired`
- `createdAt`
- `expiresAt`

### Participant

- `id`
- `sessionId`
- `nickname`
- `role`: `chief | assistant`
- `color`
- `lastSeenAt`

### Question

- `id`
- `sessionId`
- `source`: `ai | assistant | manual`
- `status`: `pending | answered | skipped`
- `text`
- `recommendedWording`
- `meaning`
- `positiveMeaning`
- `negativeMeaning`
- `relatedDifferentials`
- `sortOrder`
- `createdAt`

### Answer

- `id`
- `questionId`
- `sessionId`
- `status`: `not_asked | positive | negative | unknown | uncertain`
- `note`
- `answeredBy`
- `updatedAt`

### Suggestion

- `id`
- `sessionId`
- `participantId`
- `text`
- `reason`
- `status`: `pending | accepted | ignored | later`
- `createdAt`
- `resolvedAt`

### AiInsight

- `id`
- `sessionId`
- `type`: `next_questions | differential | case_draft | gap_check`
- `inputSummary`
- `outputJson`
- `createdAt`

## AI Output Requirements

AI 返回必须使用结构化 JSON，后端负责校验和降级处理。

下一问输出字段：

- `questions`
  - `text`
  - `recommendedWording`
  - `meaning`
  - `positiveMeaning`
  - `negativeMeaning`
  - `options`
  - `relatedDifferentials`

鉴别诊断输出字段：

- `primaryImpression`
- `differentials`
  - `disease`
  - `supportingFindings`
  - `opposingFindings`
  - `questionsToClarify`
- `missingInformation`

病历草稿输出字段：

- `chiefComplaint`
- `historyOfPresentIllness`
- `pastHistory`
- `personalHistory`
- `maritalMenstrualOrObstetricHistory`
- `familyHistory`
- `physicalExamPlaceholder`
- `auxiliaryExamPlaceholder`
- `assessment`
- `differentialDiagnosis`
- `missingInformation`
- `disclaimer`

## Privacy And Safety

- 前端展示明确提示：禁止录入真实姓名、住院号、身份证号、手机号、详细住址等身份信息。
- 后端对常见手机号、身份证号、住院号格式做基础拦截。
- AI 请求只发送脱敏后的结构化事实，不发送参与者昵称、会话码或其他无关信息。
- 所有 AI 生成内容必须包含学习用途声明，不作为诊断或治疗依据。
- 会话默认 7 天过期；过期后不允许访问。

## Acceptance Criteria

- 用户可以在 1 分钟内创建会话并让同组成员加入。
- 主问诊人可以按 AI 生成的问题逐步记录答案。
- 辅助问诊人可以实时提交建议，且不能直接篡改正式记录。
- 系统能基于问诊记录生成可复制的中文病历草稿。
- 系统能生成至少 3 个鉴别诊断，并列出支持点、反对点和待补充信息。
- 输入明显手机号或身份证号时，系统会拦截并提示删除敏感信息。

## Assumptions


- 使用者会主动避免录入可识别患者身份的信息，系统只做基础防护，不承诺满足医疗级合规要求。
- 初始问诊能力主要依赖 AI 动态生成，不先维护完整疾病知识库。
- 后续可扩展课程资料上传、教师点评、长期学习档案和更多系统疾病模板。
