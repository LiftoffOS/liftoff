// The settings a person can change from their coding tool: which AI provider the
// workspace (or one agent) runs on, and how they are notified.
//
// WHY THIS IS AN ADAPTER, NOT A FEATURE. The provider half already exists as
// workspace actions — `workspace_ai_vendor` and the `aiVendorOverride` field of
// `team_update` — with their own role rules, their own validation against the live
// vendor list, and their own preview → confirm handles. MCP simply could not reach
// them: it wires no workspace actions at all. So this dispatches into them rather
// than restating any of it, which is what keeps the dashboard, the assistants and
// a coding tool from drifting into three answers about the same setting.
//
// THE CONFIRMATION IS PRESERVED ON PURPOSE. Both existing levels require a
// before/after and an explicit go-ahead, so nothing in the product changes an AI
// provider without the person seeing it. Acting directly here would have made a
// coding tool the one exception, at the broader of the two scopes.
//
// THE NOTIFICATION HALF IS GENUINELY NEW, and account-scoped rather than
// workspace-scoped: these are one person's preferences, so there is no role to
// check — the caller can only ever read and write their own. Two things make it
// less trivial than it looks:
//
//   THE STORE MERGES SHALLOWLY. `preferences || $n::jsonb` replaces a top-level
//   key wholesale, so writing { notificationDelivery: { email } } DROPS `browser`.
//   Every write here therefore reads the current value first and sends the
//   complete object. The dashboard isolates this same rule in its own helper
//   because it is easy to get wrong and silent when you do.
//
//   BROWSER DELIVERY IS READABLE, NEVER WRITABLE. An MCP client is not a browser:
//   it holds no push subscription and cannot obtain the OS permission, and the
//   register endpoint owns that preference so the token and the setting cannot
//   disagree. But it must be PRESERVED on every write, which is the shallow-merge
//   rule above. Reported so a person can see it, with a reason attached.

import { z } from 'zod';
import type { McpActor } from './actor';
import type { Actor } from '../workspace-actions/actor';
import { dispatchWorkspaceAction } from '../workspace-actions/tools';
import { getAiVendor } from '../workspace-actions/workspace';
import { hasPermission } from '../workspace-actions/permissions';
import { getProviderKeys } from '../tenant-ai-provider-keys/service';
import { AI_PROVIDER_KEY_VENDORS } from '../tenant-ai-provider-keys/types';
// The SAME layer the dashboard's own settings route writes through
// (accounts/router.ts -> service.update), so a change made from a coding tool and
// a change made on the page take one path, not two.
import { AccountService } from '../accounts/service';
import { log } from '../infrastructure/logging';

const accounts = new AccountService();

/** The person acting, as the workspace-action layer understands them.
 *
 *  `surface: 'dashboard'` because this is the person performing the action
 *  themselves, not an assistant doing it on their behalf — the same thing they
 *  would do on the settings page. `via: 'mcp'` and the client name are what make
 *  the audit row say it came from their coding tool. */
function workspaceActor(actor: McpActor): Actor {
  return {
    tenantId: actor.tenantId,
    accountId: actor.accountId,
    role: actor.role,
    displayName: actor.displayName,
    surface: 'dashboard',
    via: 'mcp',
    client: actor.client,
    credentialId: actor.keyId,
  };
}

// ── The AI provider ───────────────────────────────────────────────────────

export const AiProviderSetInput = z.object({
  vendor: z.string().min(1).max(50),
  /** The agent to change instead of the workspace default. Omitted means the
   *  workspace's own provider, which every team without an override follows. */
  agentId: z.string().uuid().optional(),
  /** The handle a preview returned. Without it this previews and changes nothing. */
  confirmationId: z.string().max(200).optional(),
});

/** The current provider and the options, so a model never guesses a vendor name
 *  and a person can be shown what they are changing from. */
export async function getAiProvider(actor: McpActor) {
  const current = await getAiVendor(workspaceActor(actor));
  return {
    workspaceProvider: current.aiVendor,
    options: current.options,
    // Said plainly because "default" reads like an absent value rather than a
    // choice, and a model relaying it should not call it "unset".
    note: '"default" is Liftoff Managed. A vendor\'s own key is entered on the Workspace settings page, never through a tool.',
  };
}

/** Change the workspace's provider, or one agent's override.
 *
 *  Both go through the existing workspace action, so the role rule, the validation
 *  and the preview → confirm handshake are the ones every other surface uses. A
 *  first call previews; the same call carrying the returned handle commits. */
