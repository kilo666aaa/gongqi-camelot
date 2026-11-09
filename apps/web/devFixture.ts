import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDeepSeekProvider } from '../../cloudbase/functions/gateway/src/ai/deepseekProvider';
import { createRoomAssistantService } from '../../cloudbase/functions/gateway/src/ai/roomAssistant';
import { createGateway } from '../../cloudbase/functions/gateway/src/gateway';
import { PgV2Repository } from '../../cloudbase/functions/gateway/src/repositories/pgV2Repository';

const DEV_ACTORS: Readonly<Record<string, string>> = {
  'gq-dev-host-7c2fbfa7f7a24b3d': 'dev-host-1',
  'gq-dev-member-03baf8b299b6418c': 'dev-member-2',
};

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify({ status, body }));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createDevFixture(connectionString: string) {
  const repository = new PgV2Repository({
    connectionString,
    application_name: 'gq-v2-web-dev-fixture',
    options: '-c role=service_role',
    max: 4,
  });
  const aiProvider = process.env.DEEPSEEK_API_KEY
    ? createDeepSeekProvider({
      apiKey: process.env.DEEPSEEK_API_KEY,
      ...(process.env.DEEPSEEK_MODEL ? { model: process.env.DEEPSEEK_MODEL } : {}),
    })
    : undefined;
  const gateway = createGateway<string | undefined>({
    repository,
    assistant: aiProvider ? createRoomAssistantService({ provider: aiProvider }) : undefined,
    resolveActor: async actorUid => {
      if (!actorUid) throw new Error('Missing development actor');
      return actorUid;
    },
  });

  return {
    async handle(request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> {
      if (request.url !== '/gateway') {
        next();
        return;
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'INVALID_INPUT' } });
        return;
      }
      try {
        const authorization = request.headers.authorization ?? '';
        const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization)?.[1];
        const actorUid = token === undefined ? undefined : DEV_ACTORS[token];
        const requestBody = await readJson(request);
        const result = await gateway.handle(requestBody, actorUid);
        writeJson(response, result.status, result.body);
      } catch {
        writeJson(response, 400, { ok: false, error: { code: 'INVALID_INPUT' } });
      }
    },
    close: () => repository.close(),
  };
}
