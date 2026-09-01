const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;

const PAYMENT_WALLET =
  (process.env.PAYMENT_WALLET || "").toLowerCase();

const RPC_URL =
  "https://bsc-dataseed.bnbchain.org";

const USDT_CONTRACT =
  "0x55d398326f99059ff775485246999027b3197955"
    .toLowerCase();

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a8df523b3ef";


/* =========================
   RPC REQUEST
========================= */

function rpcRequest(method, params, callback) {

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: method,
    params: params
  });

  const url = new URL(RPC_URL);

  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  };

  const req = https.request(options, (res) => {

    let data = "";

    res.on("data", (chunk) => {
      data += chunk;
    });

    res.on("end", () => {

      try {

        const json = JSON.parse(data);

        if (json.error) {
          return callback({
            error: json.error.message || "RPC error"
          });
        }

        callback(null, json.result);

      } catch (e) {

        callback({
          error: "Invalid RPC response"
        });

      }

    });

  });

  req.on("error", () => {

    callback({
      error: "BSC RPC connection failed"
    });

  });

  req.write(body);
  req.end();
}


/* =========================
   VERIFY PAYMENT
========================= */

function verifyPayment(txHash, callback) {

  if (!PAYMENT_WALLET) {

    return callback({
      verified: false,
      error: "PAYMENT_WALLET is missing"
    });

  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {

    return callback({
      verified: false,
      error: "Invalid TXID"
    });

  }


  /* Get transaction */

  rpcRequest(
    "eth_getTransactionByHash",
    [txHash],
    (error, tx) => {

      if (error) {
        return callback({
          verified: false,
          error: error.error || "RPC error"
        });
      }

      if (!tx) {

        return callback({
          verified: false,
          reason: "Transaction not found"
        });

      }


      /* Must be USDT contract */

      if (
        String(tx.to || "").toLowerCase() !==
        USDT_CONTRACT
      ) {

        return callback({
          verified: false,
          reason: "Transaction is not a USDT contract transaction"
        });

      }


      /* Get receipt */

      rpcRequest(
        "eth_getTransactionReceipt",
        [txHash],
        (receiptError, receipt) => {

          if (receiptError) {

            return callback({
              verified: false,
              error:
                receiptError.error ||
                "Could not get transaction receipt"
            });

          }

          if (!receipt) {

            return callback({
              verified: false,
              reason: "Transaction is still pending"
            });

          }


          /* Transaction must succeed */

          if (
            String(receipt.status).toLowerCase() !==
            "0x1"
          ) {

            return callback({
              verified: false,
              reason: "Transaction failed"
            });

          }


          /*
            Find Transfer event
          */

          const logs =
            Array.isArray(receipt.logs)
              ? receipt.logs
              : [];

          let payment = null;


          for (const log of logs) {

            if (
              String(log.address || "")
                .toLowerCase() !==
              USDT_CONTRACT
            ) {
              continue;
            }


            if (
              !log.topics ||
              log.topics.length < 3
            ) {
              continue;
            }


            if (
              String(log.topics[0]).toLowerCase() !==
              TRANSFER_TOPIC
            ) {
              continue;
            }


            /*
              topics[1] = from
              topics[2] = to
            */

            const from =
              "0x" +
              String(log.topics[1]).slice(-40)
                .toLowerCase();

            const to =
              "0x" +
              String(log.topics[2]).slice(-40)
                .toLowerCase();


            if (
              to !== PAYMENT_WALLET
            ) {
              continue;
            }


            /*
              USDT on BSC uses 18 decimals.
              0.50 USDT =
              500000000000000000
            */

            const rawValue =
              BigInt(
                String(log.data || "0x0")
              );


            const required =
              BigInt("500000000000000000");


            if (rawValue !== required) {

              continue;

            }


            payment = {

              from: from,

              to: to,

              amount: 0.50,

              rawValue:
                rawValue.toString(),

              blockNumber:
                receipt.blockNumber

            };

            break;

          }


          if (!payment) {

            return callback({
              verified: false,
              reason:
                "Exact 0.50 USDT payment to payment wallet was not found"
            });

          }


          /*
            Payment verified
          */

          callback({

            verified: true,

            txHash: txHash,

            amount: payment.amount,

            from: payment.from,

            to: payment.to,

            blockNumber:
              payment.blockNumber

          });

        }

      );

    }

  );

}


/* =========================
   HTTP SERVER
========================= */

const server =
  http.createServer((req, res) => {

    const parsed =
      new URL(
        req.url,
        `http://${req.headers.host}`
      );


    /* HOME */

    if (parsed.pathname === "/") {

      res.writeHead(200, {
        "Content-Type":
          "text/plain"
      });

      return res.end(
        "Telegram Bot Backend is running!"
      );

    }


    /* VERIFY PAYMENT */

    if (
      parsed.pathname ===
      "/verify-payment"
    ) {

      const txid =
        parsed.searchParams.get("txid");


      if (!txid) {

        res.writeHead(400, {
          "Content-Type":
            "application/json"
        });

        return res.end(
          JSON.stringify({
            verified: false,
            error:
              "TXID is required"
          })
        );

      }


      verifyPayment(
        txid,
        (result) => {

          res.writeHead(
            result.error ? 502 : 200,
            {
              "Content-Type":
                "application/json"
            }
          );

          res.end(
            JSON.stringify(result)
          );

        }
      );

      return;

    }


    /* NOT FOUND */

    res.writeHead(404, {
      "Content-Type":
        "text/plain"
    });

    res.end("Not Found");

  });


/* =========================
   START SERVER
========================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }
);
