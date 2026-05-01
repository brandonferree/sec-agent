const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const PORT = process.env.PORT || 3000;

// ── In-memory cache so we only fetch ticker lists once ────────────────────
var tickerCache = { mf: null, stocks: null };

function get(href) {
  return new Promise(function(resolve, reject) {
    var u = new URL(href);
    var req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "User-Agent": "SEC-Holdings-Agent brandon.ferree@gmail.com",
        "Accept": "application/json, text/html, */*"
      }
    }, function(res) {
      if ([301,302,303,307,308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        var next = res.headers.location.startsWith("http")
          ? res.headers.location
          : "https://" + u.hostname + res.headers.location;
        return get(next).then(resolve).catch(reject);
      }
      var body = "";
      res.on("data", function(c) { body += c; });
      res.on("end", function() {
        resolve({ status: res.statusCode, body: body, ct: res.headers["content-type"] || "" });
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, function() { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });
}

function jsonResp(res, code, data) {
  var body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// ── Fetch and cache mutual fund ticker list ───────────────────────────────
function getMfTickers() {
  if (tickerCache.mf) return Promise.resolve(tickerCache.mf);
  console.log("Fetching mutual fund ticker list from SEC...");
  return get("https://www.sec.gov/files/company_tickers_mf.json").then(function(r) {
    if (r.status === 429) throw new Error("SEC rate limit hit. Please wait 10 seconds and try again.");
    if (r.status !== 200) throw new Error("Could not fetch mutual fund ticker list (HTTP " + r.status + ")");
    var data = JSON.parse(r.body);
    tickerCache.mf = data.data || [];
    console.log("Cached " + tickerCache.mf.length + " mutual fund tickers.");
    return tickerCache.mf;
  });
}

// ── Fetch and cache stock/ETF ticker list ─────────────────────────────────
function getStockTickers() {
  if (tickerCache.stocks) return Promise.resolve(tickerCache.stocks);
  console.log("Fetching stock ticker list from SEC...");
  return get("https://www.sec.gov/files/company_tickers.json").then(function(r) {
    if (r.status === 429) throw new Error("SEC rate limit hit. Please wait 10 seconds and try again.");
    if (r.status !== 200) throw new Error("Could not fetch stock ticker list (HTTP " + r.status + ")");
    var data = JSON.parse(r.body);
    tickerCache.stocks = Object.values(data);
    console.log("Cached " + tickerCache.stocks.length + " stock tickers.");
    return tickerCache.stocks;
  });
}

// ── Ticker → CIK lookup ───────────────────────────────────────────────────
function lookupByTicker(ticker) {
  var upper = ticker.toUpperCase().trim();

  // Try mutual fund list first (OAKLX, BVEFX, FCNTX etc)
  return getMfTickers().then(function(rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][3] && rows[i][3].toUpperCase() === upper) {
        var cik = String(rows[i][0]).padStart(10, "0");
        return { cik: cik, name: upper, ticker: upper };
      }
    }
    return null;
  }).then(function(result) {
    if (result) return result;
    // Try stock/ETF list as fallback
    return getStockTickers().then(function(entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].ticker && entries[i].ticker.toUpperCase() === upper) {
          var cik = String(entries[i].cik_str).padStart(10, "0");
          return { cik: cik, name: entries[i].title, ticker: upper };
        }
      }
      return null;
    });
  });
}

// ── CIK → latest NPORT-P filing ───────────────────────────────────────────
function getLatestNportByCik(cik, name) {
  return get("https://data.sec.gov/submissions/CIK" + cik + ".json").then(function(r) {
    if (r.status !== 200) throw new Error("Could not fetch filings for CIK " + cik + " (HTTP " + r.status + ")");
    var data     = JSON.parse(r.body);
    var filings  = data.filings && data.filings.recent;
    if (!filings) throw new Error("No filings found for CIK " + cik);

    var forms      = filings.form;
    var dates      = filings.filingDate;
    var accessions = filings.accessionNumber;
    var periods    = filings.periodOfReport;

    for (var i = 0; i < forms.length; i++) {
      if (forms[i] === "NPORT-P") {
        var accNo = accessions[i];
        return {
          cik:         cik,
          accNo:       accNo,
          accNoDashes: accNo.replace(/-/g, ""),
          period:      periods ? periods[i] : dates[i],
          filingDate:  dates[i],
          entityName:  name || data.name
        };
      }
    }
    throw new Error("No NPORT-P filing found for this ticker. The fund may not file NPORT-P with the SEC.");
  });
}

