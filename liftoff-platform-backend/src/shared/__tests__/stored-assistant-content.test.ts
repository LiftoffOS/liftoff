// The last door into a chat table: an assistant row is scrubbed whatever
// wrote it; a person's own words are never touched.

import { storedAssistantContent } from '../stored-assistant-content';

const ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';

describe('storedAssistantContent', () => {
  it('scrubs an assistant row', () => {
    expect(storedAssistantContent('assistant', `Done (id ${ID}) with github__create_issue.`)).toBe('Done with.');
  });

  it('leaves a user row exactly as typed, id and all', () => {
    const typed = `Please look at run ${ID} and call github__create_issue for me.`;
    expect(storedAssistantContent('user', typed)).toBe(typed);
  });
});
