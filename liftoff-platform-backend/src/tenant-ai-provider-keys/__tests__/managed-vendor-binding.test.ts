// A key funds whatever it matches, INCLUDING under Liftoff Managed.
//
// The rule is purely "what did this call resolve to". LIFTOFF_MANAGED_VENDOR is
// 'anthropic', so a Liftoff Managed workspace holding an Anthropic key has its
// agent turns funded by that key. Routing and funding stay orthogonal axes and
// there is no special case for 'default'.
//
// The name works against the behaviour, and the binding is invisible: it lives
// in an internal constant nobody reads while choosing a vendor. If managed
// routing ever moves off Anthropic, every Liftoff Managed tenant's Anthropic key
// stops being used and their spend returns to Liftoff — with nothing in any
// surface saying so.
//
// So this pin is not a style check. Changing the constant is a BILLING change,
// and this test is what makes someone say so out loud before making it.

import { LIFTOFF_MANAGED_VENDOR } from '../../model-registry/workspace-ai-vendors';
import { keyVendorForProvider } from '../resolution-service';

describe('the Liftoff Managed funding binding', () => {
  it('routes Liftoff Managed to anthropic', () => {
    expect(LIFTOFF_MANAGED_VENDOR).toBe('anthropic');
  });

  it('means an anthropic key funds a Liftoff Managed workspace turn', () => {
    // No 'default' branch anywhere in the resolver: 'default' resolves to a
    // concrete vendor upstream, and this is the only mapping that follows.
    expect(keyVendorForProvider(LIFTOFF_MANAGED_VENDOR)).toBe('anthropic');
  });
});
