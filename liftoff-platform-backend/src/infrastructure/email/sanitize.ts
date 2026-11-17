// Email Sanitization Utilities
// Shared across contact form, invite requests, and other email-sending endpoints

// HTML-escape user inputs for email body (prevents XSS in rendered email)
export function escapeHtml(text: string): string {
  const htmlEntities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEntities[char]);
}

// Sanitize for email subject/headers — strips CRLF, HTML tags, caps length
export function sanitizeForEmail(input: string): string {
  return input
    .replace(/[\r\n]/g, '')  // Remove CRLF injection
    .replace(/[<>]/g, '')     // Remove HTML tags
    .substring(0, 100);       // Enforce max length
}
