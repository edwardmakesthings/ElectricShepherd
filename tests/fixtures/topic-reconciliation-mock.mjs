// Model seam only; production never parses headings or text into fabricated sections.
export function reconciliationResponse(prompt) {
  return prompt.split("NEXT CHRONOLOGICAL FINDINGS\n")[1];
}
