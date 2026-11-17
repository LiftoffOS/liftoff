// The protected-control classifier: which controls the record must not read
// a value from, decided from the page's own declarations, and the utility
// boundary it deliberately leaves recordable.
//
// This states the classifier's LIMIT plainly: it follows labels, types,
// autocomplete tokens, form membership and routes. A malicious or badly
// labelled page can defeat it, which is why every reader still runs the
// credential redactor and the product copy says "protected fields are not
// recorded when identified", never that every possible secret is detected.

import { classifyProtectedControl } from '../protected-control';

describe('authentication', () => {
  it.each([
    ['type=password', { tag: 'input', type: 'password' }],
    ['autocomplete current-password', { tag: 'input', type: 'text', autocomplete: 'current-password' }],
    ['autocomplete new-password', { tag: 'input', type: 'text', autocomplete: 'new-password' }],
    ['autocomplete one-time-code', { tag: 'input', type: 'text', autocomplete: 'one-time-code' }],
    ['a password label', { tag: 'input', type: 'text', name: 'Confirm password' }],
    ['a passcode name attribute', { tag: 'input', type: 'text', attrName: 'passcode' }],
    ['a passphrase id', { tag: 'input', type: 'text', id: 'passphrase' }],
    ['a secret placeholder', { tag: 'input', type: 'text', placeholder: 'Client secret' }],
    ['a token label', { tag: 'input', type: 'text', name: 'Personal access token' }],
    ['an API key label', { tag: 'input', type: 'text', name: 'API key' }],
    ['an OTP label', { tag: 'input', type: 'tel', name: 'OTP' }],
    ['an authenticator label', { tag: 'input', type: 'text', name: 'Authenticator app code' }],
    ['a verification code label', { tag: 'input', type: 'text', name: 'Verification code' }],
    ['a security code label off a payment route', { tag: 'input', type: 'text', name: 'Security code', url: 'https://a.example/login' }],
    ['a PIN label', { tag: 'input', type: 'text', name: 'PIN' }],
    ['a recovery code label', { tag: 'input', type: 'text', name: 'Recovery code' }],
    ['a backup code label', { tag: 'input', type: 'text', name: 'Backup code 3' }],
    ['camelCase evidence', { tag: 'input', type: 'text', attrName: 'apiKey' }],
  ])('classifies %s', (_label, evidence) => {
    expect(classifyProtectedControl(evidence)).toBe('authentication');
  });

  it('protects every editable control in a form that contains an authentication field: the username of a sign-in form too', () => {
    const password = { tag: 'input', type: 'password', name: 'Password' };
    const username = { tag: 'input', type: 'text', name: 'Email address', autocomplete: 'username' };
    const remember = { tag: 'input', type: 'checkbox', name: 'Remember me' };
    const formFields = [username, password, remember];
    expect(classifyProtectedControl({ ...username, formFields })).toBe('authentication');
    expect(classifyProtectedControl({ ...remember, formFields })).toBe('authentication');
    // The submit button is not editable and is not a value.
    expect(classifyProtectedControl({ tag: 'button', type: 'submit', name: 'Sign in', formFields })).toBe('');
  });

  it.each([
    'https://a.example/login',
    'https://a.example/sign-in?next=%2Fhome',
    'https://a.example/auth/mfa',
    'https://a.example/account/reset-password/abc',
    'https://a.example/forgot-password',
    'https://a.example/verify',
    'https://a.example/app#/login',
    'https://a.example/sessions/new',
  ])('protects every editable control on a sign-in / MFA / password-reset route, which covers a split-step sign-in: %s', (url) => {
    expect(classifyProtectedControl({ tag: 'input', type: 'text', name: 'Email', url })).toBe('authentication');
    expect(classifyProtectedControl({ tag: 'select', name: 'Country', url })).toBe('authentication');
  });
});

describe('payment', () => {
  it.each([
    ['cc-number autocomplete', { tag: 'input', type: 'text', autocomplete: 'cc-number' }],
    ['cc-exp autocomplete', { tag: 'input', type: 'text', autocomplete: 'cc-exp' }],
    ['cc-csc autocomplete', { tag: 'input', type: 'text', autocomplete: 'cc-csc' }],
    ['cc-name autocomplete', { tag: 'input', type: 'text', autocomplete: 'cc-name' }],
    ['a card number label', { tag: 'input', type: 'text', name: 'Card number' }],
    ['a cardholder label', { tag: 'input', type: 'text', name: 'Cardholder name' }],
    ['a CVV label', { tag: 'input', type: 'text', name: 'CVV' }],
    ['a CVC label', { tag: 'input', type: 'text', name: 'CVC' }],
    ['an expiry label', { tag: 'input', type: 'text', name: 'Expiry date' }],
    ['an expiration label', { tag: 'input', type: 'text', name: 'Expiration (MM/YY)' }],
    ['a bank account label', { tag: 'input', type: 'text', name: 'Bank account' }],
    ['a routing label', { tag: 'input', type: 'text', name: 'Routing number' }],
    ['an IBAN label', { tag: 'input', type: 'text', name: 'IBAN' }],
    ['a SWIFT label', { tag: 'input', type: 'text', name: 'SWIFT / BIC' }],
    ['a security code label on a checkout route', { tag: 'input', type: 'text', name: 'Security code', url: 'https://shop.example/checkout' }],
    ['a weaker card label strengthened by a checkout route', { tag: 'input', type: 'text', name: 'Card', url: 'https://shop.example/checkout/payment' }],
  ])('classifies %s', (_label, evidence) => {
    expect(classifyProtectedControl(evidence)).toBe('payment');
  });

  it('leaves a billing or shipping name and address beside a card field recordable', () => {
    const card = { tag: 'input', type: 'text', autocomplete: 'cc-number', name: 'Card number' };
    const name = { tag: 'input', type: 'text', name: 'Name', autocomplete: 'name' };
    const street = { tag: 'input', type: 'text', name: 'Street address', autocomplete: 'street-address' };
    const city = { tag: 'input', type: 'text', name: 'City' };
    const formFields = [card, name, street, city];
    const url = 'https://shop.example/checkout';
    expect(classifyProtectedControl({ ...card, formFields, url })).toBe('payment');
    expect(classifyProtectedControl({ ...name, formFields, url })).toBe('');
    expect(classifyProtectedControl({ ...street, formFields, url })).toBe('');
    expect(classifyProtectedControl({ ...city, formFields, url })).toBe('');
  });

  it('a checkout route does not blanket-protect unrelated controls', () => {
    expect(classifyProtectedControl({ tag: 'input', type: 'text', name: 'Promo code', url: 'https://shop.example/checkout' })).toBe('');
    expect(classifyProtectedControl({ tag: 'input', type: 'email', name: 'Email for the receipt', url: 'https://shop.example/checkout' })).toBe('');
    // A bare "account" is an account email or name, not a bank account.
    expect(classifyProtectedControl({ tag: 'input', type: 'email', name: 'Account email', url: 'https://shop.example/checkout' })).toBe('');
    expect(classifyProtectedControl({ tag: 'input', type: 'text', name: 'Account name', url: 'https://shop.example/billing' })).toBe('');
    expect(classifyProtectedControl({ tag: 'input', type: 'text', name: 'Account number', url: 'https://shop.example/checkout' })).toBe('payment');
  });
});

