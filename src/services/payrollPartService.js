import { supabase } from '@/lib/supabase';

// payroll_part_runs: the two runs of a month HR pays in two parts (Raniwala,
// Sept 2026 — see raniwalaSplitFor). One row per part with every employee's
// figures frozen in `lines`; the final payslip adds the two up. A part cannot
// be changed once the month's final payroll exists (DB trigger), see
// 20261013_1_raniwala_split_payroll_and_release.sql.

const COLUMNS = 'id, part, from_date, to_date, pf_rule, lines, run_by, run_at';

/** The month's part runs as `{ [part]: row }`. `month` is 0-indexed. */
export async function fetchPartRuns(tenantId, month, year) {
  const { data, error } = await supabase
    .from('payroll_part_runs')
    .select(COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('year', year)
    .eq('month', month + 1);
  return { data: Object.fromEntries((data || []).map((r) => [r.part, r])), error };
}

/** Run one part: store every employee's line for it. */
export async function savePartRun({ tenantId, month, year, part, lines, runBy }) {
  const { data, error } = await supabase
    .from('payroll_part_runs')
    .insert({
      tenant_id: tenantId, year, month: month + 1, part: part.part,
      from_date: part.fromDate, to_date: part.toDate, pf_rule: part.pfRule,
      lines, run_by: runBy,
    })
    .select(COLUMNS)
    .single();
  return { data, error };
}

/** Replace a run part's lines (HR changed PF ticks after the run). */
export async function updatePartRunLines(id, lines) {
  const { data, error } = await supabase
    .from('payroll_part_runs')
    .update({ lines })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  return { data, error };
}

/** Undo a part run (only while the month's final payroll is not processed). */
export async function deletePartRun(id) {
  const { error } = await supabase.from('payroll_part_runs').delete().eq('id', id);
  return { error };
}
