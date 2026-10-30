import { supabase } from '@/lib/supabase';

// AI assistant (item 11) + AI meeting notes (item 10). The Claude calls happen
// in the ai-assistant / ai-meeting-extract edge functions; this file only
// invokes them and handles meeting_notes rows.

/** Pulls the `{ error, code }` body out of a non-2xx edge-function response. */
async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return { data, error: null };
  let msg = error.message;
  let code = null;
  try {
    const parsed = await error.context?.json();
    msg = parsed?.error || msg;
    code = parsed?.code || null;
  } catch { /* keep the generic message */ }
  return { data: null, error: msg, code };
}

/** messages: [{ role: 'user'|'assistant', content }], last one from the user. */
export const askAssistant = (messages) => invoke('ai-assistant', { messages });

export const extractMeeting = ({ title, meeting_date, transcript }) =>
  invoke('ai-meeting-extract', { title, meeting_date, transcript });

/** Strips WebVTT/SRT cue numbers + timestamps so only "Speaker: text" lines remain. */
export function cleanTranscript(raw) {
  return String(raw || '')
    .replace(/^﻿/, '')
    .replace(/^WEBVTT.*$/m, '')
    .split(/\r?\n/)
    .filter((line) => !/^\d+$/.test(line.trim()))
    .filter((line) => !/^\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}\s*-->/.test(line.trim()))
    .filter((line) => !/^(NOTE|STYLE)\b/.test(line.trim()))
    .map((line) => line.replace(/<v\s+([^>]+)>/g, '$1: ').replace(/<\/?[^>]+>/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

export async function listMeetingNotes(tenantId) {
  const { data, error } = await supabase
    .from('meeting_notes')
    .select('id, title, meeting_date, summary, decisions, action_items, created_by, created_at, creator:profile_directory!meeting_notes_created_by_fkey(first_name, last_name)')
    .eq('tenant_id', tenantId)
    .order('meeting_date', { ascending: false })
    .limit(100);
  return { data: data || [], error };
}

export async function saveMeetingNotes(tenantId, profileId, note) {
  const { data, error } = await supabase.from('meeting_notes').insert([{
    tenant_id: tenantId,
    created_by: profileId,
    title: note.title.trim().slice(0, 200),
    meeting_date: note.meeting_date,
    summary: (note.summary || '').slice(0, 6000),
    decisions: note.decisions || [],
    action_items: note.action_items || [],
    transcript_chars: note.transcript_chars || 0,
  }]).select('id').single();
  return { data, error };
}

export async function updateMeetingActionItems(id, actionItems) {
  const { error } = await supabase.from('meeting_notes').update({ action_items: actionItems }).eq('id', id);
  return { error };
}

export async function deleteMeetingNotes(id) {
  const { error } = await supabase.from('meeting_notes').delete().eq('id', id);
  return { error };
}

export const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

/** People the caller may give a task to (self + reporting tree; everyone for HR). */
export async function listAssignablePeople() {
  const { data, error } = await supabase.rpc('task_assignable_people');
  return { data: data || [], error };
}

/**
 * Creates one task from a reviewed action item; returns the new task id. Goes through the task
 * register (work_api), so it gets a number, the assignee is notified and the usual rules apply.
 */
export async function createTaskFromActionItem(tenantId, item, meetingTitle) {
  const description = [item.description, `From meeting: ${meetingTitle}`].filter(Boolean).join('\n\n');
  const { data, error } = await supabase.rpc('work_api', {
    p_method: 'POST',
    p_path: '/work/tasks',
    p_query: {},
    p_body: {
      title: item.title.trim().slice(0, 250),
      description,
      ...(item.assignee_id ? { assigneeEmployeeId: item.assignee_id } : {}),
      priority: String(item.priority || 'Medium').toLowerCase(),
      dueDate: item.due_date || null,
    },
  });
  return { id: data?.id || null, error };
}
