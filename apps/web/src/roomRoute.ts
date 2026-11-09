export type WebRoute =
  | { name: 'home' }
  | { name: 'join'; inviteToken: string }
  | { name: 'room'; roomId: string };

function inviteTokenFromHash(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.get('invite') ?? '';
}

function basePrefix(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

export function readWebRoute(
  pathname: string,
  hash = '',
  base = import.meta.env.BASE_URL,
  search = '',
): WebRoute {
  if (basePrefix(base)) {
    const [routePath = '', query = ''] = hash.replace(/^#/, '').split('?', 2);
    const roomMatch = /^\/rooms\/([^/]+)\/?$/.exec(routePath);
    if (roomMatch?.[1]) return { name: 'room', roomId: decodeURIComponent(roomMatch[1]) };
    if (routePath === '/join' || (!routePath && new URLSearchParams(search).get('join') === '1')) {
      return { name: 'join', inviteToken: new URLSearchParams(query).get('invite') ?? '' };
    }
    return { name: 'home' };
  }

  const roomMatch = /^\/rooms\/([^/]+)\/?$/.exec(pathname);
  if (roomMatch?.[1]) return { name: 'room', roomId: decodeURIComponent(roomMatch[1]) };
  if (pathname === '/join') return { name: 'join', inviteToken: inviteTokenFromHash(hash) };
  return { name: 'home' };
}

export function homePath(base = import.meta.env.BASE_URL): string {
  const prefix = basePrefix(base);
  return import.meta.env.VITE_EXPLICIT_HTML_ENTRY === '1' ? `${prefix}/index.html` : `${prefix}/`;
}

export function roomPath(roomId: string, base = import.meta.env.BASE_URL): string {
  const prefix = basePrefix(base);
  const room = `/rooms/${encodeURIComponent(roomId)}`;
  return prefix ? `${homePath(base)}#${room}` : room;
}

export function joinPath(base = import.meta.env.BASE_URL): string {
  const prefix = basePrefix(base);
  return prefix ? `${homePath(base)}#/join` : '/join';
}

export function inviteUrl(
  origin: string,
  inviteToken: string,
  base = import.meta.env.BASE_URL,
): string {
  const token = encodeURIComponent(inviteToken);
  return basePrefix(base)
    ? `${origin}${homePath(base)}?join=1#/join?invite=${token}`
    : `${origin}${joinPath(base)}#invite=${token}`;
}

export function inviteTokenFromInput(input: string): string {
  const value = input.trim();
  try {
    const url = new URL(value);
    const hash = url.hash.slice(1);
    const token = new URLSearchParams(hash.startsWith('/join?') ? hash.slice(6) : hash).get('invite');
    return token && /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : value;
  } catch {
    return value;
  }
}
