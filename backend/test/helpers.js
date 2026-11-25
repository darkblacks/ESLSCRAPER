// Utilitários dos testes: cada teste roda num diretório temporário (data/ isolado — nunca toca o histórico real).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esl-test-'));
  process.chdir(dir);
  return dir;
}

/** Sessão falsa: qualquer acesso falha o teste — prova que o fluxo NÃO tocou o ESL. */
export const sessaoProibida = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    throw new Error(`O teste tocou a sessão ESL (propriedade "${String(prop)}") — não deveria.`);
  },
});

export const NFE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe35261100000000000191550010000012341000012345" versao="4.00">
<ide><nNF>1234</nNF><serie>1</serie><natOp>VENDA</natOp><dhEmi>2026-11-09T15:01:00-03:00</dhEmi></ide>
<emit><CNPJ>00000000000191</CNPJ><xNome>FORNECEDOR TESTE LTDA</xNome><enderEmit><xMun>SAO PAULO</xMun><UF>SP</UF></enderEmit></emit>
<dest><CNPJ>11111111000111</CNPJ><xNome>DESTINATARIO TESTE</xNome></dest>
<det nItem="1"><prod><cProd>VA32634-143</cProd><cEAN>SEM GTIN</cEAN><xProd>9584770015-FILTRO DE OLEO</xProd><NCM>84212300</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>50.00</vUnCom><vProd>100.00</vProd><vDesc>10.00</vDesc></prod></det>
<det nItem="2"><prod><cProd>ABC</cProd><cEAN>7890000000000</cEAN><xProd>PASTILHA DE FREIO</xProd><NCM>87083090</NCM><CFOP>5102</CFOP><uCom>JG</uCom><qCom>1</qCom><vUnCom>200.00</vUnCom><vProd>200.00</vProd></prod></det>
<total><ICMSTot><vProd>300.00</vProd><vNF>290.00</vNF><vFrete>0</vFrete><vDesc>10.00</vDesc></ICMSTot></total>
<infAdic><infCpl>PEDIDO: P-77 PLACA ABC-1D23</infCpl></infAdic>
</infNFe></NFe><protNFe><infProt><chNFe>35261100000000000191550010000012341000012345</chNFe><cStat>100</cStat><nProt>135260000000001</nProt></infProt></protNFe></nfeProc>`;

export const NFSE_ABRASF = `<?xml version="1.0" encoding="UTF-8"?>
<CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd"><Nfse><InfNfse><Numero>987</Numero><CodigoVerificacao>ABCD1234</CodigoVerificacao><DataEmissao>2026-11-10T08:30:00</DataEmissao>
<Servico><Valores><ValorServicos>350.50</ValorServicos></Valores><Discriminacao>MAO DE OBRA REVISAO FREIOS PLACA ABC1D23</Discriminacao></Servico>
<PrestadorServico><IdentificacaoPrestador><Cnpj>22222222000122</Cnpj></IdentificacaoPrestador><RazaoSocial>OFICINA TESTE ME</RazaoSocial></PrestadorServico>
<TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>11111111000111</Cnpj></CpfCnpj></IdentificacaoTomador><RazaoSocial>DESTINATARIO TESTE</RazaoSocial></TomadorServico>
</InfNfse></Nfse></CompNfse>`;
