const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const PORT = process.env.PORT || 3000;

function get(href) {
  return new Promise((resolve, reject) => {
    const u = new URL(href);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers: {
        "User-Agent": "SEC-Holdings-Agent brandon.ferree@gmail.com",
        "Accept":     "application/json, text/html, */*",
      },
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${u.hostname}${res.headers.location}`;
        return get(next).then(resolve).catch(reject);
      }
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body, ct: res.headers["content-type"] || "" }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });
}

function jsonResp(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

async function findDocUrl(query) {
  for (const q of [`"${query}"`, query]) {
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=NPORT-P&dateRange=custom&startdt=2023-01-01&enddt=2026-12-31`;
    const { status, body, ct } = await get(searchUrl);
    if (status === 403) throw new Error("SEC EDGAR returned 403 — update the User-Agent email in server.js");
    if (status !== 200) throw new Error(`EDGAR search returned HTTP ${status}: ${body.slice(0, 80)}`);
    if (!ct.includes("json")) throw new Error(`EDGAR returned unexpected response: ${body.slice(0, 80)}`);
    const data = JSON.parse(body);
    const hits = data.hits?.hits;
    if (!hits || hits.length === 0) continue;
    const hit = hits[0];
    const src = hit._source;
    const [accNo, filename] = hit._id.split(":");
    if (!accNo || !filename) throw new Error(`Unexpected _id format: ${hit._id}`);
    const accNoDashes = accNo.replace(/-/g, "");
    const cik = src.entity_id || src.cik || "";
    if (!cik) throw new Error("Could not determine CIK from search result");
    return {
      docUrl:     `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${filename}`,
      indexUrl:   `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${accNo}-index.htm`,
      period:     src.period_of_report,
      filingDate: src.file_date,
      entityName: src.entity_name,
      cik, accNo,
    };
  }
  throw new Error(`No NPORT-P filing found for "${query}". Try the full fund name.`);
}

async function fetchDoc(docUrl) {
  const { status, body } = await get(docUrl);
  if (status !== 200) throw new Error(`Failed to fetch filing (HTTP ${status}): ${docUrl}`);
  return body;
}

function parseHoldings(html) {
  const strip = s => s
    .replace(/<[^>]+>/g, "")
    .replace(/&/g,"&").replace(/</g,"<").replace(/>/g,">")
    .replace(/ /g," ").replace(/ /g," ").replace(/&#[0-9]+;/g,"")
    .replace(/\s+/g," ").trim();
  const inThousands = /in thousands/i.test(html);
  const holdings = [], seen = new Set();
  let sector = null;
  for (const row of (html.match(//gi) || [])) {
    const cells = (row.match(/]*>([\s\S]*?)<\/t[dh]>/gi) || [])
      .map(c => strip(c.replace(/]*>/i,"").replace(/<\/t[dh]>/i,"")));
    if (cells.length < 2) continue;
    const full = cells.join(" ").trim();
    const sh = full.match(/^([A-Z][A-Za-z ,&\/()\-]+?)\s*[–—:\-]+\s*[\d.]+\s*%/);
    if (sh && !cells.some(c => /^\$?[\d]{1,3}(,\d{3})+$/.test(c.trim()))) { sector = sh[1].trim(); continue; }
    if (/^TOTAL\b|^Grand Total|^Common Stocks|^Shares$|^Value$/i.test(full.trim())) continue;
    const valueCell = cells.find(c => { const n=c.replace(/[$,\s]/g,""); return /^\d{4,}$/.test(n)&&parseInt(n)>100; });
    if (!valueCell) continue;
    const valueNum = parseInt(valueCell.replace(/[$,\s]/g,""));
    const sharesCell = cells.find(c => { const n=c.replace(/[,\s]/g,""); return /^\d+$/.test(n)&&n!==valueCell.replace(/[$,\s]/g,"")&&parseInt(n)>0; });
    const nameCell = cells.filter(c=>c.length>2&&!/^[\$\d,().%–—\-]+$/.test(c)&&!/^TOTAL|^Shares$|^Value$|^Common Stocks/i.test(c)).sort((a,b)=>b.length-a.length)[0];
    if (!nameCell) continue;
    const value = inThousands ? valueNum*1000 : valueNum;
    const shares = sharesCell ? parseInt(sharesCell.replace(/,/g,"")) : null;
    const name = nameCell.replace(/\s*\([a-z,\/]\)\s*/gi,"").replace(/\s+/g," ").trim();
    if (!name||value<=0||seen.has(name)) continue;
    seen.add(name);
    holdings.push({ name, sector, shares, value });
  }
  return { holdings };
}

async function handleSearch(req, res, query) {
  try {
    const filing = await findDocUrl(query);
    const html = await fetchDoc(filing.docUrl);
    const { holdings } = parseHoldings(html);
    if (holdings.length < 3) return jsonResp(res, 422, { error: `Only parsed ${holdings.length} holdings.`, docUrl: filing.docUrl });
    const total = holdings.reduce((s,h)=>s+h.value,0);
    jsonResp(res, 200, {
      query, fundName: filing.entityName, period: filing.period,
      filingDate: filing.filingDate, docUrl: filing.docUrl,
      indexUrl: filing.indexUrl, netAssets: total, count: holdings.length,
      holdings: holdings.map(h=>({...h, pct: parseFloat(((h.value/total)*100).toFixed(4))})),
    });
  } catch(err) { jsonResp(res, 500, { error: err.message }); }
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const type = {".html":"text/html",".js":"application/javascript",".css":"text/css"}[ext]||"text/plain";
  fs.readFile(filePath, (err,data)=>{ if(err){res.writeHead(404);res.end("Not found");return;} res.writeHead(200,{"Content-Type":type});res.end(data); });
}

http.createServer(async (req, res) => {
  const { pathname, query: qs } = url.parse(req.url, true);
  if (req.method==="OPTIONS") { res.writeHead(204,{"Access-Control-Allow-Origin":"*"}); res.end(); return; }
  if (pathname==="/api/search") {
    const q=(qs.q||"").trim();
    if(!q) return jsonResp(res,400,{error:"Missing ?q= parameter"});
    return handleSearch(req,res,q);
  }
  if (pathname==="/"||pathname==="/index.html") return serveStatic(res,path.join(__dirname,"public","index.html"));
  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log(`SEC Holdings Agent running on port ${PORT}`));
