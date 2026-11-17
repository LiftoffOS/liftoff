const MAX_CHARS = 3000;

export function formatThreadAsMarkdown(
  connectorType: string,
  entityType: string,
  data: unknown,
): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  try {
    switch (connectorType) {
      case 'slack':                return formatSlackThread(d);
      case 'atlassian_jira':       return formatJiraComments(d);
      case 'zendesk':              return formatZendeskComments(d);
      case 'linear':               return formatLinearComments(d);
      case 'intercom':             return formatIntercomConversation(d);
      case 'google_mail':          return formatGmailThread(d);
      case 'microsoft_outlook_mail': return formatOutlookConversation(d);
      case 'microsoft_teams':      return formatTeamsMessages(d);
      case 'salesforce':           return formatSalesforceActivity(d);
      default:                     return JSON.stringify(data).slice(0, MAX_CHARS);
    }
  } catch {
    return JSON.stringify(data).slice(0, MAX_CHARS);
  }
}

function formatSlackThread(d: Record<string, unknown>): string {
  const msgs = (d.messages as Array<Record<string, unknown>>) ?? [];
  const header = `## Slack Thread (${d.messageCount ?? msgs.length} messages)\n`;
  const lines = msgs.map(m => {
    const date = String(m.timestamp ?? '').slice(0, 16).replace('T', ' ');
    const reactions = ((m.reactions ?? []) as Array<{name:string;count:number}>)
      .map(r => `:${r.name}:×${r.count}`).join(' ');
    const text = String(m.text ?? '').trim();
    return `${date} @${m.userId}:${m.isThreadRoot ? ' [root]' : ''} ${text}${reactions ? `  [${reactions}]` : ''}`;
  });
  return trim(header + lines.join('\n'));
}

function formatJiraComments(d: Record<string, unknown>): string {
  const comments = (d.comments as Array<Record<string, unknown>>) ?? [];
  const header = `## Jira Issue ${d.issueKey} — ${d.total ?? comments.length} comments\n`;
  const lines = comments.slice(-30).map(c => {
    const date = String(c.created ?? '').slice(0, 10);
    const authorObj = c.author as Record<string, unknown> | undefined;
    const author = String(authorObj?.displayName ?? authorObj?.accountId ?? 'unknown').slice(0, 40);
    const text = flattenAdf(c.body as Record<string, unknown> | undefined);
    return `${date} ${author}: ${text}`;
  });
  return trim(header + lines.join('\n'));
}