describe('high-risk identity', () => {
  it.each([
    'SSN', 'Social security number', 'SIN', 'Tax ID', 'National ID number', 'Passport number', "Driver's licence number",
    'Driver license', 'Government ID', 'Date of birth', 'Birthdate', 'DOB', 'Biometric consent', 'Medical record number',
    'Health condition', 'Diagnosis', 'Insurance member ID', 'Member ID', 'Security answer', "Mother's maiden name",
  ])('classifies a %s label', (name) => {
    expect(classifyProtectedControl({ tag: 'input', type: 'text', name })).toBe('sensitive_identity');
  });
});

describe('file and hidden', () => {
  it('type=file is the file class', () => {
    expect(classifyProtectedControl({ tag: 'input', type: 'file', name: 'Attach a receipt' })).toBe('file');
  });

  it('a hidden input is ignored: it is not a person\'s interaction', () => {
    expect(classifyProtectedControl({ tag: 'input', type: 'hidden', name: 'csrf_token' })).toBe('');
    expect(classifyProtectedControl({ tag: 'input', type: 'hidden', name: 'password_hint', url: 'https://a.example/login' })).toBe('');
  });
});

describe('the utility boundary: ordinary workflow data stays recordable', () => {
  it.each([
    ['a search term', { tag: 'input', type: 'search', name: 'Search all issues' }],
    ['a filter', { tag: 'select', name: 'Status' }],
    ['a date range', { tag: 'input', type: 'date', name: 'From' }],
    ['a record name', { tag: 'input', type: 'text', name: 'Project name' }],
    ['a business email', { tag: 'input', type: 'email', name: 'Work email', autocomplete: 'email' }],
    ['a postal address', { tag: 'input', type: 'text', name: 'Address line 1', autocomplete: 'address-line1' }],
    ['a phone number', { tag: 'input', type: 'tel', name: 'Phone' }],
    ['a textarea', { tag: 'textarea', name: 'Notes' }],
    ['a contenteditable control', { tag: 'div', name: 'Description' }],
    ['a checkbox off a sign-in form', { tag: 'input', type: 'checkbox', name: 'Include archived' }],
    ['a token in prose that is not a label', { tag: 'input', type: 'text', name: 'Tokens per request' }],
    ['a healthcare organisation name (health as a whole word only)', { tag: 'input', type: 'text', name: 'Healthcare provider' }],
  ])('%s', (_label, evidence) => {
    expect(classifyProtectedControl(evidence)).toBe('');
  });

  it('reads a description the way the step policy supplies one', () => {
    expect(classifyProtectedControl({ description: 'the password input field', url: 'https://a.example/account' })).toBe('authentication');
    expect(classifyProtectedControl({ description: 'the search box', url: 'https://a.example/issues?q=x' })).toBe('');
    expect(classifyProtectedControl({ description: 'the card number field', url: 'https://shop.example/pay' })).toBe('payment');
    expect(classifyProtectedControl({ description: 'the SSN field', url: 'https://hr.example/onboarding' })).toBe('sensitive_identity');
  });

  it('tolerates missing and malformed evidence', () => {
    expect(classifyProtectedControl({})).toBe('');
    expect(classifyProtectedControl(undefined as unknown as Record<string, never>)).toBe('');
    expect(classifyProtectedControl({ url: 'not a url', formFields: 'nope' as unknown as [] })).toBe('');
  });
});

describe('self-contained', () => {
  it('evaluates in a bare realm and agrees with itself', () => {
    const source = classifyProtectedControl.toString();
    expect(source).not.toMatch(/require\(|import\(|exports\./);
    const evaluated = new Function(`return (${source});`)() as typeof classifyProtectedControl;
    for (const evidence of [
      { tag: 'input', type: 'password' },
      { tag: 'input', type: 'text', name: 'Card number' },
      { tag: 'input', type: 'text', name: 'Email', url: 'https://a.example/login' },
      { tag: 'input', type: 'text', name: 'Search' },
    ]) {
      expect(evaluated(evidence)).toBe(classifyProtectedControl(evidence));
    }
  });
});
