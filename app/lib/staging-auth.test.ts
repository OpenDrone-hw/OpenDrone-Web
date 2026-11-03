import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {STAGING_AUTH_USER, stagingCredentialsOk} from './staging-auth.ts';

const basic = (raw: string) => `Basic ${btoa(raw)}`;
const U = STAGING_AUTH_USER;

describe('stagingCredentialsOk', () => {
  it('accepts the right user and password', () => assert.equal(stagingCredentialsOk(basic(`${U}:s3cret`), 's3cret'), true));
  it('accepts a password containing ":" (split at the first colon only)', () => {
    assert.equal(stagingCredentialsOk(basic(`${U}:a:b:c`), 'a:b:c'), true);
    assert.equal(stagingCredentialsOk(basic(`${U}:a:b`), 'a'), false);
  });
  it('rejects a wrong password, wrong user, and a prefix or longer password', () => {
    assert.equal(stagingCredentialsOk(basic(`${U}:wrong`), 's3cret'), false);
    assert.equal(stagingCredentialsOk(basic(`x:s3cret`), 's3cret'), false);
    assert.equal(stagingCredentialsOk(basic(`${U}:s3cre`), 's3cret'), false);
    assert.equal(stagingCredentialsOk(basic(`${U}:s3cret!`), 's3cret'), false);
  });
  it('fails closed on an empty or missing password', () => {
    assert.equal(stagingCredentialsOk(basic(`${U}:`), ''), false);
    assert.equal(stagingCredentialsOk(basic(`${U}:x`), ''), false);
    assert.equal(stagingCredentialsOk(basic(`${U}:`), 's3cret'), false);
  });
  it('rejects malformed headers', () => {
    for (const h of [null, '', 'Basic ', 'Basic !!!notbase64', 'Bearer abc', basic('nocolon'), `basic ${btoa(`${U}:s3cret`)}`]) {
      assert.equal(stagingCredentialsOk(h, 's3cret'), false, String(h));
    }
  });
});
