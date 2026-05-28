import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AiInsight,
  Answer,
  AnswerStatus,
  CaseDraft,
  DifferentialResult,
  NewQuestionPayload,
  Participant,
  Question,
  QuestionSource,
  Session,
  SessionSnapshot,
  Suggestion,
  SuggestionStatus
} from "../../shared/types.js";

const now = () => new Date().toISOString();

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class AppDatabase {
  private db: Database.Database;
  private _s = {} as Record<string, Database.Statement>;

  constructor(path = process.env.DATABASE_PATH ?? "./data/wenzhen.sqlite") {
    const dbPath = resolve(path);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this._prep();
  }

  private _prep() {
    const p = this.db.prepare.bind(this.db);
    this._s = {
      insSess:       p(`INSERT INTO sessions (id,code,chiefParticipantId,status,createdAt,expiresAt) VALUES (?,?,?,'created',?,?)`),
      selSess:       p(`SELECT * FROM sessions WHERE code = ?`),
      updSessInit:   p(`UPDATE sessions SET suspectedDisease=?,chiefComplaint=?,backgroundSummary=?,status='interviewing' WHERE id=?`),
      markSum:       p(`UPDATE sessions SET status='summarized' WHERE code=?`),
      insPar:        p(`INSERT INTO participants (id,sessionId,nickname,role,color,lastSeenAt) VALUES (?,?,?,?,?,?)`),
      selPar:        p(`SELECT * FROM participants WHERE sessionId=? ORDER BY role DESC,lastSeenAt DESC`),
      updParSeen:    p(`UPDATE participants SET lastSeenAt=? WHERE id=?`),
      insQue:        p(`INSERT INTO questions (id,sessionId,source,status,text,recommendedWording,meaning,positiveMeaning,negativeMeaning,optionsJson,relatedDifferentialsJson,sortOrder,createdAt) VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)`),
      selQue:        p(`SELECT * FROM questions WHERE sessionId=? ORDER BY sortOrder ASC`),
      updQueSt:      p(`UPDATE questions SET status=? WHERE id=?`),
      maxSort:       p(`SELECT COALESCE(MAX(sortOrder),0) as sortOrder FROM questions WHERE sessionId=?`),
      insAns:        p(`INSERT INTO answers (id,questionId,sessionId,status,note,answeredBy,updatedAt) VALUES (?,?,?,?,?,?,?) ON CONFLICT(questionId) DO UPDATE SET status=excluded.status,note=excluded.note,answeredBy=excluded.answeredBy,updatedAt=excluded.updatedAt`),
      selAns:        p(`SELECT * FROM answers WHERE sessionId=? ORDER BY updatedAt DESC`),
      insSug:        p(`INSERT INTO suggestions (id,sessionId,participantId,text,reason,status,createdAt,resolvedAt) VALUES (?,?,?,?,?,'pending',?,NULL)`),
      selSug:        p(`SELECT suggestions.*,participants.nickname as participantNickname FROM suggestions JOIN participants ON participants.id=suggestions.participantId WHERE suggestions.sessionId=? ORDER BY suggestions.createdAt DESC`),
      updSugRes:     p(`UPDATE suggestions SET status=?,resolvedAt=? WHERE id=? AND sessionId=?`),
      selSugById:    p(`SELECT * FROM suggestions WHERE id=?`),
      insInsight:    p(`INSERT INTO ai_insights (id,sessionId,type,inputSummary,outputJson,createdAt) VALUES (?,?,?,?,?,?)`),
      selInsight:    p(`SELECT outputJson FROM ai_insights WHERE sessionId=? AND type=? ORDER BY createdAt DESC LIMIT 1`),
      codeExists:    p(`SELECT id FROM sessions WHERE code=?`),
    };
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, chiefParticipantId TEXT NOT NULL,
        suspectedDisease TEXT NOT NULL DEFAULT '', chiefComplaint TEXT NOT NULL DEFAULT '',
        backgroundSummary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL, role TEXT NOT NULL, color TEXT NOT NULL, lastSeenAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL, recommendedWording TEXT NOT NULL,
        meaning TEXT NOT NULL, positiveMeaning TEXT NOT NULL, negativeMeaning TEXT NOT NULL,
        optionsJson TEXT NOT NULL, relatedDifferentialsJson TEXT NOT NULL, sortOrder INTEGER NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY, questionId TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, status TEXT NOT NULL,
        note TEXT NOT NULL, answeredBy TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(questionId));
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        participantId TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE, text TEXT NOT NULL,
        reason TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, resolvedAt TEXT);
      CREATE TABLE IF NOT EXISTS ai_insights (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL, inputSummary TEXT NOT NULL, outputJson TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_questions_session_sort ON questions(sessionId,sortOrder);
      CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(sessionId);
      CREATE INDEX IF NOT EXISTS idx_suggestions_session ON suggestions(sessionId,createdAt);
      CREATE INDEX IF NOT EXISTS idx_ai_insights_session_type ON ai_insights(sessionId,type,createdAt);
    `);
  }

  createSession() {
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const sessionId = id("ses");
    const participantId = id("par");
    let code = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      code = crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
      if (!this._s.codeExists.get(code)) break;
    }
    const tx = this.db.transaction(() => {
      this._s.insSess.run(sessionId, code, participantId, createdAt, expiresAt);
      this._s.insPar.run(participantId, sessionId, "主问诊人", "chief", "#0f766e", createdAt);
    });
    tx();
    return this.snapshotByCode(code, participantId);
  }

  joinSession(code: string, nickname: string) {
    const session = this.getSessionByCode(code);
    this.assertActive(session);
    const pid = id("par");
    const nick = nickname.trim() || `成员${Math.floor(Math.random() * 90 + 10)}`;
    const color = ["#2563eb","#7c3aed","#c2410c","#15803d","#be123c"][Math.floor(Math.random() * 5)];
    this._s.insPar.run(pid, session.id, nick, "assistant", color, now());
    return this.snapshotByCode(code, pid);
  }

  initializeSession(code: string, payload: { suspectedDisease: string; chiefComplaint: string; backgroundSummary: string }) {
    const session = this.getSessionByCode(code);
    this.assertActive(session);
    this._s.updSessInit.run(payload.suspectedDisease, payload.chiefComplaint, payload.backgroundSummary, session.id);
    return this.getSessionByCode(code);
  }

  addQuestions(sessionId: string, questions: NewQuestionPayload[], source: QuestionSource) {
    const { sortOrder: base } = this._s.maxSort.get(sessionId) as { sortOrder: number };
    const createdAt = now();
    const tx = this.db.transaction(() => {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        this._s.insQue.run(id("que"), sessionId, source,
          q.text, q.recommendedWording, q.meaning, q.positiveMeaning, q.negativeMeaning,
          json(q.options), json(q.relatedDifferentials), base + i + 1, createdAt);
      }
    });
    tx();
    const rows = this.db.prepare(
      `SELECT * FROM questions WHERE sessionId=? AND createdAt=? ORDER BY sortOrder ASC`
    ).all(sessionId, createdAt) as any[];
    return rows.map((r) => this.questionFromRow(r));
  }

  updateAnswer(code: string, participantId: string, questionId: string, status: AnswerStatus, note: string) {
    const session = this.getSessionByCode(code);
    this.assertChief(session, participantId);
    const updatedAt = now();
    this._s.insAns.run(id("ans"), questionId, session.id, status, note, participantId, updatedAt);
    this._s.updQueSt.run(status === "not_asked" ? "pending" : "answered", questionId);
    return this.snapshotByCode(code, participantId);
  }

  skipQuestion(code: string, participantId: string, questionId: string) {
    const session = this.getSessionByCode(code);
    this.assertChief(session, participantId);
    this._s.updQueSt.run("skipped", questionId);
    return this.snapshotByCode(code, participantId);
  }

  addSuggestion(code: string, participantId: string, text: string, reason: string) {
    const session = this.getSessionByCode(code);
    this.assertActive(session);
    this._s.insSug.run(id("sug"), session.id, participantId, text, reason, now());
    return { id: id("sug"), sessionId: session.id, participantId, text, reason, status: "pending" as const, createdAt: now(), resolvedAt: null };
  }

  resolveSuggestion(code: string, participantId: string, suggestionId: string, status: SuggestionStatus) {
    const session = this.getSessionByCode(code);
    this.assertChief(session, participantId);
    this._s.updSugRes.run(status, now(), suggestionId, session.id);
    const suggestion = this._s.selSugById.get(suggestionId) as Suggestion | undefined;
    if (status === "accepted" && suggestion) {
      this.addQuestions(session.id, [{
        text: suggestion.text,
        recommendedWording: suggestion.text,
        meaning: suggestion.reason || "由辅助问诊人提出，用于补充当前问诊线索。",
        positiveMeaning: "阳性结果提示该方向需要进一步澄清。",
        negativeMeaning: "阴性结果可降低相关方向的可能性，但不能单独排除。",
        options: ["阳性","阴性","不详","待确认"],
        relatedDifferentials: ["辅助建议"]
      }], "assistant");
    }
    return this.snapshotByCode(code, participantId);
  }

  saveInsight(sessionId: string, type: AiInsight["type"], inputSummary: string, outputJson: unknown) {
    this._s.insInsight.run(id("ins"), sessionId, type, inputSummary, json(outputJson), now());
    return { id: id("ins"), sessionId, type, inputSummary, outputJson: json(outputJson), createdAt: now() };
  }

  markSummarized(code: string) { this._s.markSum.run(code); }

  snapshotByCode(code: string, participantId?: string): SessionSnapshot {
    const session = this.getSessionByCode(code);
    this.assertActive(session, true);
    const participants = this._s.selPar.all(session.id) as Participant[];
    const answerRows = this._s.selAns.all(session.id) as Answer[];
    const suggestionRows = this._s.selSug.all(session.id) as Suggestion[];
    const questionRows = this._s.selQue.all(session.id) as any[];
    const questions = questionRows.map((r) => this.questionFromRow(r));
    const latestDifferential = this.latestInsight<DifferentialResult>(session.id, "differential");
    const latestCaseDraft = this.latestInsight<CaseDraft>(session.id, "case_draft");
    return {
      session,
      participant: participantId ? participants.find((p) => p.id === participantId) : undefined,
      participants, questions, answers: answerRows, suggestions: suggestionRows,
      latestDifferential, latestCaseDraft,
    };
  }

  getSessionByCode(code: string): Session {
    const session = this._s.selSess.get(code.toUpperCase()) as Session | undefined;
    if (!session) throw Object.assign(new Error("会话不存在。"), { statusCode: 404 });
    return session;
  }

  touchParticipant(participantId: string) { this._s.updParSeen.run(now(), participantId); }

  exportMarkdown(code: string) {
    const snap = this.snapshotByCode(code);
    const byQ = new Map(snap.answers.map((a) => [a.questionId, a]));
    const rows = snap.questions.map((q, i) => {
      const a = byQ.get(q.id);
      return `${i+1}. ${q.text}\n   - 状态：${a?.status ?? "not_asked"}\n   - 记录：${a?.note || "无"}`;
    }).join("\n");
    const draft = snap.latestCaseDraft;
    const diff = snap.latestDifferential;
    return `# 问诊总结 ${snap.session.code}

> 学习用途内容，不作为诊断或治疗依据。

## 病例摘要
- 怀疑疾病：${snap.session.suspectedDisease || "未填写"}
- 主要症状：${snap.session.chiefComplaint || "未填写"}
- 背景摘要：${snap.session.backgroundSummary || "未填写"}

## 问诊记录
${rows || "暂无记录"}

## 病历草稿
${draft ? draft.historyOfPresentIllness : "尚未生成"}

## 鉴别诊断
${diff ? diff.differentials.map((item) => `- ${item.disease}：支持 ${item.supportingFindings.join("、") || "待补充"}；反对 ${item.opposingFindings.join("、") || "待补充"}`).join("\n") : "尚未生成"}`;
  }

  private assertActive(s: Session, allowSummarized = false) {
    if (new Date(s.expiresAt).getTime() < Date.now())
      throw Object.assign(new Error("会话已过期。"), { statusCode: 410 });
    if (!allowSummarized && s.status === "expired")
      throw Object.assign(new Error("会话已过期。"), { statusCode: 410 });
  }

  private assertChief(s: Session, participantId: string) {
    this.assertActive(s);
    if (s.chiefParticipantId !== participantId)
      throw Object.assign(new Error("只有主问诊人可以执行该操作。"), { statusCode: 403 });
  }

  private latestInsight<T>(sessionId: string, type: AiInsight["type"]): T | undefined {
    const row = this._s.selInsight.get(sessionId, type) as { outputJson: string } | undefined;
    return row ? parseJson<T>(row.outputJson, undefined as T) : undefined;
  }

  private questionFromRow(row: any): Question {
    return {
      id: row.id, sessionId: row.sessionId, source: row.source, status: row.status,
      text: row.text, recommendedWording: row.recommendedWording,
      meaning: row.meaning, positiveMeaning: row.positiveMeaning, negativeMeaning: row.negativeMeaning,
      options: parseJson<string[]>(row.optionsJson, []),
      relatedDifferentials: parseJson<string[]>(row.relatedDifferentialsJson, []),
      sortOrder: row.sortOrder, createdAt: row.createdAt,
    };
  }
}
