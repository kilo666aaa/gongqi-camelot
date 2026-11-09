import { describe, expect, it } from 'vitest';
import { inviteTokenFromInput, inviteUrl, joinPath, readWebRoute, roomPath } from '../../../apps/web/src/roomRoute';

describe('web deployment routes', () => {
  it('keeps the existing development paths', () => {
    expect(readWebRoute('/rooms/room-1', '', '/')).toEqual({ name: 'room', roomId: 'room-1' });
    expect(readWebRoute('/join', '#invite=token-1', '/')).toEqual({ name: 'join', inviteToken: 'token-1' });
    expect(roomPath('room 1', '/')).toBe('/rooms/room%201');
    expect(joinPath('/')).toBe('/join');
    expect(inviteUrl('https://example.test', 'token 1', '/'))
      .toBe('https://example.test/join#invite=token%201');
  });

  it('uses self-contained hash routes below the production app base', () => {
    expect(readWebRoute('/app/', '#/rooms/room-1', '/app/')).toEqual({ name: 'room', roomId: 'room-1' });
    expect(readWebRoute('/app/', '#/join?invite=token-1', '/app/')).toEqual({
      name: 'join',
      inviteToken: 'token-1',
    });
    expect(readWebRoute('/app/', '', '/app/')).toEqual({ name: 'home' });
    expect(roomPath('room 1', '/app/')).toBe('/app/#/rooms/room%201');
    expect(joinPath('/app/')).toBe('/app/#/join');
    expect(inviteUrl('https://example.test', 'token 1', '/app/'))
      .toBe('https://example.test/app/?join=1#/join?invite=token%201');
  });

  it('keeps the join page after a redirect removes the hash and accepts pasted invitations', () => {
    const token = 'abc_DEF-12345678901234567890123456';
    const shared = new URL(inviteUrl('https://example.test', token, '/app/'));
    expect(readWebRoute(shared.pathname, shared.hash, '/app/', shared.search))
      .toEqual({ name: 'join', inviteToken: token });
    expect(readWebRoute(shared.pathname, '', '/app/', shared.search))
      .toEqual({ name: 'join', inviteToken: '' });
    expect(inviteTokenFromInput(shared.href)).toBe(token);
    expect(inviteTokenFromInput(`https://example.test/app/#/join?invite=${token}`)).toBe(token);
    expect(inviteTokenFromInput(`http://localhost/join#invite=${token}`)).toBe(token);
    expect(inviteTokenFromInput(` ${token} `)).toBe(token);
  });
});
