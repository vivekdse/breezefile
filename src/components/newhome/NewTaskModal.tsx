// task-366d5a0caa68 — New Home: the real split "New Task" modal replacing
// the task-b9cdad64ab9c stub. Left pane is a conversational interviewer
// (agent asks one field at a time, chip suggestions for select fields);
// right pane is a live form-field preview (template.fields) that fills in
// as the conversation answers questions. The conversation is UX only — the
// FORM is the data model; every value that ends up on the task is one the
// user can see land in the right-hand panel.
//
// v1 conversation "engine" is a deterministic, local, field-driven
// interviewer (see ConversationDriver below). It is intentionally NOT an
// LLM: the interface is shaped so a real LLM-backed driver can be dropped
// in later (TODO) without touching the chat/form UI.
//
// PHI: title/answers are rendered in memory only; never logged/persisted
// outside the task itself (docs/typebuild-data-field-contract.md).

import { useEffect, useRef, useState } from 'react';
import { createTask } from '../../tasks';
import type { TemplateConfig, TemplateField } from './types';
import './NewTaskModal.css';

// ─── Conversation driver types (local to this file; not part of the shared
// New Home contract in types.ts) ────────────────────────────────────────

type ChatMessage = {
  id: string;
  who: 'agent' | 'user';
  text: string;
  /** Marks a transient "thinking…" bubble (agent-fetch simulation) so the
   *  UI can render it in a muted/italic style distinct from a real turn. */
  thinking?: boolean;
};

/** One suggestion the user can click instead of typing. */
type Chip = { label: string; value: string };

/** What the driver wants rendered/asked next. `done` ends the interview
 *  (all required fields collected, or nothing left to ask) — the UI still
 *  lets the user use the optional-fields turn / edit before approving. */
type AgentTurn = {
  message: string;
  chips?: Chip[];
  /** True when this turn is a transient "looking it up" beat that should be
   *  auto-followed by another `next()` call rather than waiting on the user. */
  thinking?: boolean;
  done?: boolean;
};

/** Conversation state the driver reads/writes. Kept plain data (no class)
 *  so a future LLM-backed driver can serialize/replay it easily. */
type ConversationState = {
  template: TemplateConfig;
  title: string;
  /** Field key -> collected value (string; select/date normalized). */
  values: Record<string, string>;
  /** Field keys already asked about (required walk + optional pass), so the
   *  driver doesn't re-ask. */
  asked: Set<string>;
  /** Set once the title/description turn has been asked. */
  titleAsked: boolean;
  /** Set once the "anything else?" optional-fields turn has been offered. */
  optionalOffered: boolean;
  /** Fields the agent tried to auto-fetch and gave up on — routed back into
   *  the manual required-field walk. */
  needsManualEntry: Set<string>;
};

/** v1 deterministic, field-driven interviewer. `next` is called once per
 *  driver "turn": after the modal mounts, and after each user reply/chip
 *  click. It never calls an LLM — TODO(real driver): a follow-up task can
 *  swap this for one that calls out to an LLM for freer-form phrasing /
 *  extraction while keeping this exact interface, so ConversationEngine
 *  (below) and the chat/form UI don't change. */
interface ConversationDriver {
  next(state: ConversationState): AgentTurn;
}

function requiredFields(template: TemplateConfig): TemplateField[] {
  return template.fields.filter((f) => f.required);
}
function optionalFields(template: TemplateConfig): TemplateField[] {
  return template.fields.filter((f) => !f.required);
}

function fieldPrompt(f: TemplateField): string {
  return `What's the ${f.label.toLowerCase()}?`;
}

function fieldChips(f: TemplateField): Chip[] | undefined {
  if (f.type === 'select' && f.options?.length) {
    return f.options.map((o) => ({ label: o, value: o }));
  }
  return undefined;
}

/** Extension point for agent-fetch simulation: given an agentFetchable
 *  field, attempt to resolve its value without asking the human. v1 has no
 *  real fetchers wired up, so this always returns null (falls back to
 *  manual entry) — TODO(agent-fetch): wire real lookups here (e.g. an MCP
 *  call) per field key/template, without changing the driver contract. */
function tryAgentFetch(_field: TemplateField, _state: ConversationState): string | null {
  return null;
}

