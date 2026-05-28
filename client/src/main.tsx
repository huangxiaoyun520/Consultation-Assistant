import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createRoot } from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ClipboardList,
  Download,
  FileText,
  Lightbulb,
  Loader2,
  LogIn,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  Users
} from "lucide-react";
import type { AnswerStatus, SessionSnapshot, SuggestionStatus } from "../../shared/types";
import "./styles.css";

const answerLabels: Record<AnswerStatus, string> = {
  not_asked: "未问",
  recorded: "已记录",
  positive: "阳性",
  negative: "阴性",
  unknown: "不详",
  uncertain: "待确认"
};

const suggestionLabels: Record<SuggestionStatus, string> = {
  pending: "待处理",
  accepted: "已采纳",
  ignored: "已忽略",
  later: "稍后问"
};

type Tab = "current" | "records" | "suggestions" | "summary";

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers =
    options?.body === undefined
      ? options?.headers
      : {
          "content-type": "application/json",
          ...(options?.headers ?? {})
        };
  const response = await fetch(url, {
    ...options,
    headers
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ message: "请求失败。" }))) as { message?: string };
    throw new Error(body.message || "请求失败。");
  }
  return response.json() as Promise<T>;
}

function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [participantId, setParticipantId] = useState(localStorage.getItem("participantId") || "");
  const [code, setCode] = useState(localStorage.getItem("sessionCode") || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [isPending, startTransition] = useTransition();
  const questionCountRef = useRef(0);

  const applySnapshot = useCallback((next: SessionSnapshot) => {
    if (next.questions.length > questionCountRef.current) {
      setAiGenerating(false);
    }
    questionCountRef.current = next.questions.length;
    startTransition(() => setSnapshot(next));
    if (next.participant?.id) {
      localStorage.setItem("participantId", next.participant.id);
      setParticipantId(next.participant.id);
    }
    localStorage.setItem("sessionCode", next.session.code);
    setCode(next.session.code);
  }, []);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, onSuccess?: (value: T) => void) => {
      setBusy(true);
      setError("");
      try {
        const result = await action();
        onSuccess?.(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "操作失败。");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!code) return;
    let socket: Socket | null = io("/", { transports: ["websocket", "polling"] });
    socket.emit("session:join", { code, participantId });
    socket.on("session:updated", (next: SessionSnapshot) => {
      if (next.questions.length > questionCountRef.current) {
        setAiGenerating(false);
      }
      questionCountRef.current = next.questions.length;
      setSnapshot((current) => ({ ...next, participant: current?.participant ?? next.participant }));
    });
    socket.on("session:invalidated", () => setError("会话已失效或过期。"));
    return () => {
      socket?.disconnect();
      socket = null;
    };
  }, [code, participantId]);

  const role = snapshot?.participant?.role ?? (snapshot?.session.chiefParticipantId === participantId ? "chief" : "assistant");
  const isChief = role === "chief";

  if (!snapshot) {
    return (
      <Shell error={error} busy={busy}>
        <Landing
          busy={busy}
          onCreate={() => run(() => api<SessionSnapshot>("/api/sessions", { method: "POST" }), applySnapshot)}
          onJoin={(joinCode, nickname) =>
            run(
              () =>
                api<SessionSnapshot>(`/api/sessions/${joinCode.trim().toUpperCase()}/join`, {
                  method: "POST",
                  body: JSON.stringify({ nickname })
                }),
              applySnapshot
            )
          }
          onRestore={() =>
            code &&
            run(
              () => api<SessionSnapshot>(`/api/sessions/${code.trim().toUpperCase()}`),
              (next) => applySnapshot({ ...next, participant: next.participants.find((item) => item.id === participantId) })
            )
          }
          canRestore={Boolean(code)}
        />
      </Shell>
    );
  }

  return (
    <Shell error={error} busy={busy || isPending}>
      <Workspace
        snapshot={snapshot}
        participantId={participantId}
        isChief={isChief}
        busy={busy}
        onInitialize={(payload) =>
          run(
            () =>
              api<SessionSnapshot>(`/api/sessions/${snapshot.session.code}/initialize`, {
                method: "POST",
                body: JSON.stringify(payload)
              }),
            applySnapshot
          )
        }
        onAnswer={(questionId, status, note) =>
          {
            setAiGenerating(true);
            window.setTimeout(() => setAiGenerating(false), 45000);
            run(
            () =>
              api<SessionSnapshot>(`/api/sessions/${snapshot.session.code}/answers`, {
                method: "POST",
                body: JSON.stringify({ participantId, questionId, status, note })
              }),
            applySnapshot
            );
          }
        }
        onSkip={(questionId) => {
          setAiGenerating(true);
          window.setTimeout(() => setAiGenerating(false), 45000);
          run(
            () =>
              api<SessionSnapshot>(`/api/sessions/${snapshot.session.code}/questions/skip`, {
                method: "POST",
                body: JSON.stringify({ participantId, questionId })
              }),
            applySnapshot
          );
        }
        }
        onSuggest={(text, reason) =>
          run(
            () =>
              api<SessionSnapshot>(`/api/sessions/${snapshot.session.code}/suggestions`, {
                method: "POST",
                body: JSON.stringify({ participantId, text, reason })
              }),
            applySnapshot
          )
        }
        onResolve={(suggestionId, status) =>
          run(
            () =>
              api<SessionSnapshot>(`/api/sessions/${snapshot.session.code}/suggestions/${suggestionId}/resolve`, {
                method: "POST",
                body: JSON.stringify({ participantId, status })
              }),
            applySnapshot
          )
        }
        onNextQuestions={() =>
          run(
            () =>
              api<SessionSnapshot>(`/api/sessions/${snapshot.session.code}/next-questions`, {
                method: "POST",
                body: JSON.stringify({ participantId })
              }),
            applySnapshot
          )
        }
        onDifferential={() =>
          run(
            () =>
              api<SessionSnapshot>(`/api/sessions/${snapshot.session.code}/differential`, {
                method: "POST",
                body: JSON.stringify({ participantId })
              }),
            applySnapshot
          )
        }
        onCaseDraft={() =>
          run(
            () =>
              api<SessionSnapshot>(`/api/sessions/${snapshot.session.code}/case-draft`, {
                method: "POST",
                body: JSON.stringify({ participantId })
              }),
            applySnapshot
          )
        }
        aiGenerating={aiGenerating}
      />
    </Shell>
  );
}

