// Acessos à página do jogo e de onde vieram (Cloudflare Pages Functions, 17/11/2026, pedido dele: ver no /admin quem
// chegou pelo Instagram e por outros lugares).
// Endereço: https://instead.pages.dev/api/visitas
//   POST {origem, site?}   -> soma 1 acesso (a página manda ao abrir; origem já classificada por ela, ver ORIGENS)
//   GET  (cabeçalho x-senha) -> {origens: {<origem>: {acessos, pessoas}}, dias: [{dia, acessos, pessoas,
//                                instagram}] dos últimos DIAS dias, sites: [{site, acessos}] (origem "outros")}
// Guarda no mesmo KV do contador (variável CONTADOR):
//   vis:o:<origem>, vis:op:<origem>            acessos e pessoas desde o começo, por origem
//   vis:d:<AAAA-MM-DD>, vis:dp:..., vis:di:... acessos, pessoas e acessos do Instagram por dia (somem em 120 dias)
//   vis:s:<site>                               acessos de cada outro site (origem "outros")
//   visvisto:<sha256(ip|dia)>                  "essa pessoa já entrou hoje" (some em 2 dias; nunca o endereço em si)
//   vis:robo, vis:dr:<AAAA-MM-DD>              robôs ignorados (total e por dia; 27/11/2026), não entram nos acessos
// "Pessoas" = no máximo 1 por endereço de internet por dia (a origem dela é a do 1º acesso do dia).
// A senha é a mesma do feedback: só o SHA-256 de "instead-feedback|<senha>" (variável INSTEAD_FEEDBACK_SENHA no PC dele).

const SENHA_SHA256 = "535f5eba374f6786c6de5e7cf5b843eab35f935b575ff61f6406a2853e4a1007";
const ORIGENS = ["instagram", "google", "facebook", "youtube", "tiktok", "twitter", "reddit", "discord", "github", "direto", "outros"];
const DIAS = 14;
// Robôs pelo nome do navegador (o mesmo filtro da página, conferido de novo aqui para quem chamar a API direto).
const ROBO = /bot|crawl|spider|slurp|scrap|headless|lighthouse|pagespeed|preview|phantom|puppeteer|playwright|selenium|python|curl|wget|java\/|go-http|httpclient|monitor|uptime|scan/i;

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

async function ler(kv, chave) {
  return parseInt((await kv.get(chave)) || "0", 10) || 0;
}

async function somar(kv, chave, ttl) {
  const n = (await ler(kv, chave)) + 1;
  await kv.put(chave, String(n), ttl ? { expirationTtl: ttl } : undefined);
}

export async function onRequest({ request, env }) {
  const kv = env.CONTADOR;
  if (!kv) return json({ erro: "desligado" }, 503);

  if (request.method === "POST") {
    let d;
    try { d = JSON.parse(await request.text()); } catch (e) { return json({ erro: "formato" }, 400); }
    const origem = ORIGENS.includes(d.origem) ? d.origem : "outros";
    // (só o nome do site, em minúsculas, sem www: nada de caminho ou parâmetros)
    const site = String(d.site || "").toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[\/?#:]/)[0]
      .replace(/^www\./, "").replace(/[^a-z0-9.\-]/g, "").slice(0, 60);
    const dia = new Date().toISOString().slice(0, 10);
    const ttl = 60 * 60 * 24 * 120;
    // (27/11/2026) robô não conta como acesso: só soma em "robôs ignorados" (vis:robo e vis:dr:<dia>)
    const ua = request.headers.get("user-agent") || "";
    if (d.robo === true || !ua || ROBO.test(ua)) {
      await somar(kv, "vis:robo");
      await somar(kv, "vis:dr:" + dia, ttl);
      return json({ ok: true });
    }
    await somar(kv, "vis:o:" + origem);
    await somar(kv, "vis:d:" + dia, ttl);
    if (origem === "instagram") await somar(kv, "vis:di:" + dia, ttl);
    if (origem === "outros" && site) await somar(kv, "vis:s:" + site);
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const visto = "visvisto:" + (await sha256(ip + "|" + dia));
    if (!(await kv.get(visto))) {
      await kv.put(visto, "1", { expirationTtl: 60 * 60 * 48 });
      await somar(kv, "vis:op:" + origem);
      await somar(kv, "vis:dp:" + dia, ttl);
    }
    return json({ ok: true });
  }

  if (request.method === "GET") {
    if (!(await autorizado(request))) return json({ erro: "senha" }, 401);
    const origens = {};
    for (const o of ORIGENS) origens[o] = { acessos: await ler(kv, "vis:o:" + o), pessoas: await ler(kv, "vis:op:" + o) };
    const dias = [];
    const hoje = Date.now();
    for (let i = 0; i < DIAS; i++) {
      const dia = new Date(hoje - i * 86400000).toISOString().slice(0, 10);
      dias.push({ dia, acessos: await ler(kv, "vis:d:" + dia), pessoas: await ler(kv, "vis:dp:" + dia), instagram: await ler(kv, "vis:di:" + dia), robos: await ler(kv, "vis:dr:" + dia) });
    }
    const robos = await ler(kv, "vis:robo");
    const lista = await kv.list({ prefix: "vis:s:", limit: 200 });
    const sites = [];
    for (const k of lista.keys) sites.push({ site: k.name.slice(6), acessos: await ler(kv, k.name) });
    sites.sort((a, b) => b.acessos - a.acessos);
    return json({ origens, dias, sites: sites.slice(0, 30), robos });
  }

  return json({ erro: "método" }, 405);
}
