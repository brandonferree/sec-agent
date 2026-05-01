const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const PORT = process.env.PORT || 3000;

// ── In-memory cache for ticker lists ─────────────────────────────────────
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

// ── Fetch and cache ticker lists ──────────────────────────────────────────
function getMfTickers() {
  if (tickerCache.mf) return Promise.resolve(tickerCache.mf);
  console.log("Fetching mutual fund ticker list...");
  return get("https://www.sec.gov/files/company_tickers_mf.json").then(function(r) {
    if (r.status === 429) throw new Error("SEC rate limit. Please wait a moment and try again.");
    if (r.status !== 200) throw new Error("Could not fetch mutual fund ticker list (HTTP " + r.status + ")");
    var data = JSON.parse(r.body);
    // Format: { fields: ["cik","seriesId","classId","symbol"], data: [[cik,seriesId,classId,symbol],...] }
    tickerCache.mf = data.data || [];
    console.log("Cached " + tickerCache.mf.length + " mutual fund tickers.");
    return tickerCache.mf;
  });
}

function getStockTickers() {
  if (tickerCache.stocks) return Promise.resolve(tickerCache.stocks);
  console.log("Fetching stock ticker list...");
  return get("https://www.sec.gov/files/company_tickers.json").then(function(r) {
    if (r.status === 429) throw new Error("SEC rate limit. Please wait a moment and try again.");
    if (r.status !== 200) return [];
    var data = JSON.parse(r.body);
    tickerCache.stocks = Object.values(data);
    console.log("Cached " + tickerCache.stocks.length + " stock tickers.");
    return tickerCache.stocks;
  });
}

// ── Ticker → CIK + Series ID ──────────────────────────────────────────────
// Returns { cik, seriesId, classId, ticker, name }
// seriesId (e.g. "S000005726") is the key — it uniquely identifies one fund
// within a trust that may contain many funds
function lookupByTicker(ticker) {
  var upper = ticker.toUpperCase().trim();

  return getMfTickers().then(function(rows) {
    // row = [cik, seriesId, classId, symbol]
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][3] && rows[i][3].toUpperCase() === upper) {
        return {
          cik:      String(rows[i][0]).padStart(10, "0"),
          seriesId: rows[i][1], // e.g. "S000005726"
          classId:  rows[i][2], // e.g. "C000015507"
          ticker:   upper,
          name:     upper
        };
      }
    }
    return null;
  }).then(function(result) {
    if (result) return result;
    // Fallback: stock/ETF tickers (no series ID for these)
    return getStockTickers().then(function(entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].ticker && entries[i].ticker.toUpperCase() === upper) {
          return {
            cik:      String(entries[i].cik_str).padStart(10, "0"),
            seriesId: null,
            ticker:   upper,
            name:     entries[i].title
          };
        }
      }
      return null;
    });
  });
}

// ── Find NPORT-P filing by Series ID (most precise) ───────────────────────
// This ensures we get the document for THIS specific fund, not the whole trust
function findFilingBySeriesId(seriesId, cik) {
  // Search EDGAR full-text for NPORT-P filings filtered by this series ID
  var searchUrl = "https://efts.sec.gov/LATEST/search-index?q=" +
    encodeURIComponent('"' + seriesId + '"') +
    "&forms=NPORT-P&dateRange=custom&startdt=2024-01-01&enddt=2026-12-31";

  return get(searchUrl).then(function(r) {
    if (r.status !== 200) throw new Error("EDGAR series search returned HTTP " + r.status);
    var data = JSON.parse(r.body);
    var hits = data.hits && data.hits.hits;
    if (!hits || hits.length === 0) {
      // Fall back to submissions API without series filter
      return findFilingByCik(cik, null);
    }

    // Pick the most recent hit
    var hit   = hits[0];
    var src   = hit._source;
    var accNo = hit._id.split(":")[0];

    return {
      cik:         accNo.split("-")[0],
      accNo:       accNo,
      accNoDashes: accNo.replace(/-/g, ""),
      period:      src.period_of_report,
      filingDate:  src.file_date,
      entityName:  src.entity_name,
      seriesId:    seriesId
    };
  });
}

// ── Find NPORT-P filing by CIK (submissions API) ──────────────────────────
function findFilingByCik(cik, name) {
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
          entityName:  name || data.name,
          seriesId:    null
        };
      }
    }
    throw new Error("No NPORT-P filing found. This fund may not file NPORT-P with the SEC.");
  });
}