function Shell({ children, error, busy }: { children: React.ReactNode; error: string; busy: boolean }) {
  return (
    <main className="app-shell">
      <div className="topbar" aria-live="polite">
        <div className="brand">
          <span className="brand-mark">
            <Stethoscope size={22} aria-hidden />
          </span>
          <span>
            <strong>问诊助手</strong>
            <small>临床示教协作工作台</small>
          </span>
        </div>
        <div className="runtime-state">{busy ? <Loader2 className="spin" size={18} aria-hidden /> : <ShieldCheck size={18} aria-hidden />}学习用途</div>
      </div>
      {error ? (
        <div className="toast" role="alert">
          <AlertTriangle size={18} aria-hidden />
          {error}
        </div>
      ) : null}
      {children}
    </main>
  );
}

function Landing({
  busy,
  onCreate,
  onJoin,
  onRestore,
  canRestore
}: {
  busy: boolean;
  onCreate: () => void;
  onJoin: (code: string, nickname: string) => void;
  onRestore: () => void;
  canRestore: boolean;
}) {
  const [joinCode, setJoinCode] = useState("");
  const [nickname, setNickname] = useState("辅助问诊人");
  return (
    <section className="landing">
      <div className="intro">
        <p className="eyebrow">匿名会话 · 实时协作 · 结构化病历</p>
        <h1>把床旁问诊训练变成清晰、可同步、可复盘的工作流</h1>
        <p className="lead">主问诊人记录正式问诊，辅助成员实时补充追问建议，系统生成学习用途的追问、鉴别诊断和中文病历草稿。</p>
      </div>
      <div className="entry-panel">
        <button className="primary-action" type="button" onClick={onCreate} disabled={busy}>
          <Plus size={20} aria-hidden />
          创建问诊会话
        </button>
        <form
          className="join-form"
          onSubmit={(event) => {
            event.preventDefault();
            onJoin(joinCode, nickname);
          }}
        >
          <label>
            分享码
            <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="例如 A1B2C3" maxLength={8} />
          </label>
          <label>
            匿名昵称
            <input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={24} />
          </label>
          <button type="submit" disabled={busy || joinCode.trim().length < 4}>
            <LogIn size={18} aria-hidden />
            加入会话
          </button>
        </form>
        {canRestore ? (
          <button className="ghost-action" type="button" onClick={onRestore} disabled={busy}>
            <RefreshCw size={18} aria-hidden />
            恢复上次会话
          </button>
        ) : null}
        <div className="privacy-note">
          <ShieldCheck size={20} aria-hidden />
          禁止录入真实姓名、住院号、身份证号、手机号、详细地址等身份信息。系统会做基础拦截，但不承诺满足医疗级合规。
        </div>
      </div>
    </section>
  );
}

