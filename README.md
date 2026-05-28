# 问诊助手

面向临床示教课的匿名协作问诊 Web 应用。主问诊人创建会话并记录正式问诊，辅助问诊人通过分享码加入并提交建议追问；系统可生成学习用途的下一问、鉴别诊断和中文病历草稿。

## 功能

- 匿名 6 位分享码会话，默认 7 天过期。
- 主问诊人/辅助问诊人权限隔离。
- SQLite 持久化会话、参与者、问题、答案、建议和 AI 结果。
- Socket.IO 房间广播，实时同步建议、答案和总结。
- 手机号、身份证号、住院号/病案号、详细地址基础拦截。
- AI 功能只调用配置的模型服务；未配置 API Key 或模型返回异常时会直接报错，不使用本地模板。
- 配置 `OPENAI_API_KEY` 后由后端调用 OpenAI 兼容 API，密钥不进入前端。

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

开发地址：`http://localhost:5173`

## 生产构建

```bash
npm run build
npm start
```

生产服务默认监听 `http://localhost:4000`，并直接托管 `dist/client`。

## 环境变量

- `PORT`：后端端口，默认 `4000`
- `HOST`：监听地址，默认 `0.0.0.0`
- `DATABASE_PATH`：SQLite 文件路径，默认 `./data/wenzhen.sqlite`
- `CLIENT_ORIGIN`：开发期前端来源，默认 `http://localhost:5173`
- `DEEPSEEK_API_KEY`：可选，启用 DeepSeek 真实 AI 生成
- `DEEPSEEK_BASE_URL`：默认 `https://api.deepseek.com`
- `DEEPSEEK_MODEL`：默认 `deepseek-v4-pro`
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`：可选，其他 OpenAI 兼容服务；设置后优先生效

## 安全边界

本项目仅用于临床教学训练，不提供诊疗建议、处方建议或治疗方案。请勿录入真实姓名、住院号、身份证号、手机号、详细住址等可识别身份信息。
