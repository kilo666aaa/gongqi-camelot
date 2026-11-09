import type { GatewayAction, GatewayInputMap, GatewayResultMap } from '@gongqi/contracts/v2';
import { RoomGatewayError, unwrapGatewayResponse, type RoomGateway } from './RoomGateway';

export interface HttpFetchResponse {
  status: number;
  json(): Promise<unknown>;
}

export type HttpFetch = (
  input: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  },
) => Promise<HttpFetchResponse>;

export function createHttpRoomGateway(options: {
  baseUrl: string;
  getToken: () => string | null;
  fetchImpl?: HttpFetch;
}): RoomGateway {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl.replace(/\/$/, '');

  return {
    async request<Action extends GatewayAction>(
      action: Action,
      input: GatewayInputMap[Action],
    ): Promise<GatewayResultMap[Action]> {
      const token = options.getToken();
      if (!token) throw new RoomGatewayError('UNAUTHENTICATED', 401);

      let response: { status: number; json(): Promise<unknown> };
      try {
        response = await fetchImpl(`${baseUrl}/gateway`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action, input }),
        });
      } catch {
        throw new RoomGatewayError('NETWORK_ERROR', 0);
      }
      return unwrapGatewayResponse(action, await response.json());
    },
  };
}
