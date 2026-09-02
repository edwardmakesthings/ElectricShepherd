/**
 * Baseline ESLint flat config.
 *
 * This repo is primarily TypeScript executed with Node's strip-types flow, but
 * does not carry @typescript-eslint in devDependencies. Keep ESLint focused on
 * JavaScript surfaces so verify gets real lint signal without parser/plugin debt.
 */
export default [
  {
    ignores: [
      "**/node_modules/**",
      ".opencode/**",
      ".electric-shepherd/**",
      "coverage/**",
      "dist/**",
      "build/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        globalThis: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-unreachable": "error",
      eqeqeq: ["error", "always"],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
]
