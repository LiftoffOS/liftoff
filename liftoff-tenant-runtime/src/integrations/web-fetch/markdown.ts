import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  try {
    const dom = new JSDOM(html);
    const article = new Readability(dom.window.document).parse();
    const cleanedHtml = article?.content ?? html;
    return turndown.turndown(cleanedHtml).trim();
  } catch {
    return turndown.turndown(html).trim();
  }
}
