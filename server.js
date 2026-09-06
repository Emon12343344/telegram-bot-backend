const http = require("http");
const https = require("https");
const { ethers } = require("ethers");

const PORT = process.env.PORT || 3000;

/* =========================
   PAYMENT SETTINGS
========================= */

const PAYMENT_WALLET =
  "0x07207Bf282B4e3dc2db376F29e40bfbc7d61607B".toLowerCase();

const RPC_URL =
  "https://bsc-dataseed.bnbchain.org";

const USDT_CONTRACT =
  "0x55d398326f99059ff775485246999027b3197955".toLowerCase();

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/* =========================
   PAYOUT SETTINGS
========================= */

const PAYOUT_WALLET =
  String(process.env.PAYOUT_WALLET || "").toLowerCase();

const PAYOUT_PRIVATE_KEY =
  String(process.env.PAYOUT_PRIVATE_KEY || "");

const PAYOUT_API_SECRET =
  String(process.env.PAYOUT_API_SECRET || "");

let MIN_WITHDRAW =
  Number(process.env.MIN_WITHDRAW || 0.15);

if (!Number.isFinite(MIN_WITHDRAW) || MIN_WITHDRAW <= 0) {
  MIN_WITHDRAW = 0.15;
}

let payoutBusy = false;

/*
  Memory duplicate protection.
  Railway restart হলে এটি reset হবে।
  Production-এ payout ID database/storage-এ রাখাই ভালো।
*/
const processedPayouts = new Set();

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

  const req = https.request(
    options,
    (res) => {

      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {

        try {

          const json = JSON.parse(data);

          if (json.error) {

            return callback({
              error:
                json.error.message ||
                "RPC error"
            });

          }

          callback(null, json.result);

        } catch (e) {

          callback({
            error:
              "Invalid RPC response"
          });

        }

      });

    }
  );

  req.on("error", () => {

    callback({
      error:
        "BSC RPC connection failed"
    });

  });

  req.write(body);
  req.end();
}

/* =========================
   VERIFY PAYMENT
========================= */

function verifyPayment(txHash, callback) {

  if (
    !/^0x[a-fA-F0-9]{64}$/.test(txHash)
  ) {

    return callback({
      verified: false,
      error: "Invalid TXID"
    });

  }

  rpcRequest(
    "eth_getTransactionByHash",
    [txHash],
    (error, tx) => {

      if (error) {

        return callback({
          verified: false,
          error:
            error.error ||
            "RPC error"
        });

      }

      if (!tx) {

        return callback({
          verified: false,
          reason:
            "Transaction not found"
        });

      }

      /*
        IMPORTANT:
        User payment transaction normally goes
        TO the USDT contract.
      */

      if (
        String(tx.to || "").toLowerCase() !==
        USDT_CONTRACT
      ) {

        return callback({
          verified: false,
          reason:
            "Transaction is not a USDT contract transaction"
        });

      }

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
              reason:
                "Transaction is still pending",
              confirmations: 0
            });

          }

          /*
            Transaction success
          */

          if (
            String(receipt.status).toLowerCase() !==
            "0x1"
          ) {

            return callback({
              verified: false,
              reason:
                "Transaction failed"
            });

          }

          const logs =
            Array.isArray(receipt.logs)
              ? receipt.logs
              : [];

          let payment = null;

          /*
            Find USDT Transfer event
          */

          for (
            const log of logs
          ) {

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

            const from =
              "0x" +
              String(log.topics[1])
                .slice(-40)
                .toLowerCase();

            const to =
              "0x" +
              String(log.topics[2])
                .slice(-40)
                .toLowerCase();

            /*
              Receiver MUST be payment wallet
            */

            if (
              to !== PAYMENT_WALLET
            ) {
              continue;
            }

            let rawValue;

            try {

              rawValue =
                BigInt(
                  String(log.data || "0x0")
                );

            } catch (e) {

              continue;

            }

            /*
              BSC USDT uses 18 decimals
            */

            const amount =
              Number(rawValue) /
              Math.pow(10, 18);

            if (
              !Number.isFinite(amount) ||
              amount <= 0
            ) {
              continue;
            }

            payment = {
              from: from,
              to: to,
              amount: amount,
              rawValue: rawValue.toString(),
              blockNumber:
                receipt.blockNumber
            };

            break;
          }

          /*
            No matching USDT transfer
          */

          if (!payment) {

            return callback({
              verified: false,
              reason:
                "No BEP-20 USDT Transfer to the payment wallet was found"
            });

          }

          /*
            Get latest BSC block
            to calculate confirmations
          */

          rpcRequest(
            "eth_blockNumber",
            [],
            (blockError, latestBlock) => {

              if (blockError) {

                return callback({
                  verified: false,
                  error:
                    blockError.error ||
                    "Could not get latest BSC block"
                });

              }

              let confirmations = 0;

              try {

                const latest =
                  BigInt(latestBlock);

                const txBlock =
                  BigInt(receipt.blockNumber);

                confirmations =
                  Number(
                    latest - txBlock + 1n
                  );

              } catch (e) {

                confirmations = 0;

              }

              /*
                Require 3 confirmations
              */

              if (confirmations < 3) {

                return callback({
                  verified: false,
                  reason:
                    "Transaction confirmation কম",
                  confirmations:
                    confirmations,
                  required:
                    3,
                  txHash:
                    txHash
                });

              }

              /*
                FINAL VERIFIED RESULT
              */

              callback({

                verified: true,

                txHash:
                  txHash,

                amount:
                  payment.amount,

                rawValue:
                  payment.rawValue,

                from:
                  payment.from,

                to:
                  payment.to,

                blockNumber:
                  payment.blockNumber,

                confirmations:
                  confirmations,

                requiredConfirmations:
                  3

              });

            }
          );

        }
      );

    }
  );
}