const deterministicDriver: ConversationDriver = {
  next(state: ConversationState): AgentTurn {
    const { template } = state;

    // 1) Title/description turn — always first if not yet asked. When the
    // template has no fields at all, this is the ENTIRE interview.
    if (!state.titleAsked) {
      return { message: "What's this task about? Give me a short title." };
    }
    if (!state.title.trim()) {
      // Title turn was asked but not yet answered — nothing more to do
      // until the user replies (handled by ConversationEngine.reply).
      return { message: "What's this task about? Give me a short title." };
    }

    // 2) Walk required fields, in template order, one at a time.
    const req = requiredFields(template);
    const nextRequired = req.find(
      (f) => !(f.key in state.values) && !state.needsManualEntry.has(f.key) && !state.asked.has(f.key),
    );
    if (nextRequired) {
      if (nextRequired.agentFetchable) {
        return {
          message: `Let me look up the ${nextRequired.label.toLowerCase()}…`,
          thinking: true,
        };
      }
      return { message: fieldPrompt(nextRequired), chips: fieldChips(nextRequired) };
    }
    // A field marked needing manual entry (agent-fetch gave up) still needs
    // asking, just via the normal question path.
    const manualFallback = req.find(
      (f) => !(f.key in state.values) && state.needsManualEntry.has(f.key) && !state.asked.has(f.key),
    );
    if (manualFallback) {
      return { message: fieldPrompt(manualFallback), chips: fieldChips(manualFallback) };
    }
    const stillUnfilledRequired = req.some((f) => !(f.key in state.values));
    if (stillUnfilledRequired) {
      // Every required field has been asked at least once but one is still
      // unfilled (e.g. mid agent-fetch). Nothing more to say this turn.
      return { message: '…', thinking: true };
    }

    // 3) Optional fields — single "anything else?" turn with skip chips.
    const opt = optionalFields(template).filter((f) => !(f.key in state.values));
    if (opt.length > 0 && !state.optionalOffered) {
      const chips: Chip[] = opt.map((f) => ({ label: `Skip ${f.label}`, value: `__skip__${f.key}` }));
      const names = opt.map((f) => f.label).join(', ');
      return {
        message: `Anything else? I can also fill in: ${names}. Type a value for one, or skip.`,
        chips,
      };
    }

    // 4) Nothing left to ask.
    return { message: 'That covers everything — review the details on the right and approve when ready.', done: true };
  },
};

// ─── Conversation engine: wraps the driver, owns the running chat log +
// collected values, and exposes the small surface the component needs. ───

let msgSeq = 0;
function nextId(): string {
  msgSeq += 1;
  return `m${msgSeq}`;
}

class ConversationEngine {
  state: ConversationState;
  driver: ConversationDriver;
  messages: ChatMessage[] = [];
  activeChips: Chip[] | undefined;
  finished = false;

  constructor(template: TemplateConfig, driver: ConversationDriver = deterministicDriver) {
    this.driver = driver;
    this.state = {
      template,
      title: '',
      values: {},
      asked: new Set(),
      titleAsked: false,
      optionalOffered: false,
      needsManualEntry: new Set(),
    };
  }

  private pushAgent(turn: AgentTurn) {
    this.messages.push({ id: nextId(), who: 'agent', text: turn.message, thinking: turn.thinking });
    this.activeChips = turn.chips;
    if (turn.done) this.finished = true;
  }

  /** Advance the driver. If the resulting turn is a transient "thinking"
   *  beat, the caller should schedule a short delay then call `resolveFetch`
   *  to move past it (kept outside this method so the UI can render the
   *  interim state first). */
  start() {
    const turn = this.driver.next(this.state);
    this.pushAgent(turn);
  }

  /** Resolve an in-flight agent-fetch "thinking" turn: try the fetch
   *  extension point, record success or fall back to needsManualEntry, then
   *  advance the driver again. */
  resolveFetch() {
    const req = requiredFields(this.state.template);
    const pendingFetch = req.find(
      (f) => f.agentFetchable && !(f.key in this.state.values) && !this.state.needsManualEntry.has(f.key),
    );
    if (pendingFetch) {
      const value = tryAgentFetch(pendingFetch, this.state);
      if (value != null) {
        this.state.values[pendingFetch.key] = value;
        this.state.asked.add(pendingFetch.key);
        this.messages.push({
          id: nextId(),
          who: 'agent',
          text: `Found it: ${pendingFetch.label} = ${value}.`,
        });
      } else {
        this.state.needsManualEntry.add(pendingFetch.key);
      }
    }
    const turn = this.driver.next(this.state);
    this.pushAgent(turn);
  }

  get pendingField(): TemplateField | undefined {
    if (!this.state.titleAsked || !this.state.title.trim()) return undefined;
    const req = requiredFields(this.state.template);
    const f = req.find((f) => !(f.key in this.state.values) && !this.state.asked.has(f.key));
    if (f && !f.agentFetchable) return f;
    if (f && f.agentFetchable && this.state.needsManualEntry.has(f.key)) return f;
    if (!f) {
      const manualFallback = req.find(
        (f2) => !(f2.key in this.state.values) && this.state.needsManualEntry.has(f2.key) && !this.state.asked.has(f2.key),
      );
      if (manualFallback) return manualFallback;
    }
    return undefined;
  }