export async function setAiProvider(
  input: z.infer<typeof AiProviderSetInput>,
  actor: McpActor,
): Promise<{ result: string }> {
  const wsActor = workspaceActor(actor);
  // An agent's override rides team_update, the same field the Update Team page
  // writes, and a patch carrying only a setting does not rebuild the agent.
  // Choosing the workspace's own vendor CLEARS the override rather than pinning
  // it, which is how "follow the workspace" is represented — so the two levels
  // cannot describe the same state differently.
  if (input.agentId) {
    const workspace = await getAiVendor(wsActor);
    const followsWorkspace = input.vendor === workspace.aiVendor;
    return { result: await dispatchWorkspaceAction(
      'team_update',
      {
        agentId: input.agentId,
        aiVendorOverride: followsWorkspace ? null : input.vendor,
        ...(input.confirmationId ? { confirmationId: input.confirmationId } : {}),
      },
      wsActor,
    ) };
  }
  return { result: await dispatchWorkspaceAction(
    'workspace_ai_vendor',
    {
      vendor: input.vendor,
      ...(input.confirmationId ? { confirmationId: input.confirmationId } : {}),
    },
    wsActor,
  ) };
}

// ── Communication settings ────────────────────────────────────────────────

/** The notification types the Communication tab offers, and there are exactly
 *  four. Taken from NotificationTypes in accounts/types.ts rather than written
 *  from memory: an invented key would be accepted by the jsonb column, stored
 *  forever, shown to nobody, and would make this tool describe a setting the page
 *  has never had.
 *
 *  Listed rather than inferred from what a person happens to have saved, because a
 *  key absent from their preferences still has a default (all four are on), and a
 *  model asking "what can I change" must see the whole set. Defaults match
 *  DEFAULT_NOTIFICATION_TYPES on the page, which is what keeps the two from
 *  reporting different states for the same account. */
const NOTIFICATION_TYPES = [
  'taskUpdates',
  'teamActivity',
  'escalations',
  'weeklyDigest',
] as const;

const FREQUENCIES = ['realtime', 'daily', 'weekly', 'none'] as const;

export const CommunicationSetInput = z.object({
  /** Only the types being changed; the rest keep their current value. */
  notificationTypes: z.record(z.enum(NOTIFICATION_TYPES), z.boolean()).optional(),
  notificationFrequency: z.enum(FREQUENCIES).optional(),
  /** Email only. Browser delivery is not writable here — see the header. */
  emailDelivery: z.boolean().optional(),
  /** The Liftoff Newsletter, which the page carries under the same tab. A plain
   *  top-level boolean rather than part of notificationDelivery: it is a mailing
   *  list subscription, not a delivery channel for the notifications above, and
   *  turning every notification off leaves it on. */
  newsletter: z.boolean().optional(),
}).refine(
  (v) => v.notificationTypes !== undefined || v.notificationFrequency !== undefined
    || v.emailDelivery !== undefined || v.newsletter !== undefined,
  { message: 'nothing to change: pass notificationTypes, notificationFrequency, emailDelivery or newsletter' },
);

function currentTypes(stored: Record<string, boolean> | undefined) {
  const out: Record<string, boolean> = {};
  for (const key of NOTIFICATION_TYPES) out[key] = stored?.[key] ?? true;
  return out;
}

export async function getCommunicationSettings(actor: McpActor) {
  const account = await accounts.getById(actor.accountId);
  const prefs = account?.preferences ?? {};
  const delivery = prefs.notificationDelivery ?? {};
  return {
    notificationTypes: currentTypes(prefs.notificationTypes as Record<string, boolean> | undefined),
    notificationFrequency: prefs.notificationFrequency ?? 'realtime',
    delivery: {
      // Email on, browser off, matching the defaults accounts/types.ts documents
      // and the page applies. Browser defaults off because it cannot work without
      // an OS permission, so defaulting it on would claim a capability the account
      // does not have.
      email: delivery.email ?? true,
      // Readable so a person can see the whole picture, and marked so a model
      // does not offer to change something it cannot.
      browser: delivery.browser ?? false,
      browserWritable: false,
      browserNote: 'Browser notifications are turned on from the Liftoff dashboard in a browser: they need a push subscription and the operating system\'s permission, which a coding tool cannot obtain.',
    },
    // Default ON, matching the page: an account that has never touched it is
    // subscribed, so reporting it as off would misstate what the person gets.
    newsletter: prefs.newsletter ?? true,
    frequencyOptions: FREQUENCIES,
  };
}

