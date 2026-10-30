import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** The company's departments: [{ id, name, isActive }] (KPI owners and filters). */
export const useDepartmentTree = () => useQuery({ queryKey: ['departments', 'tree'], queryFn: () => api('/departments/tree').then((r) => r.data), staleTime: 5 * 60_000 });
