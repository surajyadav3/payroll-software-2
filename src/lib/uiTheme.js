// Which visual theme the app renders with.
//
//   'crewcore' — the new CrewCore look (Geist, iris palette, light sidebar),
//                styled by src/styles/theme-crewcore.css.
//   'classic'  — the original UI exactly as it was (src/index.css alone).
//
// The new theme's rules are all scoped under <html data-ui="crewcore">, so
// switching to 'classic' removes every one of them — nothing in index.css
// was changed. To go back to the old UI for everyone, set
// VITE_UI_THEME=classic in the build env (or Hostinger/Vercel env) and rebuild.
//
// For a side-by-side look in one browser without a rebuild, open any page with
// ?ui=classic or ?ui=crewcore — the choice is remembered in that browser only.

const THEMES = ['crewcore', 'classic'];
const STORAGE_KEY = 'cc-ui-theme';

export function resolveUiTheme() {
  let override = null;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('ui');
    if (THEMES.includes(fromUrl)) {
      localStorage.setItem(STORAGE_KEY, fromUrl);
      override = fromUrl;
    } else {
      override = localStorage.getItem(STORAGE_KEY);
    }
  } catch {
    /* storage blocked — fall through to the build default */
  }
  if (THEMES.includes(override)) return override;
  const fromEnv = import.meta.env.VITE_UI_THEME;
  return THEMES.includes(fromEnv) ? fromEnv : 'crewcore';
}

export function applyUiTheme() {
  const theme = resolveUiTheme();
  document.documentElement.dataset.ui = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'crewcore' ? '#F5F6FA' : '#1A1B2E');
  return theme;
}
