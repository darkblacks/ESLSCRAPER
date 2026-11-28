import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kmInteiro, restricaoHodometro } from '../src/hodometro.js';
test('limite mais restritivo de abastecimento e manifesto', () => {
  const r = restricaoHodometro('Hodômetro Atual não pode ser maior que o abastecimento Nº 15059 (Hodômetro: 973406)\nHodômetro Atual não pode ser maior que o manifesto Nº 93248 (Km saída/chegada: 973257)', 980000);
  assert.equal(r.max, 973257);
  assert.equal(r.sugestao, 973257);
  assert.equal(r.limites.length, 2);
});
test('limite inferior, formatação e conflito', () => {
  assert.equal(kmInteiro('973.257'), 973257);
  assert.equal(kmInteiro(''), null);
  assert.equal(kmInteiro(1.5), null);
  assert.equal(restricaoHodometro('Hodômetro Atual não pode ser menor que o abastecimento (Hodômetro: 973.257)', 1).sugestao, 973257);
  assert.equal(restricaoHodometro('erro de fornecedor'), null);
  assert.equal(restricaoHodometro('Hodômetro Atual não pode ser menor que o abastecimento (Hodômetro: 200)\nHodômetro Atual não pode ser maior que o manifesto (Km saída/chegada: 100)', 150).conflitante, true);
});

test('captura mensagens renderizadas em múltiplas linhas e resumo duplicado', () => {
  const a = 'Hodômetro Atual não pode ser maior que o abastecimento Nº 15059 (Hodômetro: 973406)';
  const b = 'Hodômetro Atual não pode ser maior que o manifesto Nº 93248 (Km saída/chegada: 973257)';
  const r = restricaoHodometro('Averbação\n'+a+'\n'+b+'\nNova OS\nHodômetro Atual\n'+a, 974422);
  assert.equal(r.limites.length,2);
  assert.equal(r.sugestao,973257);
  assert.equal(r.max,973257);
});
test('aceita do que, espaços não separáveis e números formatados', () => {
  const r = restricaoHodometro('Hodômetro Atual não pode ser maior do que o manifesto Nº 93248\n(Km saída / chegada: 973.257 km)',974422);
  assert.equal(r.sugestao,973257);
});
test('sem referência numérica não sugere o valor rejeitado', () => {
  assert.equal(restricaoHodometro('Hodômetro inválido',974422).sugestao,null);
});
