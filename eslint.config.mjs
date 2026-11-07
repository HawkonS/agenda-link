import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "apps/web/dist/**",
      "apps/server/dist/**",
      "data/**",
      "logs/**",
      ".runtime/**",
      "tools/maintenance/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/server/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}", "apps/web/**/*.test.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["tools/**/*.mjs", "*.mjs", "*.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // TypeScript 已经检查这些，避免与类型检查重复报错。
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-unused-expressions": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-control-regex": "off",
      "prefer-const": "warn",
    },
  },
  {
    files: ["**/*.test.{ts,tsx,mjs}", "tools/test/**/*.mjs"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
);