function Workspace(props: {
  snapshot: SessionSnapshot;
  participantId: string;
  isChief: boolean;
  busy: boolean;
  onInitialize: (payload: { suspectedDisease: string; chiefComplaint: string; backgroundSummary: string }) => void;
  onAnswer: (questionId: string, status: AnswerStatus, note: string) => void;
  onSkip: (questionId: string) => void;
  onSuggest: (text: string, reason: string) => void;
  onResolve: (suggestionId: string, status: SuggestionStatus) => void;
  onNextQuestions: () => void;
  onDifferential: () => void;
  onCaseDraft: () => void;
  aiGenerating: boolean;
}) {
  const [tab, setTab] = useState<Tab>("current");
  const { snapshot } = props;
  const answersByQuestion = useMemo(() => new Map(snapshot.answers.map((answer) => [answer.questionId, answer])), [snapshot.answers]);
  const currentQuestion = snapshot.questions.find((question) => question.status === "pending");
  const progress = snapshot.questions.length
    ? Math.round((snapshot.questions.filter((question) => question.status === "answered").length / snapshot.questions.length) * 100)
    : 0;

  if (snapshot.session.status === "created") {
    return <InitializePanel busy={props.busy} isChief={props.isChief} snapshot={snapshot} onInitialize={props.onInitialize} />;
  }

  return (
    <section className="workspace">
      <SessionHeader snapshot={snapshot} isChief={props.isChief} progress={progress} />
      <nav className="mobile-tabs" aria-label="工作台视图">
        {[
          ["current", "当前问题"],
          ["records", "记录"],
          ["suggestions", "建议"],
          ["summary", "总结"]
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? "active" : ""} type="button" onClick={() => setTab(key as Tab)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="desk-grid">
        <aside className={tab === "records" ? "panel show-mobile" : "panel queue-panel"}>
          <PanelTitle icon={<ClipboardList size={18} />} title="问诊队列" />
          <div className="question-list">
            {snapshot.questions.map((question) => (
              <article className="queue-item" key={question.id}>
                <span className={`dot ${question.status}`} />
                <strong>{question.text}</strong>
                <small>{answerLabels[answersByQuestion.get(question.id)?.status ?? "not_asked"]}</small>
              </article>
            ))}
          </div>
        </aside>
        <section className={tab === "current" ? "panel show-mobile" : "panel current-panel"}>
          <QuestionPanel
            question={currentQuestion}
            answer={currentQuestion ? answersByQuestion.get(currentQuestion.id) : undefined}
            isChief={props.isChief}
            busy={props.busy}
            aiGenerating={props.aiGenerating}
            onAnswer={props.onAnswer}
            onSkip={props.onSkip}
            onNextQuestions={props.onNextQuestions}
            answeredCount={snapshot.questions.filter((question) => question.status === "answered").length}
          />
        </section>
        <aside className={tab === "suggestions" ? "panel show-mobile" : "panel side-panel"}>
          <SuggestionsPanel snapshot={snapshot} isChief={props.isChief} busy={props.busy} onSuggest={props.onSuggest} onResolve={props.onResolve} />
          <InsightPanel snapshot={snapshot} isChief={props.isChief} busy={props.busy} onDifferential={props.onDifferential} onCaseDraft={props.onCaseDraft} />
        </aside>
        <section className={tab === "summary" ? "panel summary-mobile show-mobile" : "panel summary-mobile"}>
          <SummaryPanel snapshot={snapshot} />
        </section>
      </div>
    </section>
  );
}

function InitializePanel({
  snapshot,
  isChief,
  busy,
  onInitialize
}: {
  snapshot: SessionSnapshot;
  isChief: boolean;
  busy: boolean;
  onInitialize: (payload: { suspectedDisease: string; chiefComplaint: string; backgroundSummary: string }) => void;
}) {
  const [caseInput, setCaseInput] = useState("");
  return (
    <section className="init-layout">
      <div className="session-ticket">
        <span>分享码</span>
        <strong>{snapshot.session.code}</strong>
        <p>同组成员通过该代码加入，默认 7 天后过期。</p>
      </div>
      <form
        className="init-form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = caseInput.trim();
          onInitialize({
            suspectedDisease: value,
            chiefComplaint: value,
            backgroundSummary: ""
          });
        }}
      >
        <PanelTitle icon={<Activity size={18} />} title="初始化病例" />
        <label>
          疑似疾病或主要症状
          <textarea
            disabled={!isChief}
            value={caseInput}
            onChange={(event) => setCaseInput(event.target.value)}
            placeholder="例如：肺炎；或发热伴咳嗽 3 天。请勿录入真实姓名、住院号、身份证号、手机号、详细地址等身份信息。"
          />
        </label>
        <button type="submit" disabled={!isChief || busy || !caseInput.trim()}>
          <Bot size={18} aria-hidden />
          生成首轮问题
        </button>
        {!isChief ? <p className="hint">等待主问诊人初始化病例。</p> : null}
      </form>
    </section>
  );
}

