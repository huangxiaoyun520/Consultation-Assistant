import OpenAI from "openai";
import { z } from "zod";
import type {
  Answer,
  CaseDraft,
  DifferentialResult,
  NewQuestionPayload,
  Question,
  Session
} from "../../shared/types.js";

const questionSchema = z.object({
  questions: z.array(
    z.object({
      text: z.string().min(2),
      recommendedWording: z.string().min(2),
      meaning: z.string().min(2),
      positiveMeaning: z.string().min(2),
      negativeMeaning: z.string().min(2),
      options: z.array(z.string()).min(1),
      relatedDifferentials: z.array(z.string()).default([])
    })
  )
});

const differentialSchema = z.object({
  primaryImpression: z.string(),
  differentials: z.array(
    z.object({
      disease: z.string(),
      supportingFindings: z.array(z.string()),
      opposingFindings: z.array(z.string()),
      questionsToClarify: z.array(z.string())
    })
  ),
  missingInformation: z.array(z.string()),
  disclaimer: z.string().default("本内容仅用于临床示教学习，不作为诊断或治疗依据。")
});

const caseDraftSchema = z.object({
  chiefComplaint: z.string(),
  historyOfPresentIllness: z.string(),
  pastHistory: z.string(),
  personalHistory: z.string(),
  maritalMenstrualOrObstetricHistory: z.string(),
  familyHistory: z.string(),
  physicalExamPlaceholder: z.string(),
  auxiliaryExamPlaceholder: z.string(),
  assessment: z.string(),
  differentialDiagnosis: z.string(),
  missingInformation: z.array(z.string()),
  disclaimer: z.string().default("本内容仅用于临床示教学习，不作为诊断或治疗依据。")
});

export interface InterviewContext {
  session: Session;
  questions: Question[];
  answers: Answer[];
}

const disclaimer = "本内容仅用于临床示教学习，不作为诊断或治疗依据。";

export class AiService {
  private client: OpenAI | null;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
    this.client = apiKey
      ? new OpenAI({
          apiKey,
          baseURL: process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || undefined
        })
      : null;
    this.model = process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
  }

  async nextQuestions(context: InterviewContext): Promise<NewQuestionPayload[]> {
    const parsed = await this.safeJson(
      "next questions",
      [
        "You are a clinical teaching interview assistant.",
        "Return ONLY valid JSON with this exact shape: {\"questions\":[{\"text\":\"\",\"recommendedWording\":\"\",\"meaning\":\"\",\"positiveMeaning\":\"\",\"negativeMeaning\":\"\",\"options\":[\"\"],\"relatedDifferentials\":[\"\"]}]}",
        "All field values must be written in Simplified Chinese.",
        "Generate interview questions only. Do not provide diagnoses, treatments, prescriptions, markdown, or explanations outside JSON.",
        "Each question must include 3 to 5 concrete preset answer options, such as pain qualities, duration ranges, severity levels, or yes/no choices.",
        "Do not echo the input case JSON."
      ].join("\n"),
      `Generate 3 next interview questions for this anonymized clinical teaching case. Output JSON only.\n\nCase data:\n${JSON.stringify(compactContext(context), null, 2)}`
    );
    const result = questionSchema.safeParse(parsed);
    if (!result.success || !result.data.questions.length) {
      throw Object.assign(new Error("AI 未返回有效的问诊问题，请稍后重试。"), { statusCode: 502 });
    }
    return result.data.questions.slice(0, 3);
  }

  async differential(context: InterviewContext): Promise<DifferentialResult> {
    const parsed = await this.safeJson(
      "differential",
      [
        "你是临床示教课问诊训练助手。基于已采集事实生成鉴别诊断思路，不能输出治疗方案。",
        "只返回 JSON，字段为 primaryImpression、differentials、missingInformation、disclaimer。",
        "differentials 至少 3 项，每项包含 disease、supportingFindings、opposingFindings、questionsToClarify。"
      ].join("\n"),
      `请根据以下匿名病例资料生成鉴别诊断 JSON。\n\n病例资料：\n${JSON.stringify(compactContext(context), null, 2)}`
    );
    const result = differentialSchema.safeParse(parsed);
    if (!result.success) {
      throw Object.assign(new Error("AI 未返回有效的鉴别诊断，请稍后重试。"), { statusCode: 502 });
    }
    return ensureDisclaimer(result.data);
  }

  async caseDraft(context: InterviewContext): Promise<CaseDraft> {
    const parsed = await this.safeJson(
      "case draft",
      [
        "你是临床示教课问诊训练助手。根据匿名问诊记录生成中文结构化病历草稿。",
        "不得编造未采集信息；未知内容写\u201c待补充\u201d。不提供处方或治疗方案。",
        "只返回 JSON，字段包括 chiefComplaint、historyOfPresentIllness、pastHistory、personalHistory、maritalMenstrualOrObstetricHistory、familyHistory、physicalExamPlaceholder、auxiliaryExamPlaceholder、assessment、differentialDiagnosis、missingInformation、disclaimer。"
      ].join("\n"),
      `请根据以下匿名病例资料生成结构化病历草稿 JSON。\n\n病例资料：\n${JSON.stringify(compactContext(context), null, 2)}`
    );
    const result = caseDraftSchema.safeParse(parsed);
    if (!result.success) {
      throw Object.assign(new Error("AI 未返回有效的病历草稿，请稍后重试。"), { statusCode: 502 });
    }
    return ensureDisclaimer(result.data);
  }

  private assertConfigured() {
    if (!this.client) {
      throw Object.assign(new Error("AI 服务未配置 API Key，无法生成内容。"), { statusCode: 503 });
    }
  }

  private async safeJson(label: string, system: string, input: string): Promise<unknown> {
    this.assertConfigured();
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const request: Record<string, unknown> = {
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input }
          ],
          stream: false
        };
        if (!isDeepSeekModel(this.model)) {
          request.response_format = { type: "json_object" };
        }
        const completion = await this.client!.chat.completions.create(request as never, {
          timeout: 12000
        });
        const content = completion.choices[0]?.message?.content ?? "";
        return JSON.parse(extractJson(content));
      } catch (error) {
        if (attempt === maxRetries) {
          console.warn(`AI ${label} failed after ${maxRetries + 1} attempts:`, error);
          throw Object.assign(new Error("AI 服务调用失败，请稍后重试。"), { statusCode: 502 });
        }
        console.warn(`AI ${label} attempt ${attempt + 1} failed, retrying:`, error);
      }
    }
    throw Object.assign(new Error("AI 服务调用失败，请稍后重试。"), { statusCode: 502 });
  }
}

function isDeepSeekModel(model: string) {
  return model.toLowerCase().includes("deepseek");
}

function extractJson(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  throw new Error("AI response did not contain JSON.");
}

function compactContext(context: InterviewContext) {
  const answersByQuestion = new Map(context.answers.map((answer) => [answer.questionId, answer]));
  return {
    suspectedDisease: context.session.suspectedDisease,
    chiefComplaint: context.session.chiefComplaint,
    backgroundSummary: context.session.backgroundSummary,
    facts: context.questions.map((question) => ({
      question: question.text,
      status: answersByQuestion.get(question.id)?.status ?? "not_asked",
      note: answersByQuestion.get(question.id)?.note ?? ""
    }))
  };
}

function ensureDisclaimer<T extends { disclaimer: string }>(value: T): T {
  return { ...value, disclaimer: value.disclaimer || disclaimer };
}
