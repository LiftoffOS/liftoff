declare module 'mammoth' {
  interface ConversionResult {
    value: string
    messages: Array<{ type: string; message: string }>
  }
  function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<ConversionResult>
  function convertToHtml(input: { buffer: Buffer } | { path: string }): Promise<ConversionResult>
}
