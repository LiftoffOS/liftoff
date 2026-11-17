// Singleton Bot Framework CloudAdapter for the Liftoff Teams bot.
//
// CloudAdapter + ConfigurationBotFrameworkAuthentication handle inbound JWT
// validation and outbound per-conversation serviceUrl AAD-signed Connector
// calls. The Azure Bot resource is single-tenant, so the credential factory is
// configured SingleTenant with MicrosoftAppTenantId = the bot's home tenant;
// the backing Entra app registration is multi-tenant, which is what lets any
// customer tenant install the Teams app. continueConversationAsync(appId, ref,
// cb) acquires the Connector token from the stored reference for proactive
// sends.

import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  type TurnContext,
} from 'botbuilder';
import { log } from '../../infrastructure/logging';
import { getBotCredentials } from './teams-secret-service';

let adapterSingleton: CloudAdapter | null = null;

/** Build (once) and return the shared CloudAdapter. */
export function getTeamsAdapter(): CloudAdapter {
  if (adapterSingleton) return adapterSingleton;

  const { appId, appPassword, appTenantId } = getBotCredentials();

  const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: appId,
    MicrosoftAppPassword: appPassword,
    MicrosoftAppType: 'SingleTenant',
    MicrosoftAppTenantId: appTenantId,
  });
  const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(
    {},
    credentialsFactory,
  );

  const adapter = new CloudAdapter(botFrameworkAuth);
  adapter.onTurnError = async (context: TurnContext, error: Error) => {
    log.error(
      { error: error.message, activityType: context.activity?.type },
      'Teams bot onTurnError',
    );
    try {
      await context.sendActivity('Sorry, something went wrong handling that.');
    } catch {
      // best-effort; the turn already failed
    }
  };

  adapterSingleton = adapter;
  return adapter;
}

/** The Liftoff bot's Microsoft app id — required for continueConversationAsync. */
export function getBotAppId(): string {
  return getBotCredentials().appId;
}

/** Test-only: reset the singleton. */
export function _resetTeamsAdapter(): void {
  adapterSingleton = null;
}
