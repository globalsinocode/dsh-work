import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        parser: tseslint.parser,
        tsconfigRootDir: rootDir,
        projectService: true,
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // rest-siblings 解构用于「丢弃内部字段后输出」，被丢弃的属性不是未使用变量。
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['server/**/*.ts', 'scripts/**/*.{mjs,ts}', 'apps/*/scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        tsconfigRootDir: rootDir,
        projectService: true,
      },
    },
  },
)
