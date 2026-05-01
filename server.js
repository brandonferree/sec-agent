const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const PORT = process.env.PORT || 3000;

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

// Fetch the filing index page and find the best .htm document
function findDocInIndex(cik, accNo, accNoDashes) {
  var indexUrl = "https://www.sec.gov/Archives/edgar/data/" + cik + "/" + accNoDashes + "/" + accNo + "-index.htm";
  return get(indexUrl).then(function(r) {
    if (r.status !== 200) {
      throw new Error("Could not fetch filing index (HTTP " + r.status + "): " + indexUrl);
    }
    var html = r.body;

    // Find all .htm links in the index, excluding the index itself
    var matches = html.match(/href="([^"]+\.htm)"/gi) || [];
    var htmFiles = [];
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i].match(/href="([^"]+\.htm)"/i);
      if (m) {
        var f = m[1];
        // Exclude the index file itself and any absolute URLs
        if (f.indexOf("index") === -1 && f.indexOf("http") === -1) {
          htmFiles.push(f);
        }
      }
    }

    if (htmFiles.length === 0) {
      throw new Error("No documents found in filing index: " + indexUrl);
    }

    // Prefer files that look like the main schedule (largest, or named with common patterns)
    // Try each file until we find one that returns 200
    var baseUrl = "https://www.sec.gov/Archives/edgar/data/" + cik + "/" + accNoDashes + "/";

    function tryFile(i) {
      if (i >= htmFiles.length) {
        throw new Error("None of the filing documents could be fetched. Index: " + indexUrl);
      }
      var fileUrl = htmFiles[i].startsWith("/")
        ? "https://www.sec.gov" + htmFiles[i]
        : baseUrl + htmFiles[i];

      return get(fileUrl).then(function(r2) {
        if (r2.status === 200 && r2.body.length > 1000) {
          return { docUrl: fileUrl, body: r2.body };
        }
        return tryFile(i + 1);
      });
    }

    return tryFile(0).then(function(result) {
      return { docUrl: result.docUrl, body: result.body, indexUrl: indexUrl };
    });
  });
}

function findDocUrl(query) {
  var queries = ['"' + query + '"', query];
  var index = 0;

  function tryNext() {
    if (index >= queries.length) {
      return Promise.reject(new Error(
        'No NPORT-P filing found for "' + query + '". Try the full fund name e.g. "Fidelity Contrafund" not "FCNTX".'
      ));
    }
    var q = queries[index++];
    var searchUrl = "https://efts.sec.gov/LATEST/search-index?q=" + encodeURIComponent(q) +
      "&forms=NPORT-P&dateRange=custom&startdt=2023-01-01&enddt=2026-12-31";

    return get(searchUrl).then(function(r) {
      if (r.status === 403) throw new Error("SEC EDGAR returned 403. Update YOUR_EMAIL_HERE in server.js.");
      if (r.status !== 200) throw new Error("EDGAR search returned HTTP " + r.status + ": " + r.body.slice(0, 80));
      if (!r.ct.includes("json")) throw new Error("EDGAR returned unexpected response: " + r.body.slice(0, 80));

      var data = JSON.parse(r.body);
      var hits = data.hits && data.hits.hits;
      if (!hits || hits.length === 0) return tryNext();

      var hit = hits[0];
      var src = hit._source;

      // _id format: "0001234567-24-001234:filename.htm"
      var idParts = hit._id.split(":");
      var accNo = idParts[0];
      if (!accNo) throw new Error("Could not parse accession number from: " + hit._id);

      var accNoDashes = accNo.replace(/-/g, "");

      // CIK is always the first segment of the accession number
      var cik = accNo.split("-")[0];
      if (!cik || !/^\d+$/.test(cik)) {
        throw new Error("Could not extract CIK from accession number: " + accNo);
      }

      return {
        cik: cik,
        accNo: accNo,
        accNoDashes: accNoDashes,
        period: src.period_of_report,
        filingDate: src.file_date,
        entityName: src.entity_name
      };
    });
  }

  return tryNext();
}