  /** True once the title turn has been asked (chat has started). */
  get isTitleTurn(): boolean {
    return !this.state.titleAsked || !this.state.title.trim();
  }

  normalizeDate(raw: string): string {
    const s = raw.trim().toLowerCase();
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (iso.test(s)) return s;
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (s === 'today' || s === 'tod') return toISO(today);
    if (s === 'tomorrow' || s === 'tom' || s === 'tmrw') {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      return toISO(d);
    }
    const rel = /^\+?(\d+)\s*([dw])$/.exec(s);
    if (rel) {
      const n = Number(rel[1]) * (rel[2] === 'w' ? 7 : 1);
      const d = new Date(today);
      d.setDate(d.getDate() + n);
      return toISO(d);
    }
    // MM/DD/YYYY or M/D/YYYY
    const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (slash) {
      return `${slash[3]}-${pad(Number(slash[1]))}-${pad(Number(slash[2]))}`;
    }
    // Fall back: let Date try (e.g. "July 4 2026"); keep raw if unparseable.
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return toISO(parsed);
    return raw.trim();
  }

  /** Submit a free-text reply (Enter/Send) or a chip's value. Advances the
   *  conversation by one user turn + the driver's next agent turn. */
  reply(raw: string) {
    const text = raw.trim();
    if (!text) return;

    if (this.isTitleTurn) {
      this.state.title = text;
      this.state.titleAsked = true;
      this.messages.push({ id: nextId(), who: 'user', text });
      this.advance();
      return;
    }

    const field = this.pendingField;
    if (field) {
      let value = text;
      if (text.startsWith('__skip__')) {
        // Skip chip on a REQUIRED field shouldn't happen (required fields
        // don't offer a skip chip) — guard defensively by ignoring.
        return;
      }
      if (field.type === 'date') value = this.normalizeDate(text);
      this.state.values[field.key] = value;
      this.state.asked.add(field.key);
      this.messages.push({ id: nextId(), who: 'user', text: field.type === 'date' ? value : text });
      this.advance();
      return;
    }

    // Optional-fields "anything else?" turn.
    if (text.startsWith('__skip__')) {
      const key = text.slice('__skip__'.length);
      this.state.asked.add(key);
      const f = this.state.template.fields.find((f) => f.key === key);
      this.messages.push({ id: nextId(), who: 'user', text: `Skip ${f?.label ?? key}` });
      this.state.optionalOffered = false; // re-offer remaining optional fields
      this.advance();
      return;
    }
    // Free text during the optional turn: try to match it to the first
    // unfilled optional field (simple v1 heuristic — one field at a time).
    const opt = optionalFields(this.state.template).filter((f) => !(f.key in this.state.values));
    if (opt.length > 0) {
      const f = opt[0];
      const value = f.type === 'date' ? this.normalizeDate(text) : text;
      this.state.values[f.key] = value;
      this.state.asked.add(f.key);
      this.messages.push({ id: nextId(), who: 'user', text });
      this.state.optionalOffered = false;
      this.advance();
      return;
    }
    // Nothing left to ask — treat as a no-op chat message.
    this.messages.push({ id: nextId(), who: 'user', text });
  }

  private advance() {
    const turn = this.driver.next(this.state);
    // Mark the optional-fields "anything else?" turn as offered once the
    // driver actually emits it (its skip chips are the tell), so a
    // subsequent call doesn't re-offer the same turn forever.
    if (turn.chips?.some((c) => c.value.startsWith('__skip__'))) {
      this.state.optionalOffered = true;
    }
    this.pushAgent(turn);
  }
}

// ─── React component ────────────────────────────────────────────────────

function summarizeBody(title: string, template: TemplateConfig, values: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(title);
  if (template.fields.length > 0) {
    lines.push('');
    lines.push('Details collected via New Task conversation:');
    for (const f of template.fields) {
      const v = values[f.key];
      if (v) lines.push(`- ${f.label}: ${v}`);
    }
  }
  return lines.join('\n');
}

// TaskCreate (src/types.ts) has no `data`/custom-values carrier today — see
// docs/typebuild-data-field-contract.md, which proposes one for the server
// but it isn't wired into TaskCreate/tasksCreate yet. Until that lands we
// embed a machine-parseable, clearly-delimited block in the body instead of
// silently dropping the structured answers.
// TODO(typebuild-data-field-contract): once TaskCreate carries a `data`
// map, replace this block with real `data: values` (non-PII literals may
// stay inline per the contract; PII-shaped values should be re-keyed to
// placeholders and threaded through the contract's `data` bag instead).
function buildStructuredBlock(template: TemplateConfig, values: Record<string, string>): string {
  if (template.fields.length === 0) return '';
  const lines = ['', '```task-fields', ...template.fields.filter((f) => values[f.key]).map((f) => `${f.key}: ${values[f.key]}`), '```'];
  return lines.join('\n');
}

