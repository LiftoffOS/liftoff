/**
 * Citation — a reference to a source document embedded in an agent response.
 *
 * The agent emits a <CITATIONS>[...JSON...]</CITATIONS> block at the end of
 * its message. The chat service strips the block before persisting the visible
 * text and stores the parsed array in the `citations` column.
 */
export interface Citation {
  /** Sequential reference number used to anchor the citation in the text. */
  ref: number;
  /** Filename of the source document (e.g. "contract_v2.pdf"). */
  filename: string;
  /** Page number within the document, if applicable. */
  page?: number;
  /** Verbatim excerpt from the source, at most 200 characters. */
  quote: string;
}
