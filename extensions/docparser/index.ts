import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDoctorCommand } from "./doctor.ts";
import { createNativeExecutor } from "./native-executor.ts";
import { registerDocumentParseTool } from "./tool.ts";
import { registerDocumentSearchTool } from "./search-tool.ts";
import { registerDocumentScreenshotTool } from "./screenshot-tool.ts";

export default function parseDocumentExtension(pi: ExtensionAPI): void {
  const executor = createNativeExecutor();
  pi.on("session_shutdown", async () => {
    await executor.dispose();
  });
  registerDocumentParseTool(pi, executor);
  registerDocumentSearchTool(pi, executor);
  registerDocumentScreenshotTool(pi, executor);
  registerDoctorCommand(pi);
}
