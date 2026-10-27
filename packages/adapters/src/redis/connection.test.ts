import { describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { InvalidRedisUrlError, parseRedisUrl, redisClientOptions, redisUrlHasPassword } from './connection.js';

describe('parseRedisUrl', () => {
  it('reads scheme, user and whether a password is present, never the password itself', () => {
    expect(parseRedisUrl('redis://proba:s3cret@redis:6379')).toEqual({ tls: false, username: 'proba', hasPassword: true, host: 'redis' });
    expect(parseRedisUrl('rediss://:s3cret@cache.example.com:6380')).toEqual({ tls: true, username: '', hasPassword: true, host: 'cache.example.com' });
    expect(JSON.stringify(parseRedisUrl('redis://u:s3cret@h'))).not.toContain('s3cret');
  });

  it('knows a URL without a password', () => {
    expect(parseRedisUrl('redis://localhost:6379').hasPassword).toBe(false);
    expect(parseRedisUrl('redis://proba@localhost:6379').hasPassword).toBe(false);
    expect(parseRedisUrl('redis://proba:@localhost:6379').hasPassword).toBe(false);
    expect(redisUrlHasPassword('redis://proba:x@localhost')).toBe(true);
    expect(redisUrlHasPassword('redis://localhost')).toBe(false);
    expect(redisUrlHasPassword('not a url')).toBe(false);
  });

  it('decodes a percent-encoded password', () => {
    expect(parseRedisUrl('redis://u:%40%3A@h').hasPassword).toBe(true);
  });

  it('refuses other schemes and garbage', () => {
    expect(() => parseRedisUrl('http://redis:6379')).toThrow(InvalidRedisUrlError);
    expect(() => parseRedisUrl('redis+tls://redis:6379')).toThrow(/unsupported scheme/);
    expect(() => parseRedisUrl('nope')).toThrow(InvalidRedisUrlError);
  });
});

describe('redisClientOptions (TLS)', () => {
  it('rediss:// turns TLS on with certificate verification, and keeps the caller socket settings', () => {
    const o = redisClientOptions('rediss://:pw@cache.example.com:6380', { socket: { connectTimeout: 1234 } });
    expect(o.socket).toMatchObject({ tls: true, rejectUnauthorized: true, connectTimeout: 1234 });
    const client = createClient(o);
    expect((client.options?.socket as { tls?: boolean } | undefined)?.tls).toBe(true);
  });

  it('redis:// stays plain TCP', () => {
    const o = redisClientOptions('redis://:pw@redis:6379');
    expect((o.socket as { tls?: boolean }).tls).toBeUndefined();
    expect(o.url).toBe('redis://:pw@redis:6379');
  });

  it('never turns certificate verification off', () => {
    const o = redisClientOptions('rediss://h', { socket: { connectTimeout: 1 } });
    expect((o.socket as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(true);
  });

  it('refuses an unusable URL before creating a client', () => {
    expect(() => redisClientOptions('mysql://x')).toThrow(InvalidRedisUrlError);
  });
});
