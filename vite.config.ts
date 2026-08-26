import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin.ts";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] || "";
const isProjectPage =
  process.env.GITHUB_ACTIONS === "true" &&
  repositoryName.length > 0 &&
  !repositoryName.endsWith(".github.io");
const inferredBase = isProjectPage ? `/${repositoryName}/` : "/";
const configuredBase = process.env.PAGES_BASE_PATH;
const base = configuredBase === undefined
  ? inferredBase
  : configuredBase
    ? `/${configuredBase.replace(/^\/*|\/*$/g, "")}/`
    : "/";

export default defineConfig({
  base,
  plugins: [react(), sites()],
  build: {
    chunkSizeWarningLimit: 600,
  },
});
