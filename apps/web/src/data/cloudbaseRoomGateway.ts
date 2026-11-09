import cloudbase from '@cloudbase/js-sdk';
import type { GatewayAction, GatewayInputMap, GatewayResultMap } from '@gongqi/contracts/v2';
import { RoomGatewayError, unwrapGatewayResponse, type RoomGateway } from './RoomGateway';

interface AuthResult {
  data: { session?: unknown };
  error: unknown;
}

export interface CloudBaseAppLike {
  auth: {
    getSession(): Promise<AuthResult>;
    signInAnonymously(): Promise<AuthResult>;
    onAuthStateChange(callback: (event: string, session: unknown) => void): unknown;
  };
  callFunction(options: { name: string; data: unknown }): Promise<{ result: unknown }>;
}

export function createCloudBaseRoomGatewayFromApp(app: CloudBaseAppLike): RoomGateway {
  let ready: Promise<void> | undefined;

  const ensureSession = () => {
    if (ready === undefined) {
      ready = (async () => {
        const session = await app.auth.getSession();
        if (session.error) throw new RoomGatewayError('AUTH_ERROR', 0);
        if (!session.data.session) {
          // M0 explicitly enabled anonymous login for Gongqi. This runs only while establishing
          // an initial session, never as a retry for a gateway permission/auth failure.
          const signedIn = await app.auth.signInAnonymously();
          if (signedIn.error || !signedIn.data.session) {
            throw new RoomGatewayError('UNAUTHENTICATED', 401);
          }
        }
      })().catch(error => {
        ready = undefined;
        throw error;
      });
    }
    return ready;
  };

  app.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') ready = undefined;
  });

  return {
    async request<Action extends GatewayAction>(
      action: Action,
      input: GatewayInputMap[Action],
    ): Promise<GatewayResultMap[Action]> {
      await ensureSession();
      let response: unknown;
      try {
        const called = await app.callFunction({
          name: 'gateway',
          data: { action, input },
        });
        response = called.result;
      } catch {
        throw new RoomGatewayError('NETWORK_ERROR', 0);
      }
      return unwrapGatewayResponse(action, response);
    },
  };
}

export function createCloudBaseRoomGateway(options: {
  env: string;
  region: string;
  accessKey: string;
}): RoomGateway {
  const app = cloudbase.init({
    env: options.env,
    region: options.region,
    accessKey: options.accessKey,
    auth: { detectSessionInUrl: true },
  });
  return createCloudBaseRoomGatewayFromApp(app as unknown as CloudBaseAppLike);
}
