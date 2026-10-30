import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import {
  extractMeeting, cleanTranscript, listMeetingNotes, saveMeetingNotes, updateMeetingActionItems,
  deleteMeetingNotes, createTaskFromActionItem, listAssignablePeople, TASK_PRIORITIES,
} from '@/services/aiService';
import { fmt, fullName, todayStr } from '@/lib/helpers';

// AI meeting notes (pending-list item 10): paste/upload a transcript → AI
// summary + action items → review/edit → save notes and create tasks.
// The transcript itself is never stored.

const MAX_CHARS = 120000;
const EMPTY_DRAFT = { title: '', meeting_date: todayStr(), transcript: '' };

export default function MeetingsPage() {
  const { tenant, profile } = useAuth();
  const navigate = useNavigate();
  const [notes, setNotes] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState(null);            // null | 'input' | 'review'
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [result, setResult] = useState(null);         // extraction being reviewed
  const [working, setWorking] = useState(false);
  const [viewing, setViewing] = useState(null);

  const fetchNotes = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    const { data, error } = await listMeetingNotes(tenant.id);
    if (error) showToast(error.message, 'error');
    setNotes(data);
    setLoading(false);
  }, [tenant]);

  useEffect(() => { fetchNotes(); }, [fetchNotes]);
  useEffect(() => { listAssignablePeople().then(({ data }) => setPeople(data)); }, []);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const handleFile = (file) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return showToast('File is larger than 2 MB', 'error');
    if (!/\.(txt|vtt|srt)$/i.test(file.name)) return showToast('Upload a .txt, .vtt or .srt transcript', 'error');
    const reader = new FileReader();
    reader.onload = () => setDraft((d) => ({
      ...d,
      transcript: cleanTranscript(reader.result),
      title: d.title || file.name.replace(/\.(txt|vtt|srt)$/i, '').replace(/[_-]+/g, ' ').slice(0, 120),
    }));
    reader.readAsText(file);
  };

  const handleExtract = async () => {
    const transcript = cleanTranscript(draft.transcript);
    if (!draft.title.trim()) return showToast('Give the meeting a title', 'error');
    if (transcript.length < 80) return showToast('Paste the meeting transcript first', 'error');
    if (transcript.length > MAX_CHARS) return showToast(`Transcript is too long — split it into parts of ${MAX_CHARS.toLocaleString()} characters`, 'error');
    setWorking(true);
    const { data, error } = await extractMeeting({ title: draft.title, meeting_date: draft.meeting_date, transcript });
    setWorking(false);
    if (error) return showToast(error, 'error');
    setResult({
      ...data,
      action_items: data.action_items.map((a) => ({ ...a, include: true, assignee_id: a.assignee_id || '' })),
    });
    setStep('review');
  };

  const setItem = (idx, patch) => setResult((r) => ({ ...r, action_items: r.action_items.map((a, i) => (i === idx ? { ...a, ...patch } : a)) }));

  const handleSave = async () => {
    const chosen = result.action_items.filter((a) => a.include);
    if (chosen.some((a) => !a.title.trim())) return showToast('Every selected action item needs a title', 'error');
    if (chosen.some((a) => !a.assignee_id)) return showToast('Choose an assignee for every selected action item (or untick it)', 'error');
    setWorking(true);
    try {
      const items = [];
      let failed = 0;
      for (const a of result.action_items) {
        const base = {
          title: a.title.trim(), description: a.description || '', priority: a.priority, due_date: a.due_date || null,
          assignee_id: a.assignee_id || null, assignee_name: a.assignee_id ? fullName(peopleById.get(a.assignee_id)) : null, task_id: null,
        };
        if (a.include) {
          const { id, error } = await createTaskFromActionItem(tenant.id, base, draft.title);
          if (error) { failed++; base.error = error.message; } else base.task_id = id;
        }
        items.push(base);
      }
      const { error } = await saveMeetingNotes(tenant.id, profile.id, {
        title: draft.title, meeting_date: draft.meeting_date, summary: result.summary,
        decisions: result.decisions, action_items: items, transcript_chars: result.transcript_chars,
      });
      if (error) return showToast('Tasks were created, but saving the notes failed: ' + error.message, 'error');
      const created = items.filter((i) => i.task_id).length;
      showToast(`Meeting saved · ${created} task${created === 1 ? '' : 's'} created${failed ? ` · ${failed} failed` : ''}`, failed ? 'error' : 'success');
      setStep(null);
      setResult(null);
      setDraft(EMPTY_DRAFT);
      fetchNotes();
    } finally {
      setWorking(false);
    }
  };

  const handleCreateLater = async (note, idx) => {
    const item = note.action_items[idx];
    if (!item.assignee_id) return showToast('This item has no assignee — open Tasks to create it manually', 'error');
    const { id, error } = await createTaskFromActionItem(tenant.id, item, note.title);
    if (error) return showToast(error.message, 'error');
    const items = note.action_items.map((a, i) => (i === idx ? { ...a, task_id: id, error: undefined } : a));
    await updateMeetingActionItems(note.id, items);
    setViewing({ ...note, action_items: items });
    fetchNotes();
    showToast('Task created', 'success');
  };

  const handleDelete = async (note) => {
    if (!window.confirm(`Delete the notes for "${note.title}"? Tasks already created are kept.`)) return;
    const { error } = await deleteMeetingNotes(note.id);
    if (error) return showToast(error.message, 'error');
    setViewing(null);
    fetchNotes();
  };

  const charCount = draft.transcript.length;

  return (
    <>
      <Header title="Meeting Notes" breadcrumb="Turn meeting transcripts into summaries and assigned tasks with AI"
        actions={<button className="btn btn-primary" onClick={() => { setDraft(EMPTY_DRAFT); setStep('input'); }}><i className="fas fa-wand-magic-sparkles" style={{ marginRight: 6 }} />New Meeting Notes</button>}
      />
      <div className="page-content">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : notes.length === 0 ? (
          <div className="card"><div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
            <i className="fas fa-microphone-lines" style={{ fontSize: 32, color: 'var(--primary)', marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 6px' }}>No meeting notes yet</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 16px' }}>
              Export the transcript from Google Meet, Zoom or Teams (or paste your own notes), and CrewCore will write the summary and turn action items into tasks.
            </p>
            <button className="btn btn-primary" onClick={() => setStep('input')}>Create meeting notes</button>
          </div></div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Meeting</th><th>Date</th><th>Action items</th><th>By</th></tr></thead>
                <tbody>
                  {notes.map((n) => {
                    const tasks = n.action_items.filter((a) => a.task_id).length;
                    return (
                      <tr key={n.id} style={{ cursor: 'pointer' }} onClick={() => setViewing(n)}>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{n.title}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.summary}</div>
                        </td>
                        <td style={{ fontSize: 12 }}>{fmt.date(n.meeting_date)}</td>
                        <td style={{ fontSize: 12 }}>{n.action_items.length} · {tasks} task{tasks === 1 ? '' : 's'}</td>
                        <td style={{ fontSize: 12 }}>{fullName(n.creator) || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Step 1: transcript */}
      <Modal show={step === 'input'} onClose={() => !working && setStep(null)} title="New Meeting Notes" width="680px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setStep(null)} disabled={working}>Cancel</button>
          <button className="btn btn-primary" onClick={handleExtract} disabled={working}>
            {working ? <><i className="fas fa-circle-notch fa-spin" style={{ marginRight: 6 }} />Reading the meeting…</> : <><i className="fas fa-wand-magic-sparkles" style={{ marginRight: 6 }} />Extract with AI</>}
          </button>
        </>}
      >
        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label className="form-label">Meeting title *</label>
            <input className="form-input" maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Weekly sales review" />
          </div>
          <div className="form-group">
            <label className="form-label">Date *</label>
            <input className="form-input" type="date" value={draft.meeting_date} onChange={(e) => setDraft({ ...draft, meeting_date: e.target.value })} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Transcript or notes *</span>
            <span style={{ color: charCount > MAX_CHARS ? 'var(--danger)' : 'var(--text-muted)', fontWeight: 400 }}>{charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}</span>
          </label>
          <textarea className="form-input" rows={12} value={draft.transcript} onChange={(e) => setDraft({ ...draft, transcript: e.target.value })}
            placeholder={'Paste the transcript here, e.g.\nRahul: Let\'s close the vendor contract by Friday.\nPriya: I\'ll send the revised quote tomorrow.'} />
        </div>
        <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
          <i className="fas fa-upload" style={{ marginRight: 6 }} />Upload .txt / .vtt / .srt
          <input type="file" accept=".txt,.vtt,.srt,text/plain,text/vtt" hidden onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <div className="form-hint" style={{ marginTop: 10 }}>
          The transcript is sent to the AI only to read it — CrewCore does not store it. Only the summary and action items you approve are saved.
        </div>
      </Modal>

      {/* Step 2: review */}
      <Modal show={step === 'review' && !!result} onClose={() => !working && setStep('input')} title={`Review: ${draft.title}`} width="900px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setStep('input')} disabled={working}>Back</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={working}>
            {working ? 'Saving…' : `Save notes & create ${result?.action_items.filter((a) => a.include).length || 0} task(s)`}
          </button>
        </>}
      >
        {result && (
          <>
            <div className="form-group">
              <label className="form-label">Summary</label>
              <textarea className="form-input" rows={5} value={result.summary} onChange={(e) => setResult({ ...result, summary: e.target.value })} />
            </div>
            {result.decisions.length > 0 && (
              <div className="form-group">
                <label className="form-label">Decisions</label>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>{result.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
            )}
            <label className="form-label">Action items → tasks</label>
            {result.action_items.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No action items were found in this meeting.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th style={{ width: 30 }} /><th>Task</th><th>Assignee</th><th>Due</th><th>Priority</th></tr></thead>
                  <tbody>
                    {result.action_items.map((a, i) => (
                      <tr key={i} style={{ opacity: a.include ? 1 : 0.5 }}>
                        <td><input type="checkbox" checked={a.include} onChange={(e) => setItem(i, { include: e.target.checked })} /></td>
                        <td style={{ minWidth: 220 }}>
                          <input className="form-input" style={{ fontSize: 12 }} value={a.title} onChange={(e) => setItem(i, { title: e.target.value })} />
                          {a.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{a.description}</div>}
                        </td>
                        <td style={{ minWidth: 170 }}>
                          <select className="form-select" style={{ fontSize: 12 }} value={a.assignee_id} onChange={(e) => setItem(i, { assignee_id: e.target.value })}>
                            <option value="">Choose…</option>
                            {people.map((p) => <option key={p.id} value={p.id}>{p.id === profile.id ? `Me (${fullName(p)})` : fullName(p)}</option>)}
                          </select>
                          {!a.assignee_id && a.unassigned_reason && <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 3 }}>{a.unassigned_reason}</div>}
                        </td>
                        <td><input className="form-input" type="date" style={{ fontSize: 12 }} value={a.due_date || ''} onChange={(e) => setItem(i, { due_date: e.target.value || null })} /></td>
                        <td>
                          <select className="form-select" style={{ fontSize: 12 }} value={a.priority} onChange={(e) => setItem(i, { priority: e.target.value })}>
                            {TASK_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="form-hint" style={{ marginTop: 8 }}>AI can make mistakes — check owners and dates before saving. Untick anything that shouldn't become a task.</div>
          </>
        )}
      </Modal>

      {/* Saved meeting */}
      <Modal show={!!viewing} onClose={() => setViewing(null)} title={viewing?.title || ''} width="760px"
        footer={viewing && <>
          {(viewing.created_by === profile?.id || ['admin', 'superadmin'].includes(profile?.role)) && (
            <button className="btn btn-outline" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={() => handleDelete(viewing)}><i className="fas fa-trash" style={{ marginRight: 6 }} />Delete</button>
          )}
          <button className="btn btn-primary" onClick={() => setViewing(null)}>Close</button>
        </>}
      >
        {viewing && (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{fmt.date(viewing.meeting_date)} · by {fullName(viewing.creator) || '—'}</div>
            <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>Summary</h4>
            <p style={{ fontSize: 13, whiteSpace: 'pre-wrap', margin: '0 0 14px' }}>{viewing.summary || '—'}</p>
            {viewing.decisions?.length > 0 && (
              <>
                <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>Decisions</h4>
                <ul style={{ margin: '0 0 14px', paddingLeft: 20, fontSize: 13 }}>{viewing.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </>
            )}
            <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>Action items</h4>
            {viewing.action_items.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>None.</p> : viewing.action_items.map((a, i) => (
              <div key={i} className="settings-list-row" style={{ alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {a.assignee_name || 'Unassigned'} · {a.priority}{a.due_date ? ` · due ${fmt.date(a.due_date)}` : ''}{a.error ? ` · failed: ${a.error}` : ''}
                  </div>
                </div>
                {a.task_id ? (
                  <button className="btn btn-outline btn-sm" onClick={() => navigate(`/tasks?task=${a.task_id}`)}>Open task</button>
                ) : (viewing.created_by === profile?.id) && (
                  <button className="btn btn-outline btn-sm" onClick={() => handleCreateLater(viewing, i)}>Create task</button>
                )}
              </div>
            ))}
          </>
        )}
      </Modal>
    </>
  );
}
