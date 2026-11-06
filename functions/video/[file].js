// Vídeos da página do jogo com "pedaços" (Range), para dar para pular no vídeo pela linha do play
// (06/11/2026). O Cloudflare Pages entrega os arquivos estáticos sempre inteiros (200, sem
// Content-Range) e aí o Chrome não deixa avançar o vídeo; este código pega o arquivo normal e
// devolve só o pedaço pedido (206). Vale para tudo em /video/ (cutscene_pt/en.mp4, gameplay.mp4).

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {  // "bytes=-500" = os últimos 500 bytes
    start = Math.max(size - parseInt(m[2], 10), 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) return "invalido";
  return { start, end };
}

export async function onRequest({ request, next }) {
  const res = await next();  // o arquivo estático de sempre
  if (res.status !== 200) return res;
  const range = request.headers.get("Range");
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");
  if (!range) return new Response(res.body, { status: 200, headers });
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const r = parseRange(range, size);
  if (r === null) return new Response(buf, { status: 200, headers });
  if (r === "invalido") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${r.start}-${r.end}/${size}`);
  headers.set("Content-Length", String(r.end - r.start + 1));
  return new Response(request.method === "HEAD" ? null : buf.slice(r.start, r.end + 1), { status: 206, headers });
}
