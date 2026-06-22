import nextConfig from "eslint-config-next";

export default [
  ...nextConfig,
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "dist/**",
      "node_modules/**",
      "functions/lib/**",
      "functions/node_modules/**",
      "next-env.d.ts",
      "extensions/**/dist/**",
    ],
  },
];
