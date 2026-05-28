import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AiService } from "./ai.js";
import type { AppDatabase } from "./db.js";
import { assertPrivacy } from "./privacy.js";

const codeSchema = z.object({ code: z.string().min(4).max(12).transform((value) => value.toUpperCase()) });
const joinSchema = z.object({ nickname: z.string().trim().min(1).max(24).default("辅助问诊人") });
const initializeSchema = z.object({
  suspectedDisease: z.string().trim().min(1).max(120),
  chiefComplaint: z.string().trim().min(1).max(240),
  backgroundSummary: z.string().trim().max(2000).default("")
});
const answerSchema = z.object({
  participantId: z.string().min(1),
  questionId: z.string().min(1),
  status: z.enum(["not_asked", "recorded", "positive", "negative", "unknown", "uncertain"]),
  note: z.string().max(1200).default("")
});
const skipSchema = z.object({
  participantId: z.string().min(1),
  questionId: z.string().min(1)
});
const suggestionSchema = z.object({
  participantId: z.string().min(1),
  text: z.string().trim().min(2).max(300),
  reason: z.string().trim().max(600).default("")
});
const resolveSuggestionSchema = z.object({
  participantId: z.string().min(1),
  status: z.enum(["accepted", "ignored", "later"])
});
const participantSchema = z.object({ participantId: z.string().min(1) });

