import React from 'react';
import { useSearchParams } from 'react-router-dom';
import Header from '@/components/Header';
import { useAuth } from '@/context/AuthContext';
import HomeDashboard from './HomeDashboard';
import WelcomeContent from './WelcomeContent';
import { fullName } from '@/lib/helpers';

export default function HomePage() {
  const { profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'welcome' ? 'welcome' : 'dashboard';

  const setTab = (t) => setSearchParams(t === 'dashboard' ? {} : { tab: t });

  return (
    <>
      <Header title="Home" breadcrumb={profile ? fullName(profile) : ''} />

      <div className="tab-bar-wrap">
        <div className="tabs">
          <button className={`tab-btn ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>Dashboard</button>
          <button className={`tab-btn ${tab === 'welcome' ? 'active' : ''}`} onClick={() => setTab('welcome')}>Welcome</button>
        </div>
      </div>

      {tab === 'dashboard' && <HomeDashboard />}

      {tab === 'welcome' && <WelcomeContent />}
    </>
  );
}
