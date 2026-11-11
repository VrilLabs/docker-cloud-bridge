import test from 'node:test';
import assert from 'node:assert/strict';
import {authorized,resolveJob,scriptFor} from '../policy.mjs';
const sha='a'.repeat(40);
const c={app:{repo:'https://github.com/example/app.git',tasks:{test:'npm test'}}};
test('constant time bearer comparison',()=>{assert(authorized('Bearer abc','abc'));assert(!authorized('Bearer wrong','abc'));assert(!authorized(undefined,'abc'));});
test('allowlisted job and pinned SHA',()=>{const j=resolveJob(c,'app','test',sha);assert(scriptFor(j,sha).includes('npm test'));assert.throws(()=>resolveJob(c,'app','test','main'));assert.throws(()=>resolveJob(c,'app','oops',sha));assert.throws(()=>resolveJob(c,'__proto__','test',sha));});
test('reject credential and arbitrary host URL',()=>{assert.throws(()=>resolveJob({x:{repo:'https://evil.com/a/b',tasks:{test:'true'}}},'x','test',sha));});
