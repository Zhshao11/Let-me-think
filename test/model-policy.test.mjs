import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { config, RESEARCH_MODEL, saveConfig } from '../src/config.mjs';
import { chatRequestBody } from '../src/upstream.mjs';

test('every upstream request uses the single research model and explicit alternatives fail before sending',()=>{
  assert.equal(config.model,'gpt-6.1-sol');
  assert.equal(chatRequestBody({messages:[]}).model,RESEARCH_MODEL);
  assert.equal(chatRequestBody({messages:[],model:RESEARCH_MODEL}).model,RESEARCH_MODEL);
  assert.throws(()=>chatRequestBody({messages:[],model:'gpt-4o-mini'}),/已阻止/);
  assert.throws(()=>saveConfig({model:'gpt-4o-mini'}),/固定/);
  assert.throws(()=>{config.model='other';},TypeError);
});

test('legacy environment settings cannot switch the research model',()=>{
  const output=execFileSync(process.execPath,['--input-type=module','-e',"import {config} from './src/config.mjs'; process.stdout.write(config.model);"],{
    cwd:new URL('..',import.meta.url),env:{...process.env,OPENAI_MODEL:'gpt-4o-mini'},encoding:'utf8',
  });
  assert.equal(output,RESEARCH_MODEL);
});
