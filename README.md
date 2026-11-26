# Syntra B2B

Portal demonstrativo de compras empresariais com catálogo em volume, preços por faixa e por empresa, cotações, aprovação de pedidos e painéis de operação.

## Arquitetura

- Web: Next.js 16, publicado na Netlify.
- API: Cloudflare Workers.
- Banco relacional: Cloudflare D1.
- Catálogo e registros usam dados fictícios. Não insira informações comerciais reais.
- Os botões de perfil na tela de acesso entram em contas demonstrativas; o login e a senha de uma empresa cadastrada são independentes.

## Operação

O Worker usa o binding D1 `DB`; a aplicação Netlify encaminha as rotas `/api/*` para a API com a variável privada `SYNTRA_API_URL`. A política CSP em `proxy.ts` usa nonce por requisição e não permite scripts inline sem nonce.