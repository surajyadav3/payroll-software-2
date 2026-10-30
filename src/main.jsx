import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import './styles/theme-crewcore.css';
import { applyUiTheme } from './lib/uiTheme';

// Picks the CrewCore theme or the classic UI before the first render (see src/lib/uiTheme.js).
applyUiTheme();

// After a redeploy an open tab can ask for a chunk that no longer exists; reload once to pick up the new build.
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem('chunk-reload')) return;
  sessionStorage.setItem('chunk-reload', '1');
  event.preventDefault();
  window.location.reload();
});
window.addEventListener('load', () => setTimeout(() => sessionStorage.removeItem('chunk-reload'), 10000));

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </ErrorBoundary>
);
