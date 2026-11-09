import cloudbase from '@cloudbase/node-sdk';
import { createDeepSeekProvider } from './ai/deepseekProvider';
import { createRoomAssistantService, type RoomAssistantService } from './ai/roomAssistant';
import { createSuggestCandidatesService, type SuggestCandidatesService } from './ai/suggestCandidates';
import { createGateway, type GatewayRepository, type GatewayResponse } from './gateway';
import { gatewayErrorResponse } from './errors';
import { CloudBasePgRpcTransport } from './repositories/cloudBasePgRpcTransport';
import { PgV2Repository } from './repositories/pgV2Repository';

/** Keys the CloudBase event-invoke platform injects into the function event. */
const PLATFORM_EVENT_KEYS = ['tcbContext'];

function stripPlatformEnvelope(event: unknown): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const payload = { ...(event as Record<string, unknown>) };
  for (const key of PLATFORM_EVENT_KEYS) delete payload[key];
  return payload;
}

export function createCloudBaseMain(dependencies: {
  repository: GatewayRepository;
  getUserInfo: () => { uid?: string };
  ai?: SuggestCandidatesService | undefined;
  assistant?: RoomAssistantService | undefined;
}) {
  const gateway = createGateway({
    repository: dependencies.repository,
    ai: dependencies.ai,
    assistant: dependencies.assistant,
    resolveActor: async () => {
      const { uid } = dependencies.getUserInfo();
      if (!uid) throw new Error('CloudBase caller has no uid');
      return uid;
    },
  });

  return async (event: unknown, context: unknown): Promise<GatewayResponse> => (
    gateway.handle(stripPlatformEnvelope(event), context)
  );
}

let configuredMain: ReturnType<typeof createCloudBaseMain> | undefined;

export async function main(event: unknown, context: unknown): Promise<GatewayResponse> {
  if (configuredMain === undefined) {
    const env = process.env.TCB_ENV;
    const apiKey = process.env.CLOUDBASE_APIKEY;
    if (!env || !apiKey) return gatewayErrorResponse(new Error('Gateway is not configured'));

    const app = cloudbase.init({ env });
    const repository = new PgV2Repository(new CloudBasePgRpcTransport({ envId: env, apiKey }));
    const apiKeyForAi = process.env.DEEPSEEK_API_KEY;
    const aiProvider = apiKeyForAi
      ? createDeepSeekProvider({
        apiKey: apiKeyForAi,
        ...(process.env.DEEPSEEK_MODEL ? { model: process.env.DEEPSEEK_MODEL } : {}),
      })
      : undefined;
    configuredMain = createCloudBaseMain({
      repository,
      getUserInfo: () => app.auth().getUserInfo(),
      ai: createSuggestCandidatesService({ provider: aiProvider }),
      assistant: createRoomAssistantService({ provider: aiProvider }),
    });
  }
  return configuredMain(event, context);
}
