import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/context/FeatureContext';
import { askAssistant } from '@/services/aiService';

// Floating CrewCore Assistant (pending-list item 11). Shown only when the
// premium 'ai_assistant' feature is on for the company. The conversation
// lives in sessionStorage (this tab only) — nothing is stored server-side.
// Other pages open it with: window.dispatchEvent(new CustomEvent('crewcore:open-assistant'))

const STORE_KEY = 'crewcore.assistant.v1';
const SUGGESTIONS = [
  'How many leaves do I have left?',
  'Show my overdue tasks',
  'How do I regularize a missed punch?',
  'Create a task for me to submit the report by Friday',
];

const load = () => { try { return JSON.parse(sessionStorage.getItem(STORE_KEY)) || []; } catch { return []; } };
const save = (m) => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(m.slice(-30))); } catch { /* private mode */ } };

export default function AssistantWidget() {
  const { profile } = useAuth();
  const { isEnabled } = useFeatures();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(load);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  const enabled = !!profile && profile.role !== 'superadmin' && isEnabled('ai_assistant');

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('crewcore:open-assistant', onOpen);
    return () => window.removeEventListener('crewcore:open-assistant', onOpen);
  }, []);
  useEffect(() => { save(messages); }, [messages]);
  useEffect(() => { if (open) { bottomRef.current?.scrollIntoView({ block: 'end' }); inputRef.current?.focus(); } }, [open, messages, busy]);

  if (!enabled) return null;

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setBusy(true);
    const { data, error } = await askAssistant(next.map(({ role, content: c }) => ({ role, content: c })));
    setBusy(false);
    setMessages((m) => [...m, error
      ? { role: 'assistant', content: error, isError: true }
      : { role: 'assistant', content: data.reply, actions: data.actions || [], tasks: data.tasks_created || [] }]);
  };

  const panel = {
    position: 'fixed', right: 20, bottom: 86, width: 'min(380px, calc(100vw - 32px))', height: 'min(560px, calc(100vh - 120px))',
    background: 'var(--surface)', borderRadius: 16, boxShadow: '0 12px 40px rgba(0,0,0,.18)', border: '1px solid var(--border-light)',
    display: 'flex', flexDirection: 'column', zIndex: 1200, overflow: 'hidden',
  };

  return (
    <>
      {open && (
        <div className="assistant-float" style={panel} role="dialog" aria-label="CrewCore Assistant">
          <div style={{ padding: '12px 14px', background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
            <i className="fas fa-robot" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>CrewCore Assistant</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>Answers from your own CrewCore data</div>
            </div>
            {messages.length > 0 && (
              <button title="New chat" onClick={() => setMessages([])} style={{ background: 'none', border: 0, color: '#fff', cursor: 'pointer' }}>
                <i className="fas fa-rotate-right" />
              </button>
            )}
            <button title="Close" onClick={() => setOpen(false)} style={{ background: 'none', border: 0, color: '#fff', cursor: 'pointer', fontSize: 16 }}>
              <i className="fas fa-xmark" />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                <p style={{ margin: '0 0 10px' }}>Hi {profile.first_name || 'there'}! Ask me how to do something in CrewCore, or about your leave, attendance, payslips and tasks.</p>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="btn btn-outline btn-sm" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
                <div style={{
                  padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
                  background: m.role === 'user' ? 'var(--primary)' : m.isError ? 'var(--danger-light)' : 'var(--bg)',
                  color: m.role === 'user' ? '#fff' : m.isError ? 'var(--danger)' : 'var(--text)',
                }}>{m.content}</div>
                {m.tasks?.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 4 }}>
                    <i className="fas fa-check" style={{ marginRight: 4 }} />Created: {m.tasks.map((t) => `${t.title} → ${t.assignee}`).join('; ')}
                  </div>
                )}
                {m.actions?.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {m.actions.map((a) => (
                      <button key={a.path} className="btn btn-primary btn-sm" onClick={() => { navigate(a.path); if (window.innerWidth < 700) setOpen(false); }}>
                        {a.label} <i className="fas fa-arrow-right" style={{ marginLeft: 4 }} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <div style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--text-muted)' }}><i className="fas fa-circle-notch fa-spin" style={{ marginRight: 6 }} />Thinking…</div>}
            <div ref={bottomRef} />
          </div>

          <div style={{ padding: 10, borderTop: '1px solid var(--border-light)', display: 'flex', gap: 8 }}>
            <textarea ref={inputRef} className="form-input" rows={1} maxLength={2000} placeholder="Ask anything about CrewCore…" value={input}
              style={{ resize: 'none' }}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button className="btn btn-primary btn-sm" disabled={busy || !input.trim()} onClick={() => send()} aria-label="Send"><i className="fas fa-paper-plane" /></button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', paddingBottom: 6 }}>AI can make mistakes — check important details.</div>
        </div>
      )}

      <button className="assistant-float" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close assistant' : 'Open assistant'} title="CrewCore Assistant"
        style={{
          position: 'fixed', right: 20, bottom: 20, width: 54, height: 54, borderRadius: '50%', border: 0, cursor: 'pointer', zIndex: 1200,
          background: 'var(--primary)', color: '#fff', fontSize: 20, boxShadow: '0 6px 20px rgba(108,92,231,.45)',
        }}>
        <i className={`fas ${open ? 'fa-xmark' : 'fa-robot'}`} />
      </button>
    </>
  );
}
