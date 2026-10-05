import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {ignores: ['dist/', 'node_modules/', 'fixtures/', 'coverage/', '.agents/']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'examples/**/*.mjs', 'bin/*.js', '*.js'],
    languageOptions: {globals: {process: 'readonly', console: 'readonly'}},
  },
  prettier,
)
