import type { RoomAssistantService } from './ai/roomAssistant';
import type { SuggestCandidatesService } from './ai/suggestCandidates';
import { resolveTrustedActor, type ActorResolver } from './auth';
import { dispatchCommand, type GatewayRepository } from './commands';
import { recordDiagnostic, resetDiagnostic, setStage } from './diagnostics';
import { gatewayErrorResponse, type GatewayResponse } from './errors';

export type { GatewayRepository } from './commands';
export type { GatewayResponse } from './errors';

export function createGateway<Context>(dependencies: {
  repository: GatewayRepository;
  resolveActor: ActorResolver<Context>;
  ai?: SuggestCandidatesService | undefined;
  assistant?: RoomAssistantService | undefined;
}) {
  return {
    async handle(request: unknown, context: Context): Promise<GatewayResponse> {
      resetDiagnostic();
      try {
        setStage('actor');
        const actorUid = await resolveTrustedActor(dependencies.resolveActor, context);
        setStage('request');
        const value = await dispatchCommand(dependencies.repository, actorUid, request, dependencies.ai, dependencies.assistant);
        return { status: 200, body: { ok: true, value } };
      } catch (error) {
        const response = gatewayErrorResponse(error);
        recordDiagnostic(
          request,
          {
            httpStatus: response.status,
            code: response.body.ok ? 'OK' : response.body.error.code,
          },
          error,
        );
        return response;
      }
    },
  };
}
