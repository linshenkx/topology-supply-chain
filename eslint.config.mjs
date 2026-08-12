import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "**/dist/**",
    "out/**",
    "outputs/**",
    ".tmp/**",
    ".wrangler/**",
    ".pnpm-store/**",
    "archive/**",
    "coverage/**",
    "node_modules/**",
    "*.tsbuildinfo",
    "next-env.d.ts",
  ]),
  {
    files: ["tests/**/*.{js,mjs,cjs,ts}", "scripts/**/*.{js,mjs,cjs,ts}"],
    rules: {
      "@next/next/no-assign-module-variable": "off",
    },
  },
  {
    files: ["types/**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
