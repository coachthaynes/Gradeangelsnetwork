import { getStore } from "@netlify/blobs";

// One shared store for every assignment file, source uploads from teachers
// and graded uploads from Grade Angels alike. Keys are namespaced by kind
// and assignment id, e.g. "source/42/worksheet.pdf" or "graded/42/worksheet.pdf".
// Strong consistency because a function sometimes writes a file and a later
// call in the same flow may need to read it back right away.
export function assignmentFilesStore() {
  return getStore({ name: "assignment-files", consistency: "strong" });
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() || "file";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150) || "file";
}