// ── Fund name → EDGAR full-text search ───────────────────────────────────
function searchByName(query) {
  var queries = ['"' + query + '"', query];
  var index   = 0;

  function tryNext() {
    if (index >= queries.length) {
      return Promise.reject(new Error(
        'No NPORT-P filing found for "' + query + '". Try the full fund name.'
      ));
    }
    var q = queries[index++];
    var searchUrl = "https://efts.sec.gov/LATEST/search-index?q=" + encodeURIComponent(q) +
      "&forms=NPORT-P&dateRange=custom&startdt=2023-01-01&enddt=2026-12-31";

    return get(searchUrl).then(function(r) {
      if (r.status === 403) throw new Error("SEC EDGAR returned 403. Update YOUR_EMAIL_HERE in server.js.");
      if (r.status === 429) throw new Error("SEC rate limit hit. Please wait 10 seconds and try again.");
      if (r.status !== 200) throw new Error("EDGAR search returned HTTP " + r.status);
      if (!r.ct.includes("json")) throw new Error("EDGAR returned unexpected response: " + r.body.slice(0, 80));

      var data = JSON.parse(r.body);
      var hits = data.hits && data.hits.hits;
      if (!hits || hits.length === 0) return tryNext();

      var hit   = hits[0];
      var src   = hit._source;
      var accNo = hit._id.split(":")[0];
      return {
        cik:         accNo.split("-")[0],
        accNo:       accNo,
        accNoDashes: accNo.replace(/-/g, ""),
        period:      src.period_of_report,
        filingDate:  src.file_date,
        entityName:  src.entity_name
      };
    });
  }

  return tryNext();
}

// ── Find the document inside a filing index ───────────────────────────────
function findDocInIndex(filing) {
  var indexUrl = "https://www.sec.gov/Archives/edgar/data/" + filing.cik +
    "/" + filing.accNoDashes + "/" + filing.accNo + "-index.htm";

  return get(indexUrl).then(function(r) {
    if (r.status !== 200) throw new Error("Could not fetch filing index (HTTP " + r.status + ")");

    var matches  = r.body.match(/href="([^"]+\.htm)"/gi) || [];
    var htmFiles = [];
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i].match(/href="([^"]+\.htm)"/i);
      if (m && m[1].indexOf("index") === -1 && m[1].indexOf("http") === -1) {
        htmFiles.push(m[1]);
      }
    }

    if (htmFiles.length === 0) throw new Error("No documents found in filing index: " + indexUrl);

    var baseUrl = "https://www.sec.gov/Archives/edgar/data/" + filing.cik + "/" + filing.accNoDashes + "/";

    function tryFile(i) {
      if (i >= htmFiles.length) throw new Error("Could not load any document from filing. Index: " + indexUrl);
      var fileUrl = htmFiles[i].startsWith("/")
        ? "https://www.sec.gov" + htmFiles[i]
        : baseUrl + htmFiles[i];

      return get(fileUrl).then(function(r2) {
        if (r2.status === 200 && r2.body.length > 1000) {
          return { docUrl: fileUrl, body: r2.body, indexUrl: indexUrl };
        }
        return tryFile(i + 1);
      });
    }

    return tryFile(0);
  });
}

