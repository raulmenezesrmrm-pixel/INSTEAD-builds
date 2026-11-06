// Contador "Pessoas procurando Elias" da página do jogo (Cloudflare Pages Functions, 05/11/2026).
// Endereço: https://instead.pages.dev/api/procurando
//   GET  -> {"count": N}
//   POST -> soma 1 (no máximo uma vez por dia para cada endereço de internet) e devolve {"count": N}
// O número fica no KV ligado ao projeto "instead" com o nome de variável CONTADOR
// (Workers & Pages > instead > Settings > Bindings). Sem ele, responde 503 e a página esconde o contador.
// Guarda só um resumo (SHA-256) do endereço + dia, nunca o endereço em si.

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

export async function onRequest({ request, env }) {
  if (!env.CONTADOR) return json({ error: "contador desligado" }, 503);
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "método" }, 405);
  let count = parseInt((await env.CONTADOR.get("procurando")) || "0", 10) || 0;
  if (request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const day = new Date().toISOString().slice(0, 10);
    const seenKey = "visto:" + (await sha256(ip + "|" + day));
    if (!(await env.CONTADOR.get(seenKey))) {
      count += 1;
      await env.CONTADOR.put("procurando", String(count));
      await env.CONTADOR.put(seenKey, "1", { expirationTtl: 60 * 60 * 48 });
    }
  }
  return json({ count });
}