export function registerRoutes(app: FastifyInstance, db: AppDatabase, ai: AiService, broadcast: (code: string) => void) {
  // Set prevents concurrent AI generation for the same session
  const generatingSessions = new Set<string>();

  function maybeGenerateInBackground(code: string, participantId?: string) {
    const snapshot = db.snapshotByCode(code, participantId);
    const answeredCount = snapshot.questions.filter((q) => q.status === "answered").length;
    const openCount = snapshot.questions.filter((q) => q.status === "pending").length;
    const targetOpenQuestions = 3;
    if (answeredCount >= 8 || openCount >= targetOpenQuestions || generatingSessions.has(snapshot.session.id)) return;

    generatingSessions.add(snapshot.session.id);
    app.log.info({ code }, "AI background question generation started");
    ai.nextQuestions(snapshot)
      .then((questions) => {
        const existing = new Set(db.snapshotByCode(code).questions.map((q) => q.text));
        const fresh = questions.filter((q) => !existing.has(q.text)).slice(0, targetOpenQuestions - openCount);
        if (fresh.length) {
          db.addQuestions(snapshot.session.id, fresh, "ai");
          db.saveInsight(snapshot.session.id, "next_questions", "background refill", { questions: fresh });
        }
        broadcast(code);
      })
      .catch((error) => app.log.error(error, "AI background question generation failed"))
      .finally(() => generatingSessions.delete(snapshot.session.id));
  }

  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  app.post("/api/sessions", async () => db.createSession());

  app.get("/api/sessions/:code", async (request) => {
    const { code } = codeSchema.parse(request.params);
    return db.snapshotByCode(code);
  });

  app.post("/api/sessions/:code/join", async (request) => {
    const { code } = codeSchema.parse(request.params);
    const body = joinSchema.parse(request.body);
    const snapshot = db.joinSession(code, body.nickname);
    broadcast(code);
    return snapshot;
  });

  app.post("/api/sessions/:code/initialize", async (request) => {
    const { code } = codeSchema.parse(request.params);
    const body = initializeSchema.parse(request.body);
    assertPrivacy([body.suspectedDisease, body.chiefComplaint, body.backgroundSummary]);
    const session = db.initializeSession(code, body);
    // Fetch snapshot once; reuse it instead of calling snapshotByCode again below
    const snapshot = db.snapshotByCode(code);
    const questions = await ai.nextQuestions(snapshot);
    if (questions.length) {
      db.addQuestions(session.id, questions, "ai");
      db.saveInsight(session.id, "next_questions", JSON.stringify(body), { questions });
    }
    broadcast(code);
    return db.snapshotByCode(code);
  });

  app.post("/api/sessions/:code/answers", async (request) => {
    const { code } = codeSchema.parse(request.params);
    const body = answerSchema.parse(request.body);
    assertPrivacy([body.note]);
    db.updateAnswer(code, body.participantId, body.questionId, body.status, body.note);
    maybeGenerateInBackground(code, body.participantId);
    return db.snapshotByCode(code, body.participantId);
  });

  app.post("/api/sessions/:code/questions/skip", async (request) => {
    const { code } = codeSchema.parse(request.params);
    const body = skipSchema.parse(request.body);
    db.skipQuestion(code, body.participantId, body.questionId);
    maybeGenerateInBackground(code, body.participantId);
    return db.snapshotByCode(code, body.participantId);
  });

  app.post("/api/sessions/:code/next-questions", async (request) => {
    const { code } = codeSchema.parse(request.params);
    const { participantId } = participantSchema.parse(request.body);
    const snapshot = db.snapshotByCode(code, participantId);
    if (snapshot.session.chiefParticipantId !== participantId) {
      throw Object.assign(new Error("只有主问诊人可以生成下一问。"), { statusCode: 403 });
    }
    const questions = await ai.nextQuestions(snapshot);
    if (questions.length) {
      db.addQuestions(snapshot.session.id, questions, "ai");
      db.saveInsight(snapshot.session.id, "next_questions", "next step", { questions });
    }
    broadcast(code);
    return db.snapshotByCode(code, participantId);
  });

  app.post("/api/sessions/:code/suggestions", async (request) => {
    const { code } = codeSchema.parse(request.params);
    const body = suggestionSchema.parse(request.body);
    assertPrivacy([body.text, body.reason]);
    db.addSuggestion(code, body.participantId, body.text, body.reason);
    broadcast(code);
    return db.snapshotByCode(code, body.participantId);
  });

  app.post("/api/sessions/:code/suggestions/:suggestionId/resolve", async (request) => {
    const { code, suggestionId } = z.object({
      code: z.string(), suggestionId: z.string()
    }).parse(request.params);
    const body = resolveSuggestionSchema.parse(request.body);
    db.resolveSuggestion(code, body.participantId, suggestionId, body.status);
    broadcast(code);
    return db.snapshotByCode(code, body.participantId);
  });

  app.post("/api/sessions/:code/differential", async (request) => {
    const { code } = codeSchema.parse(request.params);
    const { participantId } = participantSchema.parse(request.body);
    const snapshot = db.snapshotByCode(code, participantId);
    if (snapshot.session.chiefParticipantId !== participantId) {
      throw Object.assign(new Error("只有主问诊人可以生成鉴别诊断。"), { statusCode: 403 });
    }
    const result = await ai.differential(snapshot);
    db.saveInsight(snapshot.session.id, "differential", "current facts", result);
    broadcast(code);
    return db.snapshotByCode(code, participantId);
  });

  app.post("/api/sessions/:code/case-draft", async (request) => {
    const { code } = codeSchema.parse(request.params);
    const { participantId } = participantSchema.parse(request.body);
    const snapshot = db.snapshotByCode(code, participantId);
    if (snapshot.session.chiefParticipantId !== participantId) {
      throw Object.assign(new Error("只有主问诊人可以生成病历草稿。"), { statusCode: 403 });
    }
    const draft = await ai.caseDraft(snapshot);
    db.saveInsight(snapshot.session.id, "case_draft", "full interview", draft);
    db.markSummarized(code);
    broadcast(code);
    return db.snapshotByCode(code, participantId);
  });

  app.get("/api/sessions/:code/export.md", async (request, reply) => {
    const { code } = codeSchema.parse(request.params);
    const markdown = db.exportMarkdown(code);
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", `attachment; filename="wenzhen-${code}.md"`)
      .send(markdown);
  });
}