function SessionHeader({ snapshot, isChief, progress }: { snapshot: SessionSnapshot; isChief: boolean; progress: number }) {
  return (
    <header className="session-header">
      <div>
        <small>会话 {snapshot.session.code} · {isChief ? "主问诊人" : "辅助问诊人"}</small>
        <h2>{snapshot.session.chiefComplaint || "未填写主要症状"}</h2>
        <p>{snapshot.session.suspectedDisease || "未填写怀疑疾病"} · {snapshot.participants.length} 人在线协作</p>
      </div>
      <div className="progress-card" aria-label={`问诊进度 ${progress}%`}>
        <span>{progress}%</span>
        <div><i style={{ width: `${progress}%` }} /></div>
      </div>
    </header>
  );
}

function QuestionPanel({
  question,
  answer,
  isChief,
  busy,
  aiGenerating,
  answeredCount,
  onAnswer,
  onSkip,
  onNextQuestions
}: {
  question: SessionSnapshot["questions"][number] | undefined;
  answer: SessionSnapshot["answers"][number] | undefined;
  isChief: boolean;
  busy: boolean;
  aiGenerating: boolean;
  onAnswer: (questionId: string, status: AnswerStatus, note: string) => void;
  onSkip: (questionId: string) => void;
  onNextQuestions: () => void;
  answeredCount: number;
}) {
  const [selectedOption, setSelectedOption] = useState("");
  const [note, setNote] = useState(answer?.note ?? "");

  useEffect(() => {
    setSelectedOption("");
    setNote(answer?.note ?? "");
  }, [answer, question?.id]);

  if (!question) {
    return (
      <div className="empty-state">
        <Bot size={28} aria-hidden />
        <strong>当前没有待问问题</strong>
        <p>{aiGenerating ? "AI 正在后台生成新的追问，请稍候。" : "如果信息已经足够，可以进入总结阶段；也可以继续生成追问。"}</p>
        {isChief && !aiGenerating ? <button onClick={onNextQuestions}>继续生成追问</button> : null}
      </div>
    );
  }

  const combinedNote = [selectedOption, note.trim()].filter(Boolean).join("；");

  return (
    <div className="question-panel">
      <PanelTitle icon={<Stethoscope size={18} />} title="当前问题" />
      <h3>{question.text}</h3>
      <div className="meaning-grid">
        <div>
          <span>为什么问</span>
          <p>{question.meaning}</p>
        </div>
      </div>
      {question.options.length ? (
        <fieldset disabled={!isChief || busy}>
          <legend>预设答案</legend>
          <div className="segmented answer-options">
            {question.options.map((option) => (
              <button key={option} className={selectedOption === option ? "active" : ""} type="button" onClick={() => setSelectedOption(option)}>
                {option}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      {aiGenerating ? (
        <div className="generation-note" role="status">
          <Loader2 className="spin" size={16} aria-hidden />
          AI 正在后台生成后续问题，回答较快时可能需要等待几秒。
        </div>
      ) : null}
      {answeredCount >= 5 ? (
        <div className="summary-ready">
          已记录较多信息。如果当前病史已经清楚，可以进入总结阶段生成鉴别诊断和病历草稿。
        </div>
      ) : null}
      <label>
        补充记录
        <textarea disabled={!isChief || busy} value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录诱因、持续时间、程度、伴随症状、缓解因素等。" />
      </label>
      <div className="action-row">
        <button disabled={!isChief || busy || (!selectedOption && !note.trim())} onClick={() => onAnswer(question.id, "recorded", combinedNote)}>
          <Check size={18} aria-hidden />
          保存并进入下一问题
        </button>
        <button disabled={!isChief || busy} className="secondary" onClick={() => onSkip(question.id)}>
          <RefreshCw size={18} aria-hidden />
          跳过此问题
        </button>
      </div>
    </div>
  );
}

function SuggestionsPanel({
  snapshot,
  isChief,
  busy,
  onSuggest,
  onResolve
}: {
  snapshot: SessionSnapshot;
  isChief: boolean;
  busy: boolean;
  onSuggest: (text: string, reason: string) => void;
  onResolve: (suggestionId: string, status: SuggestionStatus) => void;
}) {
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="suggestion-panel">
      <PanelTitle icon={<MessageSquarePlus size={18} />} title="协作建议" />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSuggest(text, reason);
          setText("");
          setReason("");
        }}
      >
        <label>
          建议追问
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="例如：是否有夜间盗汗？" />
        </label>
        <label>
          建议理由
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明该问题能澄清的鉴别点。" />
        </label>
        <button disabled={busy || text.trim().length < 2}>
          <Plus size={18} aria-hidden />
          提交建议
        </button>
      </form>
      <div className="suggestion-list">
        {snapshot.suggestions.map((suggestion) => (
          <article key={suggestion.id} className="suggestion-item">
            <div>
              <strong>{suggestion.text}</strong>
              <small>{suggestion.participantNickname} · {suggestionLabels[suggestion.status]}</small>
            </div>
            {suggestion.reason ? <p>{suggestion.reason}</p> : null}
            {isChief && suggestion.status === "pending" ? (
              <div className="mini-actions">
                <button onClick={() => onResolve(suggestion.id, "accepted")}>采纳</button>
                <button onClick={() => onResolve(suggestion.id, "later")}>稍后</button>
                <button onClick={() => onResolve(suggestion.id, "ignored")}>忽略</button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function InsightPanel({
  snapshot,
  isChief,
  busy,
  onDifferential,
  onCaseDraft
}: {
  snapshot: SessionSnapshot;
  isChief: boolean;
  busy: boolean;
  onDifferential: () => void;
  onCaseDraft: () => void;
}) {
  return (
    <div className="insight-panel">
      <PanelTitle icon={<Lightbulb size={18} />} title="AI 总结" />
      <div className="action-row vertical">
        <button disabled={!isChief || busy} onClick={onDifferential}>
          <Bot size={18} aria-hidden />
          生成鉴别诊断
        </button>
        <button disabled={!isChief || busy} className="secondary" onClick={onCaseDraft}>
          <FileText size={18} aria-hidden />
          完成问诊并生成病历
        </button>
      </div>
      <SummaryPanel snapshot={snapshot} compact />
    </div>
  );
}

function SummaryPanel({ snapshot, compact = false }: { snapshot: SessionSnapshot; compact?: boolean }) {
  const differential = snapshot.latestDifferential;
  const draft = snapshot.latestCaseDraft;
  return (
    <div className={compact ? "summary compact" : "summary"}>
      {differential ? (
        <section>
          <h3>初步诊断思路</h3>
          <p>{differential.primaryImpression}</p>
          <div className="diff-list">
            {differential.differentials.map((item) => (
              <article key={item.disease}>
                <strong>{item.disease}</strong>
                <p>支持：{item.supportingFindings.join("、") || "待补充"}</p>
                <p>反对：{item.opposingFindings.join("、") || "待补充"}</p>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <p className="hint">尚未生成鉴别诊断。</p>
      )}
      {draft ? (
        <section>
          <h3>病历草稿</h3>
          <p>{draft.historyOfPresentIllness}</p>
          <ul>
            {draft.missingInformation.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <a className="download-link" href={`/api/sessions/${snapshot.session.code}/export.md`}>
            <Download size={18} aria-hidden />
            导出 Markdown
          </a>
        </section>
      ) : null}
    </div>
  );
}

function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <span>{title}</span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
