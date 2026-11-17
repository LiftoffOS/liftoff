// `templateId` must survive the distill routers' zod schemas.
//
// Both routers validate the request body with `z.object()`, which STRIPS keys
// the schema does not declare rather than rejecting them. Left undeclared,
// `templateId` — the field the Explore page sends — is silently discarded
// before `distillInternalAgent` ever sees it. Two things depend on it and
// would therefore never happen on the template-hire path:
//
//   1. Template seeding (distill-service's `if (input.templateId)` block), which
//      tells the model the inputs are template-provided.
//   2. `shouldInjectReviewCycle`, which is `bindsGithub && !!templateId && ...`.
//      Every Explore hire of software-engineer, code-reviewer,
//      security-engineer, performance-engineer or incident-manager would go
//      out without the review-cycle convergence contract.
//
// A strip is invisible: the request succeeds, distillation succeeds, and the
// output is merely less anchored. Nothing else in the suite would notice, so
// this test asserts the property directly on the schemas.

import { z } from 'zod';
import { __testOnlyDistillInputSchema as streamSchema } from '../distill-stream-router';
import { __testOnlyDistillInputSchema as postSchema } from '../distill-router';

const BASE = {
  role: 'Code Reviewer',
  responsibilities: '## Workflows\n1. Review the diff\n2. Comment with file and line',
  integrations: [],
};

describe.each([
  ['distill-stream-router', streamSchema],
  ['distill-router', postSchema],
])('%s distillInputSchema', (_name, schema: z.ZodTypeAny) => {
  it('keeps templateId instead of stripping it', () => {
    const parsed = schema.parse({ ...BASE, templateId: 'code-reviewer' });
    expect(parsed.templateId).toBe('code-reviewer');
  });

  it('keeps additionalContext, the other field the hire path depends on', () => {
    const parsed = schema.parse({ ...BASE, additionalContext: '## Rules\n- Never approve' });
    expect(parsed.additionalContext).toBe('## Rules\n- Never approve');
  });

  it('still accepts a body with no templateId (the type-your-own path)', () => {
    const parsed = schema.parse(BASE);
    expect(parsed.templateId).toBeUndefined();
  });
});
