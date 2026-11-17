// Cliques nos botões de download da página do jogo (Cloudflare Pages Functions, 17/11/2026, pedido dele: ver no
// /admin quantos cliques já teve no Windows e no Mac).
// Endereço: https://instead.pages.dev/api/downloads
//   POST {so: "windows"|"mac"}      -> soma 1 clique (a página manda com navigator.sendBeacon ao clicar)
//   GET  (cabeçalho x-senha)        -> {total: {windows, mac}, pessoas: {windows, mac}, dias: [{dia, windows, mac,
//                                      pessoas_windows, pessoas_mac}] dos últimos DIAS dias, mais novo primeiro}
// Guarda no mesmo KV do contador (variável CONTADOR):
//   dl:total:<so>, dl:pessoas:<so>          totais desde o começo
//   dl:dia:<so>:<AAAA-MM-DD>, dl:pdia:...    por dia (somem depois de 120 dias)
//   dlvisto:<sha256(ip|dia|so)>              "essa pessoa já clicou hoje" (some em 2 dias; nunca o endereço em si)
// "Pessoas" = no máximo 1 por endereço de internet por dia em cada sistema (um clique repetido não conta de novo).
// A senha é a mesma do feedback: só o SHA-256 de "instead-feedback|<senha>" (variável INSTEAD_FEEDBACK_SENHA no PC dele).

const SENHA_SHA256 = "535f5eba374f6786c6de5e7cf5b843eab35f935b575ff61f6406a2853e4a1007";
const SISTEMAS = ["windows", "mac"];
const DIAS = 14;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function autorizado(request) {
  const senha = request.headers.get("x-senha") || "";
  if (!senha) return false;
  const h = await sha256("instead-feedback|" + senha);
  let diff = h.length ^ SENHA_SHA256.length;
  for (let i = 0; i < Math.min(h.length, SENHA_SHA256.length); i++) diff |= h.charCodeAt(i) ^ SENHA_SHA256.charCodeAt(i);
  return diff === 0;
}

async function somar(kv, chave, ttl) {
  const n = (parseInt((await kv.get(chave)) || "0", 10) || 0) + 1;
  await kv.put(chave, String(n), ttl ? { expirationTtl: ttl } : undefined);
}

async function ler(kv, chave) {
  return parseInt((await kv.get(chave)) || "0", 10) || 0;
}

export async function onRequest({ request, env }) {
  const kv = env.CONTADOR;
  if (!kv) return json({ erro: "desligado" }, 503);

  if (request.method === "POST") {
    let so = "";
    try { so = String(JSON.parse(await request.text()).so || ""); } catch (e) { return json({ erro: "formato" }, 400); }
    if (!SISTEMAS.includes(so)) return json({ erro: "so" }, 400);
    const dia = new Date().toISOString().slice(0, 10);
    const ttl = 60 * 60 * 24 * 120;
    await somar(kv, "dl:total:" + so);
    await somar(kv, "dl:dia:" + so + ":" + dia, ttl);
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const visto = "dlvisto:" + (await sha256(ip + "|" + dia + "|" + so));
    if (!(await kv.get(visto))) {
      await kv.put(visto, "1", { expirationTtl: 60 * 60 * 48 });
      await somar(kv, "dl:pessoas:" + so);
      await somar(kv, "dl:pdia:" + so + ":" + dia, ttl);
    }
    return json({ ok: true });
  }

  if (request.method === "GET") {
    if (!(await autorizado(request))) return json({ erro: "senha" }, 401);
    const total = {}, pessoas = {};
    for (const so of SISTEMAS) {
      total[so] = await ler(kv, "dl:total:" + so);
      pessoas[so] = await ler(kv, "dl:pessoas:" + so);
    }
    const dias = [];
    const hoje = Date.now();
    for (let i = 0; i < DIAS; i++) {
      const dia = new Date(hoje - i * 86400000).toISOString().slice(0, 10);
      const linha = { dia };
      for (const so of SISTEMAS) {
        linha[so] = await ler(kv, "dl:dia:" + so + ":" + dia);
        linha["pessoas_" + so] = await ler(kv, "dl:pdia:" + so + ":" + dia);
      }
      dias.push(linha);
    }
    return json({ total, pessoas, dias });
  }

  return json({ erro: "método" }, 405);
}
