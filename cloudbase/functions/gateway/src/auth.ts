import { uidSchema } from '@gongqi/contracts/v2';
import { GatewayAuthError } from './errors';

export type ActorResolver<Context> = (context: Context) => Promise<string>;

/** uid the CloudBase gateway synthesises for Publishable-Key-only callers. */
export const SYNTHETIC_ANON_UID = 'anon';

export async function resolveTrustedActor<Context>(
  resolver: ActorResolver<Context>,
  context: Context,
): Promise<string> {
  let uid: string;
  try {
    uid = uidSchema.parse(await resolver(context));
  } catch {
    throw new GatewayAuthError();
  }
  if (uid === SYNTHETIC_ANON_UID) throw new GatewayAuthError();
  return uid;
}
