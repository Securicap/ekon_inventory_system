import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules that encode architecture decisions, not just style.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'backend/public/**',
      '**/coverage/**',
      '**/*.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  /**
   * Module boundaries. The monolith stays modular only if the boundaries are
   * mechanically enforced — a module may not reach into another module's
   * internals, and in particular may not touch another module's tables.
   * Cross-module work goes through an application service.
   */
  {
    files: ['backend/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*/domain/**', '**/modules/*/infrastructure/**'],
              message:
                "Do not import another module's internals. Use its application service instead.",
            },
            {
              group: ['../../*/infrastructure/**', '../../*/domain/**'],
              message:
                "Do not import another module's internals. Use its application service instead.",
            },
          ],
        },
      ],
    },
  },

  /**
   * The platform layer is infrastructure and must not depend on any domain
   * module. Dependencies point inward only.
   */
  {
    files: ['backend/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**'],
              message: 'platform/ must not depend on a domain module. Dependencies point inward.',
            },
          ],
        },
      ],
    },
  },

  /**
   * The shared package crosses the wire and must stay dependency-free apart
   * from zod.
   */
  {
    files: ['shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ekon/backend', '@ekon/frontend', '**/backend/**', '**/frontend/**'],
              message: '@ekon/shared must not depend on backend or frontend code.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  /** Repository tooling: plain Node scripts run by CI and by `make`. */
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
