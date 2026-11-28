import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarChave } from '../src/meudanfe.js';
const base = '3526111234567800012355001000000001100000000';
let soma = 0;
for (let i = 42, p = 2; i >= 0; i--, p = p === 9 ? 2 : p + 1) soma += Number(base[i]) * p;
const dv = soma % 11 < 2 ? 0 : 11 - soma % 11;
const chave = base + dv;
test('valida chave sintética de NF-e sem consultar o site', () => {
  assert.equal(base.length, 43);
  assert.equal(validarChave(chave), chave);
  assert.equal(validarChave(' '+chave+' '), chave);
  assert.throws(() => validarChave(base + ((dv + 1) % 10)), { status: 400 });
  assert.throws(() => validarChave('123'), { status: 400 });
  assert.throws(() => validarChave(chave.slice(0,20)+'65'+chave.slice(22)), { status: 400 });
});