// ── Parse holdings HTML table ─────────────────────────────────────────────
function parseHoldings(html) {
  function strip(s) {
    return s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#160;/g, " ").replace(/&nbsp;/g, " ").replace(/&#[0-9]+;/g, "")
      .replace(/\s+/g, " ").trim();
  }

  var inThousands = /in thousands/i.test(html);
  var holdings    = [];
  var seen        = {};
  var sector      = null;
  var rows        = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (var i = 0; i < rows.length; i++) {
    var cellMatches = rows[i].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
    var cells = cellMatches.map(function(c) {
      return strip(c.replace(/<t[dh][^>]*>/i, "").replace(/<\/t[dh]>/i, ""));
    });

    if (cells.length < 2) continue;
    var full = cells.join(" ").trim();

    var sh = full.match(/^([A-Z][A-Za-z ,&\/()\-]+?)\s*[:\-]+\s*[\d.]+\s*%/);
    if (sh && !cells.some(function(c) { return /^\$?[\d]{1,3}(,\d{3})+$/.test(c.trim()); })) {
      sector = sh[1].trim(); continue;
    }

    if (/^TOTAL\b|^Grand Total|^Common Stocks|^Shares$|^Value$/i.test(full.trim())) continue;

    var valueCell = null;
    for (var j = 0; j < cells.length; j++) {
      var n = cells[j].replace(/[$,\s]/g, "");
      if (/^\d{4,}$/.test(n) && parseInt(n) > 100) { valueCell = cells[j]; break; }
    }
    if (!valueCell) continue;

    var valueNum   = parseInt(valueCell.replace(/[$,\s]/g, ""));
    var sharesCell = null;
    for (var k = 0; k < cells.length; k++) {
      var sn = cells[k].replace(/[,\s]/g, "");
      if (/^\d+$/.test(sn) && sn !== valueCell.replace(/[$,\s]/g, "") && parseInt(sn) > 0) {
        sharesCell = cells[k]; break;
      }
    }

    var nameCell = null, maxLen = 0;
    for (var m = 0; m < cells.length; m++) {
      var c2 = cells[m];
      if (c2.length > 2 && !/^[\$\d,().%\-]+$/.test(c2) && !/^TOTAL|^Shares$|^Value$|^Common Stocks/i.test(c2)) {
        if (c2.length > maxLen) { maxLen = c2.length; nameCell = c2; }
      }
    }
    if (!nameCell) continue;

    var value  = inThousands ? valueNum * 1000 : valueNum;
    var shares = sharesCell ? parseInt(sharesCell.replace(/,/g, "")) : null;
    var name   = nameCell.replace(/\s*\([a-z,\/]\)\s*/gi, "").replace(/\s+/g, " ").trim();

    if (!name || value <= 0 || seen[name]) continue;
    seen[name] = true;
    holdings.push({ name: name, sector: sector, shares: shares, value: value });
  }

  return { holdings: holdings };
}

// ── Main request handler ──────────────────────────────────────────────────
function handleSearch(req, res, query) {
  var trimmed         = query.trim();
  var looksLikeTicker = /^[A-Za-z]{1,6}$/.test(trimmed);

  var filingPromise = looksLikeTicker
    ? lookupByTicker(trimmed).then(function(result) {
        return result
          ? getLatestNportByCik(result.cik, result.name)
          : searchByName(trimmed);
      })
    : searchByName(trimmed);

  filingPromise.then(function(filing) {
    return findDocInIndex(filing).then(function(doc) {
      var holdings = parseHoldings(doc.body).holdings;

      if (holdings.length < 3) {
        return jsonResp(res, 422, {
          error:  "Only parsed " + holdings.length + " holdings. Document format may be unsupported.",
          docUrl: doc.docUrl
        });
      }

      var total = holdings.reduce(function(s, h) { return s + h.value; }, 0);
      jsonResp(res, 200, {
        query:      trimmed,
        fundName:   filing.entityName,
        period:     filing.period,
        filingDate: filing.filingDate,
        docUrl:     doc.docUrl,
        indexUrl:   doc.indexUrl,
        netAssets:  total,
        count:      holdings.length,
        holdings:   holdings.map(function(h) {
          return Object.assign({}, h, { pct: parseFloat(((h.value / total) * 100).toFixed(4)) });
        })
      });
    });
  }).catch(function(err) {
    jsonResp(res, 500, { error: err.message });
  });
}

function serveStatic(res, filePath) {
  var ext   = path.extname(filePath);
  var types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
    res.end(data);
  });
}

// ── Pre-warm the ticker cache on startup ──────────────────────────────────
// Fetch both ticker lists when the server starts so the first search is fast
setTimeout(function() {
  getMfTickers().catch(function(e) { console.log("MF ticker pre-warm failed:", e.message); });
  setTimeout(function() {
    getStockTickers().catch(function(e) { console.log("Stock ticker pre-warm failed:", e.message); });
  }, 2000);
}, 1000);

http.createServer(function(req, res) {
  var parsed   = url.parse(req.url, true);
  var pathname = parsed.pathname;
  var qs       = parsed.query;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    res.end(); return;
  }

  if (pathname === "/api/search") {
    var q = (qs.q || "").trim();
    if (!q) return jsonResp(res, 400, { error: "Missing ?q= parameter" });
    return handleSearch(req, res, q);
  }

  if (pathname === "/" || pathname === "/index.html") {
    return serveStatic(res, path.join(__dirname, "public", "index.html"));
  }

  res.writeHead(404); res.end("Not found");
}).listen(PORT, function() {
  console.log("SEC Holdings Agent running on port " + PORT);
});