export async function setCommunicationSettings(
  input: z.infer<typeof CommunicationSetInput>,
  actor: McpActor,
) {
  // READ FIRST, ALWAYS. The store's jsonb merge is shallow, so a partial object
  // replaces the whole key: writing delivery as { email } would drop `browser`
  // and silently turn a person's browser notifications off. Same for the type
  // map, where a single toggle would erase every other choice.
  const account = await accounts.getById(actor.accountId);
  if (!account) {
    return { refused: 'Your account could not be read, so nothing was changed.' };
  }
  const prefs = account.preferences ?? {};
  const patch: Record<string, unknown> = {};

  if (input.notificationTypes) {
    patch.notificationTypes = {
      ...currentTypes(prefs.notificationTypes as Record<string, boolean> | undefined),
      ...input.notificationTypes,
    };
  }
  if (input.notificationFrequency) {
    patch.notificationFrequency = input.notificationFrequency;
  }
  if (input.emailDelivery !== undefined) {
    const delivery = prefs.notificationDelivery ?? {};
    patch.notificationDelivery = {
      email: input.emailDelivery,
      // CARRIED THROUGH, never defaulted away: this is the value the register
      // endpoint owns, and the shallow merge would drop it otherwise.
      browser: delivery.browser ?? false,
    };
  }

  if (input.newsletter !== undefined) {
    // A plain boolean at the top level, so the read-first rule above does not
    // apply to it: there is no sibling key inside it for a shallow merge to drop.
    patch.newsletter = input.newsletter;
  }

  await accounts.update(actor.accountId, { preferences: patch });
  log.info(
    {
      event: 'mcp_communication_settings_set',
      accountId: actor.accountId,
      client: actor.client,
      changed: Object.keys(patch),
    },
    'communication settings changed from a coding tool',
  );

  // The settings as they now stand, read back rather than assumed, so the person
  // is shown what was actually saved.
  return { changed: Object.keys(patch), settings: await getCommunicationSettings(actor) };
}


// -- A workspace's own provider keys ---------------------------------------
//
// READ ONLY, AND THAT IS THE DESIGN. A key handed to a tool is a tool argument,
// which makes it a token in a model's context before it is anything else: it
// lands in the client's transcript, in request logs, in any error trace that
// echoes arguments, and, since recall, in a turn that is embedded and made
// searchable. The settings page posts the secret straight to the API with no
// model in the loop and stores it in Secret Manager, keeping only a pointer and
// a redaction. That difference is in the transport, so no amount of care at this
// end reproduces it. Google is not even an API key: it is a Vertex service
// account, exchanged for a short-lived token per request, with nothing to paste.
//
// So this answers the question people actually ask, which is whether a key is in
// place and what is paying for their calls, and hands back the page for the one
// step that has to happen in a browser. The shape is the estate's existing one:
// connection_start refuses `page_only` with a page, which is how Stripe is
// connected today.

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

/** The Workspace tab, where the provider-key card lives. The tab is a path
 *  segment, so this opens on the card rather than on the first tab. */
const PROVIDER_KEYS_PAGE = `${FRONTEND_URL}/dashboard/settings/workspace`;

/** Who may see the key state: the same rule the dashboard's own route applies,
 *  read from the one source rather than restated as owner-or-admin here. */
const PROVIDER_KEYS_PERMISSION = 'workspace:ai_vendor' as const;

export async function getAiProviderKeys(actor: McpActor) {
  if (!hasPermission(actor.role, PROVIDER_KEYS_PERMISSION)) {
    return { refused: 'Only an owner or an admin can see the workspace\'s AI provider keys.' };
  }

  const stored = await getProviderKeys(actor.tenantId);
  const byVendor = new Map(stored.map((k) => [k.vendor, k]));

  // Every vendor is listed, the ones with no key included: absent is an answer,
  // and a list of only what exists cannot say what is missing.
  const providers = AI_PROVIDER_KEY_VENDORS.map((vendor) => {
    const key = byVendor.get(vendor);
    if (!key) return { vendor, hasKey: false, paidBy: 'liftoff_managed' as const };

    // A revoked key is still stored and still shown on the card, and calls fall
    // back to the managed pool meanwhile. Reporting only "revoked" would leave
    // the person wondering whether their work had stopped.
    const revoked = key.status === 'revoked';
    return {
      vendor,
      hasKey: true,
      status: key.status,
      keyHint: key.hint,
      lastVerifiedAt: key.lastVerifiedAt,
      updatedAt: key.updatedAt,
      paidBy: revoked ? ('liftoff_managed' as const) : ('workspace_own_key' as const),
      ...(revoked
        ? { note: 'The vendor rejected this key, so calls are running on Liftoff\'s managed pool until it is replaced.' }
        : {}),
    };
  });

  return {
    providers,
    page: PROVIDER_KEYS_PAGE,
    howToChange:
      'A provider key is entered on that page in a browser, never through a tool: sending one here would put the secret into this conversation and its logs. Give the person the link. Google is a Vertex service account rather than a key, and is set up on the same page.',
  };
}