// ── Fund name → EDGAR full-text search ───────────────────────────────────
function searchByName(query) {
  var queries = ['"' + query + '"', query];
  var index   = 0;

  function tryNext() {
    if (index >= queries.length) {
      return Promise.reject(new Error('No NPORT-P filing found for "' + query + '". Try the full fund name.'));
    }
    var q = queries[index++];
    var searchUrl = "https://efts.sec.gov/LATEST/search-index?q=" + encodeURIComponent(q) +
      "&forms=NPORT-P&dateRange=custom&startdt=2023-01-01&enddt=2026-12-31";

    return get(searchUrl).then(function(r) {
      if (r.status === 403) throw new Error("SEC EDGAR returned 403. Update YOUR_EMAIL_HERE in server.js.");
      if (r.status === 429) throw new Error("SEC rate limit. Please wait a moment and try again.");
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
        entityName:  src.entity_name,
        seriesId:    null
      };
    });
  }

  return tryNext();
}

// ── Find the right document within a filing ───────────────────────────────
// When seriesId is known, we scan the index for a document whose content
// mentions the fund name or series ID, ensuring we pick the right one
// from a multi-fund trust filing.
function findDocInIndex(filing, fundName) {
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

    // If only one document, just return it
    if (htmFiles.length === 1) {
      var onlyUrl = htmFiles[0].startsWith("/")
        ? "https://www.sec.gov" + htmFiles[0]
        : baseUrl + htmFiles[0];
      return get(onlyUrl).then(function(r2) {
        return { docUrl: onlyUrl, body: r2.body, indexUrl: indexUrl };
      });
    }

    // Multiple documents: fetch each and find the one matching this fund
    // We look for the document whose first ~2000 chars mention the fund name or seriesId
    var seriesId = filing.seriesId || "";
    var ticker   = (filing.ticker || "").toUpperCase();

    function tryDocs(docs, i, fallback) {
      if (i >= docs.length) {
        // None matched specifically — return the first one that loaded
        if (fallback) return Promise.resolve(fallback);
        throw new Error("Could not find the specific fund document in filing. Index: " + indexUrl);
      }

      var fileUrl = docs[i].startsWith("/")
        ? "https://www.sec.gov" + docs[i]
        : baseUrl + docs[i];

      return get(fileUrl).then(function(r2) {
        if (r2.status !== 200 || r2.body.length < 500) return tryDocs(docs, i + 1, fallback);

        var preview = r2.body.slice(0, 3000).toUpperCase();

        // Check if this document's header matches our fund
        var matched = false;
        if (seriesId && preview.indexOf(seriesId.toUpperCase()) !== -1) matched = true;
        if (ticker   && preview.indexOf(ticker) !== -1)                  matched = true;
        if (fundName && preview.indexOf(fundName.toUpperCase().slice(0, 20)) !== -1) matched = true;

        var doc = { docUrl: fileUrl, body: r2.body, indexUrl: indexUrl };
        if (matched) return doc;

        // Keep first valid doc as fallback
        return tryDocs(docs, i + 1, fallback || doc);
      });
    }

    return tryDocs(htmFiles, 0, null);
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
    var name   = nameCell.replace(/\s*\([a-z,\/0-9]\)\s*/gi, "").replace(/\s+/g, " ").trim();

    if (!name || value <= 0 || seen[name]) continue;
    seen[name] = true;
    holdings.push({ name: name, sector: sector, shares: shares, value: value });
  }

  return { holdings: holdings };
}

// ── Main search handler ───────────────────────────────────────────────────
function handleSearch(req, res, query) {
  var trimmed         = query.trim();
  var looksLikeTicker = /^[A-Za-z]{1,6}$/.test(trimmed);

  var filingPromise;

  if (looksLikeTicker) {
    filingPromise = lookupByTicker(trimmed).then(function(result) {
      if (!result) return searchByName(trimmed);

      // If we have a series ID, use it to find the exact fund document
      if (result.seriesId) {
        return findFilingBySeriesId(result.seriesId, result.cik).then(function(filing) {
          filing.ticker   = trimmed;
          filing.seriesId = result.seriesId;
          return filing;
        });
      }

      // No series ID (ETF/stock fund) — use submissions API
      return findFilingByCik(result.cik, result.name).then(function(filing) {
        filing.ticker = trimmed;
        return filing;
      });
    });
  } else {
    filingPromise = searchByName(trimmed);
  }

  filingPromise.then(function(filing) {
    var fundName = filing.entityName || trimmed;
    return findDocInIndex(filing, fundName).then(function(doc) {
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
        fundName:   fundName,
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

// ── Static files ──────────────────────────────────────────────────────────
function serveStatic(res, filePath) {
  var ext   = path.extname(filePath);
  var types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
    res.end(data);
  });
}

// ── Pre-warm cache on startup ─────────────────────────────────────────────
setTimeout(function() {
  getMfTickers().catch(function(e) { console.log("MF ticker pre-warm failed:", e.message); });
  setTimeout(function() {
    getStockTickers().catch(function(e) { console.log("Stock ticker pre-warm failed:", e.message); });
  }, 3000);
}, 2000);

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