/* =========================
   AUTOMATIC USDT PAYOUT
========================= */

async function sendPayout(
  walletAddress,
  amount,
  clientOid
) {

  if (!PAYOUT_PRIVATE_KEY) {

    throw new Error(
      "PAYOUT_PRIVATE_KEY is missing"
    );

  }

  if (!PAYOUT_WALLET) {

    throw new Error(
      "PAYOUT_WALLET is missing"
    );

  }

  if (!PAYOUT_API_SECRET) {

    throw new Error(
      "PAYOUT_API_SECRET is missing"
    );

  }

  if (
    !/^0x[a-fA-F0-9]{40}$/.test(
      walletAddress
    )
  ) {

    throw new Error(
      "Invalid payout wallet address"
    );

  }

  const payoutAmount =
    Number(amount);

  if (
    !Number.isFinite(payoutAmount) ||
    payoutAmount <= 0
  ) {

    throw new Error(
      "Invalid payout amount"
    );

  }

  if (
    payoutAmount < MIN_WITHDRAW
  ) {

    throw new Error(
      "Minimum payout is " +
      MIN_WITHDRAW +
      " USDT"
    );

  }

  if (
    !clientOid ||
    String(clientOid).length < 5
  ) {

    throw new Error(
      "Invalid clientOid"
    );

  }

  const provider =
    new ethers.JsonRpcProvider(
      RPC_URL,
      56
    );

  const signer =
    new ethers.Wallet(
      PAYOUT_PRIVATE_KEY,
      provider
    );

  const signerAddress =
    (
      await signer.getAddress()
    ).toLowerCase();

  /*
    Make sure private key belongs
    to configured payout wallet
  */

  if (
    signerAddress !==
    PAYOUT_WALLET
  ) {

    throw new Error(
      "PAYOUT_PRIVATE_KEY does not match PAYOUT_WALLET"
    );

  }

  const usdtAbi = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address account) view returns (uint256)"
  ];

  const usdt =
    new ethers.Contract(
      USDT_CONTRACT,
      usdtAbi,
      signer
    );

  const rawAmount =
    ethers.parseUnits(
      payoutAmount.toFixed(6),
      18
    );

  const usdtBalance =
    await usdt.balanceOf(
      signerAddress
    );

  if (
    usdtBalance < rawAmount
  ) {

    throw new Error(
      "Payout wallet has insufficient USDT balance"
    );

  }

  const tx =
    await usdt.transfer(
      walletAddress,
      rawAmount
    );

  const receipt =
    await tx.wait();

  if (
    !receipt ||
    receipt.status !== 1
  ) {

    throw new Error(
      "Payout transaction failed"
    );

  }

  return {

    success:
      true,

    txHash:
      tx.hash,

    clientOid:
      String(clientOid),

    from:
      signerAddress,

    to:
      walletAddress,

    amount:
      payoutAmount,

    network:
      "BEP-20 / BSC"

  };
}

