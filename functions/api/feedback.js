// Sugestões e bugs da página do jogo (Cloudflare Pages Functions, 16/11/2026).
// Endereço: https://instead.pages.dev/api/feedback
//   POST   {tipo, texto, email?, versao?, sistema?, idioma?, site?, imagem?} -> guarda e devolve {ok: true}
//          (imagem = "data:image/jpeg|png|webp;base64,..." já reduzida pela página, até MAX_IMG bytes; fica na
//           chave "fbimg:<id da mensagem>" e a mensagem ganha imagem: true)
//   GET    (cabeçalho x-senha) -> {itens: [...]}, mais novos primeiro (página escondida /mensagens)
//   GET    ?img=<id> (cabeçalho x-senha) -> a imagem da mensagem
//   DELETE ?id=<chave> (cabeçalho x-senha) -> apaga uma mensagem (e a imagem dela)
// Guarda no mesmo KV do contador (variável CONTADOR), chaves "fb:<tempo invertido>-<sorteio>".
// A senha NÃO está aqui: só o SHA-256 de "instead-feedback|<senha>" (a senha é longa e sorteada; o
// usuário guarda na variável de ambiente INSTEAD_FEEDBACK_SENHA do PC dele).
// Anti-spam: campo escondido "site" (robôs preenchem) e no máximo MAX_DIA mensagens por endereço por dia
// (guarda só o SHA-256 do endereço + dia, nunca o endereço).

const SENHA_SHA256 = "535f5eba374f6786c6de5e7cf5b843eab35f935b575ff61f6406a2853e4a1007";
const MAX_DIA = 5;
const MAX_TEXTO = 2000;
const MAX_IMG = 1500000; // bytes da imagem já decodificada (a página reduz para 1600 px em JPEG)

// "data:image/...;base64,..." -> {tipo, bytes} ou null se não for imagem aceita
function lerImagem(s) {
  if (typeof s !== "string" || !s) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return { erro: true };
  let bin;
  try { bin = atob(m[2]); } catch (e) { return { erro: true }; }
  if (bin.length > MAX_IMG) return { grande: true };
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { tipo: m[1], bytes };
}

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
  // (comparação sem sair cedo)
  let diff = h.length ^ SENHA_SHA256.length;
  for (let i = 0; i < Math.min(h.length, SENHA_SHA256.length); i++) diff |= h.charCodeAt(i) ^ SENHA_SHA256.charCodeAt(i);
  return diff === 0;
}

function curto(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function onRequest({ request, env }) {
  const kv = env.CONTADOR;
  if (!kv) return json({ erro: "desligado" }, 503);

  if (request.method === "POST") {
    if (parseInt(request.headers.get("content-length") || "0", 10) > 2200000) return json({ erro: "grande" }, 413);
    let d;
    try { d = await request.json(); } catch (e) { return json({ erro: "formato" }, 400); }
    if (curto(d.site, 200)) return json({ ok: true }); // (robô: finge que deu certo e não guarda)
    const tipo = d.tipo === "bug" ? "bug" : "sugestao";
    const texto = curto(d.texto, MAX_TEXTO);
    if (texto.length < 5) return json({ erro: "curto" }, 400);
    const img = lerImagem(d.imagem);
    if (img && img.grande) return json({ erro: "imagem grande" }, 413);
    if (img && img.erro) return json({ erro: "imagem" }, 415);
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const dia = new Date().toISOString().slice(0, 10);
    const chaveDia = "fbdia:" + (await sha256(ip + "|" + dia));
    const usados = parseInt((await kv.get(chaveDia)) || "0", 10) || 0;
    if (usados >= MAX_DIA) return json({ erro: "limite" }, 429);
    const agora = Date.now();
    const id = "fb:" + String(9999999999999 - agora).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 7);
    const item = {
      id,
      tipo,
      texto,
      email: curto(d.email, 120),
      versao: curto(d.versao, 20),
      sistema: curto(d.sistema, 20),
      idioma: curto(d.idioma, 5),
      pais: (request.cf && request.cf.country) || "",
      quando: new Date(agora).toISOString(),
      imagem: !!img,
    };
    if (img) await kv.put("fbimg:" + id, img.bytes, { metadata: { tipo: img.tipo } });
    await kv.put(id, JSON.stringify(item));
    await kv.put(chaveDia, String(usados + 1), { expirationTtl: 60 * 60 * 48 });
    return json({ ok: true });
  }

  if (request.method === "GET" || request.method === "DELETE") {
    if (!(await autorizado(request))) return json({ erro: "senha" }, 401);
    if (request.method === "DELETE") {
      const id = new URL(request.url).searchParams.get("id") || "";
      if (!id.startsWith("fb:")) return json({ erro: "id" }, 400);
      await kv.delete(id);
      await kv.delete("fbimg:" + id);
      return json({ ok: true });
    }
    const imgId = new URL(request.url).searchParams.get("img");
    if (imgId) {
      if (!imgId.startsWith("fb:")) return json({ erro: "id" }, 400);
      const r = await kv.getWithMetadata("fbimg:" + imgId, { type: "arrayBuffer" });
      if (!r || !r.value) return json({ erro: "sem imagem" }, 404);
      const tipo = (r.metadata && r.metadata.tipo) || "image/jpeg";
      return new Response(r.value, { headers: { "content-type": tipo, "cache-control": "no-store" } });
    }
    const lista = await kv.list({ prefix: "fb:", limit: 1000 });
    const itens = (await Promise.all(lista.keys.map((k) => kv.get(k.name)))).filter(Boolean).map((v) => {
      try { return JSON.parse(v); } catch (e) { return null; }
    }).filter(Boolean);
    return json({ itens });
  }

  return json({ erro: "método" }, 405);
}
