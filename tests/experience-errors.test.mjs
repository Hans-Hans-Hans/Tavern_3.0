import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const {experienceError}=loadTs('../lib/experience-errors.ts',{});
test('upload and network errors explain the next step without leaking transport secrets',()=>{
 assert.match(experienceError({status:413,message:'https://test/upload?access_token=private'},'upload').message,/Admin → Storage/);
 const value=experienceError({status:503,message:'Bearer private-secret',details:{errcode:'SFU_ERROR',token:'private'}} ,'call');
 assert.deepEqual(value,{message:'The server could not finish this request. Try again in a moment.',code:'SFU_ERROR',status:503});
 assert.match(experienceError(new TypeError('Failed to fetch')).message,/Check your connection/);
 assert.equal(experienceError(new Error('Choose a channel name.')).message,'Choose a channel name.');
});