/* =========================
   READ REQUEST BODY
========================= */

function readBody(req) {

  return new Promise(
    (resolve, reject) => {

      let body = "";

      req.on(
        "data",
        (chunk) => {

          body += chunk;

          if (
            body.length > 10000
          ) {

            reject(
              new Error(
                "Request body too large"
              )
            );

            req.destroy();

          }

        }
      );

      req.on(
        "end",
        () => {

          try {

            resolve(
              body
                ? JSON.parse(body)
                : {}
            );

          } catch (e) {

            reject(
              new Error(
                "Invalid JSON"
              )
            );

          }

        }
      );

      req.on(
        "error",
        reject
      );

    }
  );

}

/* =========================
   HTTP SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {

      const parsed =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      /* =========================
         HOME
      ========================= */

      if (
        req.method === "GET" &&
        parsed.pathname === "/"
      ) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/plain"
          }
        );

        return res.end(
          "Telegram Bot Backend is running!"
        );

      }

      /* =========================
         VERIFY PAYMENT
      ========================= */

      if (
        req.method === "GET" &&
        parsed.pathname ===
        "/verify-payment"
      ) {

        const txid =
          parsed.searchParams.get(
            "txid"
          );

        if (!txid) {

          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              verified:
                false,
              error:
                "TXID is required"
            })
          );

        }

        verifyPayment(
          txid,
          (result) => {

            res.writeHead(
              result.error
                ? 502
                : 200,
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

      /* =========================
         PAYOUT
      ========================= */

      if (
        req.method === "POST" &&
        parsed.pathname === "/payout"
      ) {

        const providedSecret =
          String(
            req.headers[
              "x-api-secret"
            ] || ""
          );

        if (
          !PAYOUT_API_SECRET ||
          providedSecret !==
          PAYOUT_API_SECRET
        ) {

          res.writeHead(
            401,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success:
                false,
              error:
                "Unauthorized"
            })
          );

        }

        if (payoutBusy) {

          res.writeHead(
            429,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success:
                false,
              error:
                "Another payout is currently processing"
            })
          );

        }

        try {

          const body =
            await readBody(req);

          const wallet =
            String(
              body.wallet || ""
            ).trim();

          const amount =
            Number(
              body.amount
            );

          const clientOid =
            String(
              body.clientOid || ""
            ).trim();

          if (!clientOid) {

            throw new Error(
              "clientOid is required"
            );

          }

          if (
            processedPayouts.has(
              clientOid
            )
          ) {

            res.writeHead(
              409,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                success:
                  false,
                error:
                  "This payout was already processed"
              })
            );

          }

          payoutBusy = true;

          console.log(
            "Payout requested:",
            {
              wallet:
                wallet,
              amount:
                amount,
              clientOid:
                clientOid,
              minimum:
                MIN_WITHDRAW
            }
          );

          const result =
            await sendPayout(
              wallet,
              amount,
              clientOid
            );

          processedPayouts.add(
            clientOid
          );

          console.log(
            "Payout sent:",
            result
          );

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          res.end(
            JSON.stringify(result)
          );

        } catch (error) {

          console.error(
            "Payout error:",
            error.message
          );

          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
            }
          );

          res.end(
            JSON.stringify({
              success:
                false,
              error:
                error.message ||
                "Payout failed"
            })
          );

        } finally {

          payoutBusy = false;

        }

        return;

      }

      /* =========================
         NOT FOUND
      ========================= */

      res.writeHead(
        404,
        {
          "Content-Type":
            "text/plain"
        }
      );

      res.end(
        "Not Found"
      );

    }
  );

/* =========================
   START SERVER
========================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================="
    );

    console.log(
      "Telegram Bot Backend Started"
    );

    console.log(
      "================================="
    );

    console.log(
      "Server running on port",
      PORT
    );

    console.log(
      "Payment wallet:",
      PAYMENT_WALLET
    );

    console.log(
      "USDT contract:",
      USDT_CONTRACT
    );

    console.log(
      "Payout wallet:",
      PAYOUT_WALLET
    );

    console.log(
      "Minimum withdraw:",
      MIN_WITHDRAW,
      "USDT"
    );

  }
);
