import { apiClient } from "./client";

export interface GeneratedFile {
  id: string;
  name: string;
  language: "javascript" | "ini" | "markdown";
  content: string;
}

export interface InstrumentationResult {
  files: GeneratedFile[];
  runCommand: string;
  estimatedSetupSeconds: number;
}

/** POST /repos/:id/instrument — generate OTel instrumentation files */
export async function generateInstrumentation(
  repositoryId: string,
): Promise<InstrumentationResult> {
  const { data } = await apiClient.post<InstrumentationResult>(
    `/repos/${repositoryId}/instrument`,
  );
  return data;
}
