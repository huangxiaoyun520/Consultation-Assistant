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
  ParticipantRole,
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

  constructor(path = process.env.DATABASE_PATH ?? "./data/wenzhen.sqlite") {
    const dbPath = resolve(path);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        chiefParticipantId TEXT NOT NULL,
        suspectedDisease TEXT NOT NULL DEFAULT '',
        chiefComplaint TEXT NOT NULL DEFAULT '',
        backgroundSummary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        role TEXT NOT NULL,
        color TEXT NOT NULL,
        lastSeenAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        recommendedWording TEXT NOT NULL,
        meaning TEXT NOT NULL,
        positiveMeaning TEXT NOT NULL,
        negativeMeaning TEXT NOT NULL,
        optionsJson TEXT NOT NULL,
        relatedDifferentialsJson TEXT NOT NULL,
        sortOrder INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY,
        questionId TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        note TEXT NOT NULL,
        answeredBy TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(questionId)
      );
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        participantId TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        resolvedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS ai_insights (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        inputSummary TEXT NOT NULL,
        outputJson TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_questions_session_sort ON questions(sessionId, sortOrder);
      CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(sessionId);
      CREATE INDEX IF NOT EXISTS idx_suggestions_session ON suggestions(sessionId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_ai_insights_session_type ON ai_insights(sessionId, type, createdAt);
    `);
  }

  createSession() {
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const sessionId = id("ses");
    const participantId = id("par");
    let code = "";
    for (let i = 0; i < 10; i += 1) {
      code = Math.random().toString(36).slice(2, 8).toUpperCase();
      const exists = this.db.prepare("SELECT id FROM sessions WHERE code = ?").get(code);
      if (!exists) break;
    }

    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, code, chiefParticipantId, status, createdAt, expiresAt)
           VALUES (@id, @code, @chiefParticipantId, 'created', @createdAt, @expiresAt)`
        )
        .run({ id: sessionId, code, chiefParticipantId: participantId, createdAt, expiresAt });
      this.db
        .prepare(
          `INSERT INTO participants (id, sessionId, nickname, role, color, lastSeenAt)
           VALUES (@id, @sessionId, @nickname, 'chief', @color, @lastSeenAt)`
        )
        .run({
          id: participantId,
          sessionId,
          nickname: "主问诊人",
          color: "#0f766e",
          lastSeenAt: createdAt
        });
    });
    create();
    return this.snapshotByCode(code, participantId);
  }

  joinSession(code: string, nickname: string) {
    const session = this.getSessionByCode(code);
    this.assertActive(session);
    const participant: Participant = {
      id: id("par"),
      sessionId: session.id,
      nickname: nickname.trim() || `成员${Math.floor(Math.random() * 90 + 10)}`,
      role: "assistant",
      color: ["#2563eb", "#7c3aed", "#c2410c", "#15803d", "#be123c"][Math.floor(Math.random() * 5)],
      lastSeenAt: now()
    };
    this.db
      .prepare(
        `INSERT INTO participants (id, sessionId, nickname, role, color, lastSeenAt)
         VALUES (@id, @sessionId, @nickname, @role, @color, @lastSeenAt)`
      )
      .run(participant);
    return this.snapshotByCode(code, participant.id);
  }

  initializeSession(code: string, payload: { suspectedDisease: string; chiefComplaint: string; backgroundSummary: string }) {
    const session = this.getSessionByCode(code);
    this.assertActive(session);
    this.db
      .prepare(
        `UPDATE sessions
         SET suspectedDisease = ?, chiefComplaint = ?, backgroundSummary = ?, status = 'interviewing'
         WHERE id = ?`
      )
      .run(payload.suspectedDisease, payload.chiefComplaint, payload.backgroundSummary, session.id);
    return this.getSessionByCode(code);
  }

  addQuestions(sessionId: string, questions: NewQuestionPayload[], source: QuestionSource) {
    const currentMax = this.db
      .prepare("SELECT COALESCE(MAX(sortOrder), 0) as sortOrder FROM questions WHERE sessionId = ?")
      .get(sessionId) as { sortOrder: number };
    const createdAt = now();
    const insert = this.db.prepare(
      `INSERT INTO questions
       (id, sessionId, source, status, text, recommendedWording, meaning, positiveMeaning, negativeMeaning,
        optionsJson, relatedDifferentialsJson, sortOrder, createdAt)
       VALUES
       (@id, @sessionId, @source, 'pending', @text, @recommendedWording, @meaning, @positiveMeaning, @negativeMeaning,
        @optionsJson, @relatedDifferentialsJson, @sortOrder, @createdAt)`
    );
    const rows = questions.map((question, index) => ({
      id: id("que"),
      sessionId,
      source,
      text: question.text,
      recommendedWording: question.recommendedWording,
      meaning: question.meaning,
      positiveMeaning: question.positiveMeaning,
      negativeMeaning: question.negativeMeaning,
      optionsJson: json(question.options),
      relatedDifferentialsJson: json(question.relatedDifferentials),
      sortOrder: currentMax.sortOrder + index + 1,
      createdAt
    }));
    this.db.transaction((items) => {
      for (const item of items) insert.run(item);
    })(rows);
    return rows.map((row) => this.questionFromRow(row));
  }

  updateAnswer(code: string, participantId: string, questionId: string, status: AnswerStatus, note: string) {
    const session = this.getSessionByCode(code);
    this.assertChief(session, participantId);
    const updatedAt = now();
    const answerId = id("ans");
    this.db
      .prepare(
        `INSERT INTO answers (id, questionId, sessionId, status, note, answeredBy, updatedAt)
         VALUES (@id, @questionId, @sessionId, @status, @note, @answeredBy, @updatedAt)
         ON CONFLICT(questionId) DO UPDATE SET
           status = excluded.status,
           note = excluded.note,
           answeredBy = excluded.answeredBy,
           updatedAt = excluded.updatedAt`
      )
      .run({ id: answerId, questionId, sessionId: session.id, status, note, answeredBy: participantId, updatedAt });
    this.db.prepare("UPDATE questions SET status = ? WHERE id = ?").run(status === "not_asked" ? "pending" : "answered", questionId);
    return this.snapshotByCode(code, participantId);
  }

  skipQuestion(code: string, participantId: string, questionId: string) {
    const session = this.getSessionByCode(code);
    this.assertChief(session, participantId);
    this.db.prepare("UPDATE questions SET status = 'skipped' WHERE id = ? AND sessionId = ?").run(questionId, session.id);
    return this.snapshotByCode(code, participantId);
  }

  addSuggestion(code: string, participantId: string, text: string, reason: string) {
    const session = this.getSessionByCode(code);
    this.assertActive(session);
    const suggestion = {
      id: id("sug"),
      sessionId: session.id,
      participantId,
      text,
      reason,
      status: "pending",
      createdAt: now(),
      resolvedAt: null
    };
    this.db
      .prepare(
        `INSERT INTO suggestions (id, sessionId, participantId, text, reason, status, createdAt, resolvedAt)
         VALUES (@id, @sessionId, @participantId, @text, @reason, @status, @createdAt, @resolvedAt)`
      )
      .run(suggestion);
    return suggestion;
  }

  resolveSuggestion(code: string, participantId: string, suggestionId: string, status: SuggestionStatus) {
    const session = this.getSessionByCode(code);
    this.assertChief(session, participantId);
    this.db
      .prepare("UPDATE suggestions SET status = ?, resolvedAt = ? WHERE id = ? AND sessionId = ?")
      .run(status, now(), suggestionId, session.id);
    const suggestion = this.db.prepare("SELECT * FROM suggestions WHERE id = ?").get(suggestionId) as Suggestion;
    if (status === "accepted" && suggestion) {
      this.addQuestions(
        session.id,
        [
          {
            text: suggestion.text,
            recommendedWording: suggestion.text,
            meaning: suggestion.reason || "由辅助问诊人提出，用于补充当前问诊线索。",
            positiveMeaning: "阳性结果提示该方向需要进一步澄清。",
            negativeMeaning: "阴性结果可降低相关方向的可能性，但不能单独排除。",
            options: ["阳性", "阴性", "不详", "待确认"],
            relatedDifferentials: ["辅助建议"]
          }
        ],
        "assistant"
      );
    }
    return this.snapshotByCode(code, participantId);
  }

  saveInsight(sessionId: string, type: AiInsight["type"], inputSummary: string, outputJson: unknown) {
    const insight = {
      id: id("ins"),
      sessionId,
      type,
      inputSummary,
      outputJson: json(outputJson),
      createdAt: now()
    };
    this.db
      .prepare(
        `INSERT INTO ai_insights (id, sessionId, type, inputSummary, outputJson, createdAt)
         VALUES (@id, @sessionId, @type, @inputSummary, @outputJson, @createdAt)`
      )
      .run(insight);
    return insight;
  }

  markSummarized(code: string) {
    this.db.prepare("UPDATE sessions SET status = 'summarized' WHERE code = ?").run(code);
  }

  snapshotByCode(code: string, participantId?: string): SessionSnapshot {
    const session = this.getSessionByCode(code);
    this.assertActive(session, true);
    const participants = this.db.prepare("SELECT * FROM participants WHERE sessionId = ? ORDER BY role DESC, lastSeenAt DESC").all(session.id) as Participant[];
    const questions = (this.db.prepare("SELECT * FROM questions WHERE sessionId = ? ORDER BY sortOrder ASC").all(session.id) as any[]).map((row) =>
      this.questionFromRow(row)
    );
    const answers = this.db.prepare("SELECT * FROM answers WHERE sessionId = ? ORDER BY updatedAt DESC").all(session.id) as Answer[];
    const suggestions = this.db
      .prepare(
        `SELECT suggestions.*, participants.nickname as participantNickname
         FROM suggestions JOIN participants ON participants.id = suggestions.participantId
         WHERE suggestions.sessionId = ?
         ORDER BY suggestions.createdAt DESC`
      )
      .all(session.id) as Suggestion[];
    const latestDifferential = this.latestInsight<DifferentialResult>(session.id, "differential");
    const latestCaseDraft = this.latestInsight<CaseDraft>(session.id, "case_draft");
    return {
      session,
      participant: participantId ? participants.find((item) => item.id === participantId) : undefined,
      participants,
      questions,
      answers,
      suggestions,
      latestDifferential,
      latestCaseDraft
    };
  }

  getSessionByCode(code: string): Session {
    const session = this.db.prepare("SELECT * FROM sessions WHERE code = ?").get(code.toUpperCase()) as Session | undefined;
    if (!session) throw Object.assign(new Error("会话不存在。"), { statusCode: 404 });
    return session;
  }

  touchParticipant(participantId: string) {
    this.db.prepare("UPDATE participants SET lastSeenAt = ? WHERE id = ?").run(now(), participantId);
  }

  exportMarkdown(code: string) {
    const snapshot = this.snapshotByCode(code);
    const answersByQuestion = new Map(snapshot.answers.map((answer) => [answer.questionId, answer]));
    const rows = snapshot.questions
      .map((question, index) => {
        const answer = answersByQuestion.get(question.id);
        return `${index + 1}. ${question.text}\n   - 状态：${answer?.status ?? "not_asked"}\n   - 记录：${answer?.note || "无"}`;
      })
      .join("\n");
    const draft = snapshot.latestCaseDraft;
    const differential = snapshot.latestDifferential;
    return `# 问诊总结 ${snapshot.session.code}

> 学习用途内容，不作为诊断或治疗依据。

## 病例摘要

- 怀疑疾病：${snapshot.session.suspectedDisease || "未填写"}
- 主要症状：${snapshot.session.chiefComplaint || "未填写"}
- 背景摘要：${snapshot.session.backgroundSummary || "未填写"}

## 问诊记录

${rows || "暂无记录"}

## 病历草稿

${draft ? draft.historyOfPresentIllness : "尚未生成"}

## 鉴别诊断

${differential ? differential.differentials.map((item) => `- ${item.disease}：支持 ${item.supportingFindings.join("、") || "待补充"}；反对 ${item.opposingFindings.join("、") || "待补充"}`).join("\n") : "尚未生成"}
`;
  }

  private assertActive(session: Session, allowSummarized = false) {
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      throw Object.assign(new Error("会话已过期。"), { statusCode: 410 });
    }
    if (!allowSummarized && session.status === "expired") {
      throw Object.assign(new Error("会话已过期。"), { statusCode: 410 });
    }
  }

  private assertChief(session: Session, participantId: string) {
    this.assertActive(session);
    if (session.chiefParticipantId !== participantId) {
      throw Object.assign(new Error("只有主问诊人可以执行该操作。"), { statusCode: 403 });
    }
  }

  private latestInsight<T>(sessionId: string, type: AiInsight["type"]): T | undefined {
    const row = this.db
      .prepare("SELECT outputJson FROM ai_insights WHERE sessionId = ? AND type = ? ORDER BY createdAt DESC LIMIT 1")
      .get(sessionId, type) as { outputJson: string } | undefined;
    return row ? parseJson<T>(row.outputJson, undefined as T) : undefined;
  }

  private questionFromRow(row: any): Question {
    return {
      id: row.id,
      sessionId: row.sessionId,
      source: row.source,
      status: row.status,
      text: row.text,
      recommendedWording: row.recommendedWording,
      meaning: row.meaning,
      positiveMeaning: row.positiveMeaning,
      negativeMeaning: row.negativeMeaning,
      options: parseJson<string[]>(row.optionsJson, []),
      relatedDifferentials: parseJson<string[]>(row.relatedDifferentialsJson, []),
      sortOrder: row.sortOrder,
      createdAt: row.createdAt
    };
  }
}
