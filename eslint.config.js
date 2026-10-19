import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

const rootDir = dirname(fileURLToPath(import.meta.url))

const typedParserOptions = {
  tsconfigRootDir: rootDir,
  projectService: {
    allowDefaultProject: [
      'scripts/*.mjs',
      'scripts/acceptance/*.mjs',
      'scripts/checks/*.mjs',
      'scripts/ci/*.mjs',
      'scripts/deploy/*.mjs',
      'scripts/release/*.mjs',
      'scripts/runtime/*.mjs',
      'scripts/testing/*.mjs',
      'apps/admin-web/scripts/*.mjs',
      'apps/workbench-web/scripts/*.mjs',
    ],
  },
  extraFileExtensions: ['.vue'],
}

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
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ...typedParserOptions,
      },
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: typedParserOptions,
    },
  },
  {
    files: ['server/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node },
    },
  },
)
