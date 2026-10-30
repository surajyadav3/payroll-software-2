import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// Flat config (ESLint 9). Edge functions (Deno) and build output are linted
// separately / not at all.
export default [
  { ignores: ['dist', 'node_modules', 'supabase/functions', 'test-results', 'playwright-report', 'cloudflare'] },
  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...js.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // JSX usage isn't tracked without eslint-plugin-react; ignore PascalCase imports.
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // The screens ported from the new CrewCore platform render `<motion.div>` and icon
    // components passed as props (`icon: I` → `<I />`); neither is seen as "used" without
    // eslint-plugin-react.
    files: ['src/crew/**/*.{js,jsx}'],
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]|^motion$', argsIgnorePattern: '^_|^[A-Z]', caughtErrors: 'none' }],
    },
  },
];
