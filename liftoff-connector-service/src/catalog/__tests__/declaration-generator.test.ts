// A proposed identity names the record the write ACTS ON.
//
// The first generator proposed every identity-shaped argument on every write,
// and the first review of its output across the estate read like this:
// `organization_id` on forty-eight Zoho writes, `currency_id` and `tax_id` on
// an invoice, `assignee_id` on a task update, `to_mail_ids` on a send,
// `invoice_number` on the create that chooses it. References, scopes and
// chosen names — not targets. A write judged on those is a write the run fails
// for never having read the currency table.
//
// These pin the judgement that replaced the suffix match, one case each, so a
// change to the rule is a change to a named example rather than to a regex.

import { generateIdArgDeclarations } from '../declaration-generator';
import type { ConnectorFunction } from '../../types';

function write(name: string, args: string[], categories: string[] = ['write']): ConnectorFunction {
  return {
    name,
    description: '',
    categories: categories as ConnectorFunction['categories'],
    inputSchema: { type: 'object', properties: Object.fromEntries(args.map((a) => [a, { type: 'string' }])) },
  };
}

const proposed = (fn: ConnectorFunction) => generateIdArgDeclarations('t', [fn]).map((d) => d.idArgs)[0];

describe('what names the target', () => {
  it('the bare id, on anything but a create', () => {
    expect(proposed(write('update_contact', ['id', 'email']))).toEqual(['id']);
    expect(proposed(write('delete_record', ['id']))).toEqual(['id']);
  });

  it('an argument about a noun in the function name, and not one about another noun', () => {
    expect(proposed(write('update_task', ['task_id', 'assignee_id', 'title']))).toEqual(['task_id']);
    expect(proposed(write('updateTaskComment', ['taskId', 'commentId', 'body']))).toEqual(['taskId', 'commentId']);
    expect(proposed(write('add_tag_to_task', ['tag_id', 'task_id']))).toEqual(['tag_id', 'task_id']);
  });

  it('a scope or a reference is not the target', () => {
    expect(proposed(write('create_invoice', ['organization_id', 'currency_id', 'tax_id', 'line_items']))).toBeUndefined();
    expect(proposed(write('send_email', ['to_mail_ids', 'cc_mail_ids', 'subject']))).toBeUndefined();
  });

  it('a plural in the name and a singular in the argument are the same noun', () => {
    expect(proposed(write('merge_contacts', ['contact_ids']))).toEqual(['contact_ids']);
    expect(proposed(write('delete_entries', ['entry_id']))).toEqual(['entry_id']);
  });
});

describe('on a create', () => {
  it('the record being created has no identity yet: a chosen id or number is not one', () => {
    expect(proposed(write('create_project', ['id', 'name']))).toBeUndefined();
    expect(proposed(write('create_invoice', ['invoice_number', 'customer_email']))).toBeUndefined();
  });

  it('the parent it is created under is', () => {
    expect(proposed(write('create_task_comment', ['task_id', 'body']))).toEqual(['task_id']);
    expect(proposed(write('create_customer_payment', ['customer_id', 'amount']))).toEqual(['customer_id']);
  });
});

describe('a number beside an id', () => {
  it('is an attribute the write may be setting, not a second identity', () => {
    expect(proposed(write('update_invoice', ['invoice_id', 'invoice_number', 'status']))).toEqual(['invoice_id']);
  });

  it('is the identity when there is no id', () => {
    expect(proposed(write('pull_request_review_write', ['owner', 'repo', 'pullNumber', 'body']))).toEqual(['pullNumber']);
  });
});

describe('what is never proposed', () => {
  it('a read, whatever it takes', () => {
    expect(proposed(write('get_task', ['task_id'], ['read']))).toBeUndefined();
  });

  it('a function that already declares', () => {
    const fn = { ...write('update_task', ['task_id']), idArgs: ['task_id'] };
    expect(generateIdArgDeclarations('t', [fn])).toEqual([]);
  });
});
