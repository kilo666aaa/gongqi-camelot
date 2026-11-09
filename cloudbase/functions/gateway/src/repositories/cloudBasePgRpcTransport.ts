import { noteTransportStatus } from '../diagnostics';
import type { PgV2RpcTransport } from './pgV2Repository';

export class CloudBasePgRpcTransport implements PgV2RpcTransport {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    envId: string;
    apiKey: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    if (!options.envId || !options.apiKey) throw new Error('CLOUDBASE_PG_RPC_NOT_CONFIGURED');
    this.#baseUrl = `https://${options.envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc`;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async call(actorUid: string, rpcName: string, commands: readonly unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const payload = rpcName === 'gq_get_snapshot' || rpcName === 'gq_get_assistant_messages'
      ? { p_actor_uid: actorUid, p_room_id: commands[0] }
      : { p_actor_uid: actorUid, p_payload: commands[0] };

    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/${rpcName}`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new Error('CLOUDBASE_PG_RPC_TIMEOUT');
        throw new Error('CLOUDBASE_PG_RPC_REQUEST_FAILED');
      }

      if (!response.ok) throw new Error('CLOUDBASE_PG_RPC_HTTP_ERROR');
      noteTransportStatus(response.status);
      try {
        return await response.json();
      } catch {
        throw new Error('CLOUDBASE_PG_RPC_INVALID_RESPONSE');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
