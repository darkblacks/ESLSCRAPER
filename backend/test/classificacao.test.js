import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temas, rankCatalog, createClassifier } from '../src/classificacao.js';
test('reconhece categoria sem inventar ID', () => {
  assert.deepEqual(temas('Troca de lona de freio'), ['FREIO']);
  assert.deepEqual(temas('MOTOR DE PARTIDA'), ['ELETRICA']);
  const c = [{id:1,nome:'FREIO - LONA'},{id:2,nome:'FREIO - DISCO'}];
  assert.equal(rankCatalog('Troca de lona de freio',c,'set').selected.id,1);
  assert.equal(rankCatalog('FREIO',c,'set').selected,null);
  assert.equal(rankCatalog('CABINE',c,'set').selected,null);
});
test('grupo e serviço exigem correspondência e recusam empate', () => {
  assert.equal(rankCatalog('LONA DE FREIO',[{id:5,nome:'FREIO'},{id:6,nome:'CABINE'}],'group').selected.id,5);
  assert.equal(rankCatalog('MÃO DE OBRA',[{id:7,nome:'MÃO DE OBRA',text:'7 - MÃO DE OBRA'}],'service').selected.id,7);
  assert.equal(rankCatalog('MÃO DE OBRA',[{id:7,nome:'MÃO DE OBRA'},{id:8,nome:'MÃO DE OBRA'}],'service').selected,null);
  assert.equal(rankCatalog('LONA FREIO E PNEU',[{id:5,nome:'FREIO'}],'group').selected,null);
});
test('cache evita repetir consultas no mesmo preview', async () => {
  let calls=0; const fn=async () => {calls++; return [{id:1,nome:'FREIO - LONA'}]};
  const run=createClassifier({setItems:fn,groups:fn,services:fn});
  const first=await run('LONA DE FREIO','set'); const count=calls;
  assert.equal(first.selected.id,1);
  await run('LONA DE FREIO','set'); assert.equal(calls,count);
});