function parseHoldings(html) {
  function strip(s) {
    return s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#160;/g, " ").replace(/&nbsp;/g, " ").replace(/&#[0-9]+;/g, "")
      .replace(/\s+/g, " ").trim();
  }

  var inThousands = /in thousands/i.test(html);
  var holdings = [];
  var seen = {};
  var sector = null;
  var rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (var i = 0; i < rows.length; i++) {
    var cellMatches = rows[i].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
    var cells = cellMatches.map(function(c) {
      return strip(c.replace(/<t[dh][^>]*>/i, "").replace(/<\/t[dh]>/i, ""));
    });

    if (cells.length < 2) continue;
    var full = cells.join(" ").trim();

    var sh = full.match(/^([A-Z][A-Za-z ,&\/()\-]+?)\s*[:\-]+\s*[\d.]+\s*%/);
    if (sh && !cells.some(function(c) { return /^\$?[\d]{1,3}(,\d{3})+$/.test(c.trim()); })) {
      sector = sh[1].trim();
      continue;
    }

    if (/^TOTAL\b|^Grand Total|^Common Stocks|^Shares$|^Value$/i.test(full.trim())) continue;

    var valueCell = null;
    for (var j = 0; j < cells.length; j++) {
      var n = cells[j].replace(/[$,\s]/g, "");
      if (/^\d{4,}$/.test(n) && parseInt(n) > 100) { valueCell = cells[j]; break; }
    }
    if (!valueCell) continue;

    var valueNum = parseInt(valueCell.replace(/[$,\s]/g, ""));

    var sharesCell = null;
    for (var k = 0; k < cells.length; k++) {
      var sn = cells[k].replace(/[,\s]/g, "");
      if (/^\d+$/.test(sn) && sn !== valueCell.replace(/[$,\s]/g, "") && parseInt(sn) > 0) {
        sharesCell = cells[k]; break;
      }
    }

    var nameCell = null;
    var maxLen = 0;
    for (var m = 0; m < cells.length; m++) {
      var c2 = cells[m];
      if (c2.length > 2 && !/^[\$\d,().%\-]+$/.test(c2) && !/^TOTAL|^Shares$|^Value$|^Common Stocks/i.test(c2)) {
        if (c2.length > maxLen) { maxLen = c2.length; nameCell = c2; }
      }
    }
    if (!nameCell) continue;

    var value = inThousands ? valueNum * 1000 : valueNum;
    var shares = sharesCell ? parseInt(sharesCell.replace(/,/g, "")) : null;
    var name = nameCell.replace(/\s*\([a-z,\/]\)\s*/gi, "").replace(/\s+/g, " ").trim();

    if (!name || value <= 0 || seen[name]) continue;
    seen[name] = true;
    holdings.push({ name: name, sector: sector, shares: shares, value: value });
  }

  return { holdings: holdings };
}

function handleSearch(req, res, query) {
  findDocUrl(query).then(function(filing) {
    // Fetch index page to find the correct document
    return findDocInIndex(filing.cik, filing.accNo, filing.accNoDashes).then(function(doc) {
      var result = parseHoldings(doc.body);
      var holdings = result.holdings;

      if (holdings.length < 3) {
        return jsonResp(res, 422, {
          error: "Only parsed " + holdings.length + " holdings. Document may be in an unsupported format.",
          docUrl: doc.docUrl
        });
      }

      var total = holdings.reduce(function(s, h) { return s + h.value; }, 0);
      jsonResp(res, 200, {
        query: query,
        fundName: filing.entityName,
        period: filing.period,
        filingDate: filing.filingDate,
        docUrl: doc.docUrl,
        indexUrl: doc.indexUrl,
        netAssets: total,
        count: holdings.length,
        holdings: holdings.map(function(h) {
          return Object.assign({}, h, { pct: parseFloat(((h.value / total) * 100).toFixed(4)) });
        })
      });
    });
  }).catch(function(err) {
    jsonResp(res, 500, { error: err.message });
  });
}

function serveStatic(res, filePath) {
  var ext = path.extname(filePath);
  var types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
  var type = types[ext] || "text/plain";
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;
  var qs = parsed.query;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }

  if (pathname === "/api/search") {
    var q = (qs.q || "").trim();
    if (!q) return jsonResp(res, 400, { error: "Missing ?q= parameter" });
    return handleSearch(req, res, q);
  }

  if (pathname === "/" || pathname === "/index.html") {
    return serveStatic(res, path.join(__dirname, "public", "index.html"));
  }

  res.writeHead(404);
  res.end("Not found");
}).listen(PORT, function() {
  console.log("SEC Holdings Agent running on port " + PORT);
});
