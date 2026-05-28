export type SessionStatus = "created" | "initialized" | "interviewing" | "summarized" | "expired";
export type ParticipantRole = "chief" | "assistant";
export type QuestionSource = "ai" | "assistant" | "manual";
export type QuestionStatus = "pending" | "answered" | "skipped";
export type AnswerStatus = "not_asked" | "recorded" | "positive" | "negative" | "unknown" | "uncertain";
export type SuggestionStatus = "pending" | "accepted" | "ignored" | "later";
export type AiInsightType = "next_questions" | "differential" | "case_draft" | "gap_check";

export interface Session {
  id: string;
  code: string;
  chiefParticipantId: string;
  suspectedDisease: string;
  chiefComplaint: string;
  backgroundSummary: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
}

export interface Participant {
  id: string;
  sessionId: string;
  nickname: string;
  role: ParticipantRole;
  color: string;
  lastSeenAt: string;
}

export interface Question {
  id: string;
  sessionId: string;
  source: QuestionSource;
  status: QuestionStatus;
  text: string;
  recommendedWording: string;
  meaning: string;
  positiveMeaning: string;
  negativeMeaning: string;
  options: string[];
  relatedDifferentials: string[];
  sortOrder: number;
  createdAt: string;
}

export interface Answer {
  id: string;
  questionId: string;
  sessionId: string;
  status: AnswerStatus;
  note: string;
  answeredBy: string;
  updatedAt: string;
}

export interface Suggestion {
  id: string;
  sessionId: string;
  participantId: string;
  participantNickname: string;
  text: string;
  reason: string;
  status: SuggestionStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface DifferentialItem {
  disease: string;
  supportingFindings: string[];
  opposingFindings: string[];
  questionsToClarify: string[];
}

export interface CaseDraft {
  chiefComplaint: string;
  historyOfPresentIllness: string;
  pastHistory: string;
  personalHistory: string;
  maritalMenstrualOrObstetricHistory: string;
  familyHistory: string;
  physicalExamPlaceholder: string;
  auxiliaryExamPlaceholder: string;
  assessment: string;
  differentialDiagnosis: string;
  missingInformation: string[];
  disclaimer: string;
}

export interface DifferentialResult {
  primaryImpression: string;
  differentials: DifferentialItem[];
  missingInformation: string[];
  disclaimer: string;
}

export interface AiInsight {
  id: string;
  sessionId: string;
  type: AiInsightType;
  inputSummary: string;
  outputJson: unknown;
  createdAt: string;
}

export interface SessionSnapshot {
  session: Session;
  participant?: Participant;
  participants: Participant[];
  questions: Question[];
  answers: Answer[];
  suggestions: Suggestion[];
  latestDifferential?: DifferentialResult;
  latestCaseDraft?: CaseDraft;
}

export interface NewQuestionPayload {
  text: string;
  recommendedWording: string;
  meaning: string;
  positiveMeaning: string;
  negativeMeaning: string;
  options: string[];
  relatedDifferentials: string[];
}

export interface InitializeSessionPayload {
  suspectedDisease: string;
  chiefComplaint: string;
  backgroundSummary: string;
}
