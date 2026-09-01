const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BSCSCAN_API_KEY;
const PAYMENT_WALLET = (process.env.PAYMENT_WALLET || "").toLowerCase();

const USDT_CONTRACT =
  "0x55d398326f99059ff775485246999027b3197955";

function verifyPayment(txHash, callback) {
  if (!API_KEY) {
    return callback({ error: "BSCSCAN_API_KEY is missing" });
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return callback({ error: "Invalid TXID" });
  }

  const url =
    "https://api.etherscan.io/v2/api" +
    "?chainid=56" +
    "&module=account" +
    "&action=tokentx" +
    "&contractaddress=" + USDT_CONTRACT +
    "&address=" + PAYMENT_WALLET +
    "&page=1" +
    "&offset=100" +
    "&sort=desc" +
    "&apikey=" + encodeURIComponent(API_KEY);

  https.get(url, (res) => {
    let data = "";

    res.on("data", (chunk) => {
      data += chunk;
    });

    res.on("end", () => {
      try {
        const json = JSON.parse(data);

        if (!Array.isArray(json.result)) {
          return callback({
            error: "Invalid blockchain API response"
          });
        }

        const tx = json.result.find(
          (x) =>
            String(x.hash).toLowerCase() === txHash.toLowerCase() &&
            String(x.to).toLowerCase() === PAYMENT_WALLET &&
            String(x.contractAddress).toLowerCase() === USDT_CONTRACT
        );

        if (!tx) {
          return callback({
            verified: false,
            reason: "Payment not found"
          });
        }

        const decimals = Number(tx.tokenDecimal || 18);
        const amount =
          Number(tx.value) / Math.pow(10, decimals);

        if (amount !== 0.5) {
          return callback({
            verified: false,
            reason: "Amount is not exactly 0.50 USDT",
            amount: amount
          });
        }

        callback({
          verified: true,
          txHash: tx.hash,
          amount: amount,
          from: tx.from,
          to: tx.to,
          blockNumber: tx.blockNumber,
          confirmations: tx.confirmations
        });

      } catch (error) {
        callback({
          error: "Could not process blockchain response"
        });
      }
    });
  }).on("error", () => {
    callback({
      error: "Blockchain API connection failed"
    });
  });
}

const server = http.createServer((req, res) => {

  const parsed = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  if (parsed.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    return res.end(
      "Telegram Bot Backend is running!"
    );
  }

  if (parsed.pathname === "/verify-payment") {

    const txid = parsed.searchParams.get("txid");

    if (!txid) {
      res.writeHead(400, {
        "Content-Type": "application/json"
      });

      return res.end(JSON.stringify({
        verified: false,
        error: "TXID is required"
      }));
    }

    verifyPayment(txid, (result) => {

      res.writeHead(result.error ? 500 : 200, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify(result));
    });

    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain"
  });

  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
