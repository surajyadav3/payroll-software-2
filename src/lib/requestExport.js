import * as XLSX from 'xlsx';
import { todayStr } from '@/lib/helpers';

// Requests pages: the list as shown (status tab, outlets, search applied) as
// an .xlsx for HR to send to management. `rows` are plain { Column: value }.
export function exportRequestSheet(rows, { sheet, file, widths }) {
  const ws = XLSX.utils.json_to_sheet(rows);
  if (widths) ws['!cols'] = widths.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
  XLSX.writeFile(wb, `${file.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${todayStr()}.xlsx`);
}

export const fmtExportDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
};

export const approverRoleLabel = (role) => (role === 'admin' ? 'HR' : role === 'manager' ? 'Manager'
  : role === 'hod' ? 'HOD' : role || '');
