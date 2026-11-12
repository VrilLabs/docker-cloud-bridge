import test from 'node:test';
import assert from 'node:assert/strict';
import {authorized,resolveJob,scriptFor} from '../policy.mjs';
const sha='a'.repeat(40);
const c={app:{repo:'https://github.com/example/app.git',tasks:{test:'npm test'}}};
test('constant time bearer comparison',()=>{assert(authorized({authorization:'Bearer abc'},'abc'));assert(!authorized({authorization:'Bearer wrong'},'abc'));assert(!authorized({},'abc'));assert(!authorized(undefined,'abc'));});
test('accepts the same key as bearer, bare Authorization or X-API-Key, ignoring stray whitespace',()=>{
  for (const h of [{authorization:'bearer abc'},{authorization:'Bearer  abc \r\n'},{authorization:'abc'},{'x-api-key':'abc'},{'x-api-key':' abc\r\n'}]) assert(authorized(h,'abc'),JSON.stringify(h));
});
test('rejects wrong, empty, truncated or longer keys in every format',()=>{
  for (const h of [{authorization:'Bearer '},{authorization:'Bearer ab'},{authorization:'Bearer abcd'},{authorization:'wrong'},{'x-api-key':'wrong'},{'x-api-key':''},{authorization:'Basic abc'}]) assert(!authorized(h,'abc'),JSON.stringify(h));
});
test('allowlisted job and pinned SHA',()=>{const j=resolveJob(c,'app','test',sha);assert(scriptFor(j,sha).includes('npm test'));assert.throws(()=>resolveJob(c,'app','test','main'));assert.throws(()=>resolveJob(c,'app','oops',sha));assert.throws(()=>resolveJob(c,'__proto__','test',sha));});
test('reject credential and arbitrary host URL',()=>{assert.throws(()=>resolveJob({x:{repo:'https://evil.com/a/b',tasks:{test:'true'}}},'x','test',sha));});
