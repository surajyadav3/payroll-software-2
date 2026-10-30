import { useFeatures } from '@/context/FeatureContext';

/**
 * Which parts of Work and Performance this company has switched on (HR → Toggle Services).
 * The screens only hide what is off; the server refuses it as well.
 */
export function useCrewFeatures() {
    const { isEnabled } = useFeatures();
    return {
        tasks: isEnabled('tasks'),
        projects: isEnabled('projects'),
        chat: isEnabled('team_chat'),
        goals: isEnabled('performance_kras'),
        reviews: isEnabled('performance_reviews'),
    };
}
