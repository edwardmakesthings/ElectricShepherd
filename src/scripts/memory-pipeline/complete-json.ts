/** Parse the entire bounded response; never salvage nested objects from truncation. */
export function parseCompleteJSON(text: string, maxBytes = 16_000): unknown {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("extraction-output-too-large");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("extraction-output-empty");
  return JSON.parse(trimmed);
}
