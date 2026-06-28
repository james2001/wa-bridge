// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  // Fichiers/artefacts non lintés.
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/api/prisma/migrations/**',
      '**/*.config.{js,cjs,mjs,ts}',
      'eslint.config.mjs',
    ],
  },

  // Base commune (JS + TypeScript recommandé, sans type-checking pour rester rapide).
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `no-explicit-any` est désactivé (frontières Baileys/Prisma) ; on n'alerte
    // donc pas sur les directives `eslint-disable` de cette règle restées en place.
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      // Frontière Baileys/Prisma: `any` est inévitable et déjà annoté localement.
      '@typescript-eslint/no-explicit-any': 'off',
      // Code mort = erreur, mais on autorise le préfixe `_` pour l'intention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Les `catch {}` volontaires (best-effort) sont permis.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Backend NestJS (Node).
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Frontend React (navigateur).
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
);
