// @ts-check
import eslint from "@eslint/js";
import tsEslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default tsEslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "eslint.config.js"],
  },
  eslint.configs.recommended,
  ...tsEslint.configs.recommended,
  prettierConfig,
  {
    plugins: { prettier: prettierPlugin },
    rules: {
      "prettier/prettier": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["test/**/*.ts"],
    plugins: { vitest },
    rules: { ...vitest.configs.recommended.rules },
  }
);