export function NewTaskModal({
  projectId,
  template,
  onClose,
  onCreated,
}: {
  projectId: string;
  template: TemplateConfig;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const engineRef = useRef<ConversationEngine>(new ConversationEngine(template));
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((n) => n + 1);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Kick off the conversation once on mount.
  useEffect(() => {
    engineRef.current.start();
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-follow a "thinking" (agent-fetch) turn after a short simulated
  // delay, then advance the driver for real.
  useEffect(() => {
    const engine = engineRef.current;
    const last = engine.messages[engine.messages.length - 1];
    if (last?.thinking) {
      const t = setTimeout(() => {
        engine.resolveFetch();
        rerender();
      }, 500);
      return () => clearTimeout(t);
    }
  });

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  });

  // Escape closes/discards at any point.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const engine = engineRef.current;
  const req = requiredFields(template);
  const allRequiredFilled = req.every((f) => f.key in engine.state.values);
  const canSubmit = engine.state.title.trim().length > 0 && allRequiredFilled;

  function send() {
    const text = draft;
    setDraft('');
    engine.reply(text);
    rerender();
  }

  function sendChip(chip: Chip) {
    engine.reply(chip.value);
    rerender();
  }

  async function approve() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const title = engine.state.title.trim();
      const body = summarizeBody(title, template, engine.state.values) + buildStructuredBlock(template, engine.state.values);
      const t = await createTask({
        title,
        folder: '',
        notes: body,
        ...(projectId ? { projectId } : {}),
      });
      engine.messages.push({ id: nextId(), who: 'agent', text: `Task created — starting "${title}".` });
      rerender();
      setSucceeded(true);
      setTimeout(() => onCreated(t.id), 700);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const activeChips = engine.activeChips;

  return (
    <div className="nh-modal-overlay" onClick={onClose}>
      <div className="nh-newtask" onClick={(e) => e.stopPropagation()}>
        <div className="nh-newtask__head">
          <div className="nh-newtask__title">
            New Task{template.fields.length > 0 ? '' : ' — quick task'}
          </div>
          <button type="button" className="nh-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="nh-newtask__body">
          <div className="nh-newtask__left">
            <div className="nh-chat" ref={logRef}>
              {engine.messages.map((m) => (
                <div
                  key={m.id}
                  className={`nh-chat__msg nh-chat__msg--${m.who}${m.thinking ? ' nh-chat__msg--thinking' : ''}`}
                >
                  {m.thinking && <span className="nh-chat__spinner" aria-hidden="true" />}
                  {m.text}
                </div>
              ))}
              {activeChips && activeChips.length > 0 && !succeeded && (
                <div className="nh-chat__chips">
                  {activeChips.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className="nh-chat__chip"
                      onClick={() => sendChip(c)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="nh-chat__input-row">
              <input
                className="nh-chat__input"
                autoFocus
                placeholder={succeeded ? '' : 'Type your answer…'}
                value={draft}
                disabled={succeeded || busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') send();
                }}
              />
              <button type="button" className="nh-chat__send" disabled={succeeded || busy || !draft.trim()} onClick={send}>
                Send
              </button>
            </div>
          </div>

          <div className="nh-newtask__right">
            <div className="nh-form-panel__head">Task details (auto-filled from conversation)</div>
            <div className="nh-form-panel__body">
              <div className={`nh-form-field ${engine.state.title.trim() ? 'nh-form-field--filled' : 'nh-form-field--pending'}`}>
                <div className="nh-form-field__k">Title</div>
                <div className="nh-form-field__v">
                  {engine.state.title.trim() || 'pending…'}
                  {engine.state.title.trim() && <span className="nh-form-field__check">✓</span>}
                </div>
              </div>
              {template.fields.map((f) => {
                const value = engine.state.values[f.key];
                const filled = value !== undefined;
                return (
                  <div
                    key={f.key}
                    className={`nh-form-field ${filled ? 'nh-form-field--filled' : 'nh-form-field--pending'}`}
                  >
                    <div className="nh-form-field__k">
                      {f.label}
                      {!f.required && <span className="nh-form-field__optional"> (optional)</span>}
                    </div>
                    <div className="nh-form-field__v">
                      {filled ? value : 'pending…'}
                      {filled && f.agentFetchable && <span className="nh-form-field__badge" title="Agent-fetched">🤖</span>}
                      {filled && <span className="nh-form-field__check">✓</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="nh-form-panel__foot">
              {err && <p className="nh-modal__error">{err}</p>}
              <button type="button" disabled={!canSubmit || busy || succeeded} onClick={() => void approve()}>
                {succeeded ? 'Started ✓' : busy ? 'Starting…' : 'Approve & Start Task'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