function flattenAdf(body: Record<string, unknown> | undefined): string {
  if (!body || typeof body !== 'object') return String(body ?? '');
  if (body.type === 'text') return String(body.text ?? '');
  if (Array.isArray(body.content)) {
    return (body.content as Array<Record<string, unknown>>)
      .map(n => flattenAdf(n)).join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function formatZendeskComments(d: Record<string, unknown>): string {
  const comments = (d.comments as Array<Record<string, unknown>>) ?? [];
  const header = `## Zendesk Ticket ${d.ticketId} — ${d.commentCount ?? comments.length} comments\n`;
  const lines = comments.map(c => {
    const date = String(c.created_at ?? '').slice(0, 10);
    const visibility = c.public ? 'public' : 'internal';
    const body = String(c.body ?? '').slice(0, 500).replace(/\n+/g, ' ');
    return `${date} [author:${c.author_id}] (${visibility}): ${body}`;
  });
  return trim(header + lines.join('\n'));
}

function formatLinearComments(d: Record<string, unknown>): string {
  const comments = (d.comments as Array<Record<string, unknown>>) ?? [];
  const header = `## Linear Issue ${d.issueId ?? ''} — ${comments.length} comments\n`;
  const lines = comments.map(c => {
    const userObj = c.user as Record<string, unknown> | undefined;
    const author = String(userObj?.name ?? userObj?.displayName ?? 'unknown');
    const date = String(c.createdAt ?? c.created_at ?? '').slice(0, 10);
    return `${date} ${author}: ${String(c.body ?? '').slice(0, 500).replace(/\n+/g, ' ')}`;
  });
  return trim(header + lines.join('\n'));
}

function formatIntercomConversation(d: Record<string, unknown>): string {
  const parts = (d.conversation_parts as Record<string, unknown>) ?? {};
  const msgs = (parts.conversation_parts as Array<Record<string, unknown>>) ?? [];
  const header = `## Intercom Conversation ${d.id}\n`;
  const lines = msgs.filter(m => m.body).map(m => {
    const authorObj = m.author as Record<string, unknown> | undefined;
    const authorName = String(authorObj?.name ?? authorObj?.type ?? 'unknown');
    const date = String(m.created_at ?? '').slice(0, 10);
    const body = String(m.body ?? '').replace(/<[^>]+>/g, '').slice(0, 500);
    return `${date} ${authorName}: ${body}`;
  });
  return trim(header + lines.join('\n'));
}

function formatGmailThread(d: Record<string, unknown>): string {
  const messages = (d.messages as Array<Record<string, unknown>>) ?? [];
  const header = `## Gmail Thread\n`;
  const lines = messages.map(m => {
    const headers = ((m.payload as Record<string, unknown> | undefined)?.headers as Array<{name:string;value:string}>) ?? [];
    const from = headers.find(h => h.name.toLowerCase() === 'from')?.value ?? 'unknown';
    const date = headers.find(h => h.name.toLowerCase() === 'date')?.value?.slice(0, 16) ?? '';
    return `${date} ${from}: ${String(m.snippet ?? '').slice(0, 300)}`;
  });
  return trim(header + lines.join('\n'));
}

function formatOutlookConversation(d: Record<string, unknown>): string {
  const messages = ((d.messages ?? d.value) as Array<Record<string, unknown>>) ?? [];
  const header = `## Outlook Conversation\n`;
  const lines = messages.map(m => {
    const senderAddr = ((m.sender as Record<string, unknown> | undefined)?.emailAddress as Record<string, unknown>) ?? {};
    const from = String(senderAddr.name ?? senderAddr.address ?? 'unknown');
    const date = String(m.receivedDateTime ?? '').slice(0, 16).replace('T', ' ');
    return `${date} ${from}: ${String(m.bodyPreview ?? '').slice(0, 300)}`;
  });
  return trim(header + lines.join('\n'));
}

function formatTeamsMessages(d: Record<string, unknown>): string {
  const messages = ((d.messages ?? d.value) as Array<Record<string, unknown>>) ?? [];
  const header = `## Teams Thread\n`;
  const lines = messages.map(m => {
    const userObj = ((m.from as Record<string, unknown> | undefined)?.user as Record<string, unknown>) ?? {};
    const from = String(userObj.displayName ?? 'unknown');
    const date = String(m.createdDateTime ?? '').slice(0, 16).replace('T', ' ');
    const bodyObj = m.body as Record<string, unknown> | undefined;
    const text = String(bodyObj?.content ?? '').replace(/<[^>]+>/g, '').slice(0, 300);
    return `${date} ${from}: ${text}`;
  });
  return trim(header + lines.join('\n'));
}

function formatSalesforceActivity(d: Record<string, unknown>): string {
  const header = `## Salesforce Activity\n`;
  const who = String(d.WhoName ?? d.WhoId ?? '');
  const what = String(d.WhatName ?? d.WhatId ?? '');
  const date = String(d.ActivityDate ?? d.CreatedDate ?? '').slice(0, 10);
  const desc = String(d.Description ?? d.Subject ?? '').slice(0, 500);
  return trim(`${header}Date: ${date}\nRelated to: ${who}${what ? ` / ${what}` : ''}\n${desc}`);
}

function trim(s: string): string {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '\n[truncated]' : s;
}
