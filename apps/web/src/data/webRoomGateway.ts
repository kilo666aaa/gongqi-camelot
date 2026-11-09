import { createCloudBaseRoomGateway } from './cloudbaseRoomGateway';
import { createHttpRoomGateway } from './httpRoomGateway';
import type { RoomGateway } from './RoomGateway';

export type DevIdentity = 'host' | 'member';

const DEV_TOKEN_KEY = 'gongqi.dev.token';
const DEV_IDENTITY_KEY = 'gongqi.dev.identity';
const DEV_TOKENS: Record<DevIdentity, string> = {
  host: 'gq-dev-host-7c2fbfa7f7a24b3d',
  member: 'gq-dev-member-03baf8b299b6418c',
};

export function getDevIdentity(): DevIdentity {
  return sessionStorage.getItem(DEV_IDENTITY_KEY) === 'member' ? 'member' : 'host';
}

export function setDevIdentity(identity: DevIdentity): void {
  sessionStorage.setItem(DEV_IDENTITY_KEY, identity);
  sessionStorage.setItem(DEV_TOKEN_KEY, DEV_TOKENS[identity]);
}

function getDevToken(): string {
  const identity = getDevIdentity();
  if (!sessionStorage.getItem(DEV_TOKEN_KEY)) setDevIdentity(identity);
  const token = sessionStorage.getItem(DEV_TOKEN_KEY);
  if (!token) throw new Error('Development identity token is unavailable');
  return token;
}

export function createWebRoomGateway(): RoomGateway {
  if (__GQ_DEV_FIXTURE__) {
    return createHttpRoomGateway({ baseUrl: window.location.origin, getToken: getDevToken });
  }

  const env = import.meta.env.VITE_ENV_ID;
  const region = import.meta.env.VITE_CLOUD_REGION;
  const accessKey = import.meta.env.VITE_PUBLISHABLE_KEY;
  if (!env || !region || !accessKey) {
    throw new Error('CloudBase web configuration is incomplete');
  }
  return createCloudBaseRoomGateway({ env, region, accessKey });
}
