import { dedupPostureFor, vendorKeyFromStepKey } from '../dedup-posture';

describe('dedup-posture (§4.6)', () => {
  it('vendor-key tools → effectively_once + the vendor field', () => {
    expect(dedupPostureFor('square.refund_payment')).toEqual({ policy: 'effectively_once', vendorKeyField: 'idempotency_key' });
    expect(dedupPostureFor('quickbooks.create_invoice')).toEqual({ policy: 'effectively_once', vendorKeyField: 'requestid' });
    expect(dedupPostureFor('quickbooks.delete_bank_account')).toEqual({ policy: 'effectively_once', vendorKeyField: 'request_id' });
  });

  it('naturally-idempotent verbs (act on existing target) → effectively_once, no field', () => {
    expect(dedupPostureFor('gmail.delete_message')).toEqual({ policy: 'effectively_once' });
    expect(dedupPostureFor('airtable.update_record')).toEqual({ policy: 'effectively_once' });
    expect(dedupPostureFor('trello.move_card')).toEqual({ policy: 'effectively_once' });
  });

  it('sends / creates → at_most_once (the safe default)', () => {
    expect(dedupPostureFor('gmail.send_email')).toEqual({ policy: 'at_most_once' });
    expect(dedupPostureFor('slack.send_message')).toEqual({ policy: 'at_most_once' });
    expect(dedupPostureFor('agent_slack.send_message')).toEqual({ policy: 'at_most_once' });
    expect(dedupPostureFor('mailchimp.create_campaign')).toEqual({ policy: 'at_most_once' });
  });

  it('vendorKeyFromStepKey truncates to a vendor-safe length', () => {
    expect(vendorKeyFromStepKey('a'.repeat(64)).length).toBe(40);
    expect(vendorKeyFromStepKey('abc')).toBe('abc');
  });
});
